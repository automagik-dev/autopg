import { describe, expect, test } from 'bun:test';

import { createBoundedTail, drainStream } from '../../src/lib/drain-stream.js';

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

describe('createBoundedTail', () => {
  test('keeps everything while under the limit', () => {
    const tail = createBoundedTail(16);
    tail.append('FATAL: ');
    tail.append('boom');
    expect(tail.toString()).toBe('FATAL: boom');
  });

  test('never grows past the limit and keeps the most recent output', () => {
    const tail = createBoundedTail(10);
    for (let i = 0; i < 10_000; i += 1) tail.append(`statement ${i};`);
    expect(tail.toString().length).toBe(10);
    expect(tail.toString().endsWith('9999;')).toBe(true);
  });
});

describe('drainStream', () => {
  test('hands every chunk to onChunk and resolves when the stream ends', async () => {
    const seen = [];
    await drainStream(streamOf(['a', 'b', 'c']), { onChunk: (text) => seen.push(text) });
    expect(seen.join('')).toBe('abc');
  });

  test('keeps draining when onChunk throws, and reports each failure', async () => {
    const seen = [];
    const errors = [];
    await drainStream(streamOf(['one', 'two', 'three', 'four']), {
      onChunk: (text) => {
        seen.push(text);
        if (text === 'two' || text === 'three') throw new RangeError('Invalid string length');
      },
      onError: (error, phase) => errors.push(`${phase}:${error.message}`),
    });
    expect(seen).toEqual(['one', 'two', 'three', 'four']);
    expect(errors).toEqual(['chunk:Invalid string length', 'chunk:Invalid string length']);
  });

  test('a throwing onError cannot stop the drain either', async () => {
    const seen = [];
    await drainStream(streamOf(['x', 'y', 'z']), {
      onChunk: (text) => {
        seen.push(text);
        throw new Error('handler failed');
      },
      onError: () => {
        throw new Error('logger failed too');
      },
    });
    expect(seen).toEqual(['x', 'y', 'z']);
  });

  test('a broken stream is reported as a read failure instead of being swallowed', async () => {
    const errors = [];
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new Error('EPIPE'));
      },
    });
    await drainStream(broken, { onChunk: () => {}, onError: (error, phase) => errors.push(`${phase}:${error.message}`) });
    expect(errors).toEqual(['read:EPIPE']);
  });

  test('decodes a multi-byte character split across two chunks', async () => {
    const bytes = new TextEncoder().encode('ação');
    const seen = [];
    await drainStream(streamOf([bytes.slice(0, 2), bytes.slice(2)]), { onChunk: (text) => seen.push(text) });
    expect(seen.join('')).toBe('ação');
  });
});

// The production failure (#149): postgres writes to a pipe the wrapper reads,
// and the wrapper's read loop died on its first error. Under Bun a stream that
// JavaScript stops reading is still pulled from the pipe into native memory
// without bound, so the wrapper's RSS grows with everything postgres logs
// (~1.5 GB in the report) until allocation fails, the native reader stalls,
// the pipe fills and every backend blocks in write(). Two things therefore
// have to hold: every byte flows through JavaScript (so nothing accumulates
// natively), and the JavaScript side keeps only a bounded tail of it.
describe('a real child process writing far more than a pipe holds', () => {
  function writeToStderr(bytes) {
    return Bun.spawn(['sh', '-c', `head -c ${bytes} /dev/zero | tr "\\0" x >&2`], { stdout: 'ignore', stderr: 'pipe' });
  }

  function exitedWithin(proc, ms) {
    return Promise.race([
      proc.exited.then((code) => ({ exited: true, code })),
      new Promise((resolve) => setTimeout(() => resolve({ exited: false }), ms)),
    ]);
  }

  test('every byte is consumed even when every chunk handler call throws', async () => {
    const proc = writeToStderr(3_000_000);
    let received = 0;
    let failures = 0;
    const drained = drainStream(proc.stderr, {
      onChunk: (text) => {
        received += text.length;
        throw new RangeError('Invalid string length');
      },
      onError: () => {
        failures += 1;
      },
    });

    const outcome = await exitedWithin(proc, 10_000);
    if (!outcome.exited) proc.kill();
    await drained;

    expect(outcome).toEqual({ exited: true, code: 0 });
    expect(received).toBe(3_000_000);
    expect(failures).toBeGreaterThan(0);
  }, 15_000);

  test('control: the old loop, which stopped reading after one error, buffers the whole output in memory', async () => {
    const BYTES = 200_000_000;
    const rssBefore = process.memoryUsage().rss;
    const proc = writeToStderr(BYTES);
    const reader = proc.stderr.getReader();
    let received = 0;
    // Pre-fix shape: one try/catch around the whole loop, so the first throw ends it.
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          throw new RangeError('Invalid string length');
        }
      } catch {
        // Stream closed
      }
    })();

    const outcome = await exitedWithin(proc, 10_000);
    const rssGrowth = process.memoryUsage().rss - rssBefore;
    proc.kill();
    reader.cancel().catch(() => {});

    expect(outcome.exited).toBe(true);
    expect(received).toBeLessThan(1_000_000);          // JavaScript saw almost nothing …
    expect(rssGrowth).toBeGreaterThan(BYTES / 2);      // … yet the process is holding the output.
  }, 15_000);

  test('drainStream keeps memory flat for the same volume', async () => {
    const BYTES = 200_000_000;
    const rssBefore = process.memoryUsage().rss;
    const proc = writeToStderr(BYTES);
    const tail = createBoundedTail(64 * 1024);
    let received = 0;
    const drained = drainStream(proc.stderr, {
      onChunk: (text) => {
        received += text.length;
        tail.append(text);
      },
    });

    const outcome = await exitedWithin(proc, 10_000);
    await drained;
    const rssGrowth = process.memoryUsage().rss - rssBefore;
    if (!outcome.exited) proc.kill();

    expect(outcome.exited).toBe(true);
    expect(received).toBe(BYTES);
    expect(tail.toString().length).toBe(64 * 1024);
    expect(rssGrowth).toBeLessThan(BYTES / 4);
  }, 15_000);
});
