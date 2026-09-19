/**
 * Draining a child process's piped stdout/stderr for as long as it lives.
 *
 * A piped stream that nobody reads fills up, and the child then blocks inside
 * its next `write()`. For postgres that is fatal: every backend logs to
 * stderr, so once the wrapper stops reading, every backend — including brand
 * new connections — parks in the kernel and the whole database hangs while
 * both processes look alive (issue #149).
 *
 * So the one rule here: nothing a consumer does with a chunk may stop the
 * read loop. Only the stream ending does.
 */

/**
 * Rolling tail of the most recent output, capped at `limit` characters.
 * Output is kept for diagnostics only (startup failures, crash reports), and
 * those only ever need the end of it — an unbounded buffer on a server that
 * logs every statement grows until allocation fails.
 *
 * @param {number} limit
 */
export function createBoundedTail(limit) {
  let text = '';
  return {
    append(chunk) {
      text += chunk;
      if (text.length > limit) text = text.slice(-limit);
    },
    toString() {
      return text;
    },
  };
}

/**
 * Read `stream` until it ends, handing each decoded chunk to `onChunk`.
 *
 * An exception from `onChunk` is reported through `onError` and the loop
 * keeps reading. Only a failing `read()` — the stream itself breaking —
 * ends the loop early, and that is reported too rather than swallowed.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{
 *   onChunk: (text: string) => void,
 *   onError?: (error: unknown, phase: 'chunk' | 'read') => void,
 * }} handlers
 * @returns {Promise<void>} resolves when the stream is exhausted or broken
 */
export async function drainStream(stream, { onChunk, onError = () => {} }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const report = (error, phase) => {
    try {
      onError(error, phase);
    } catch {
      // A broken error handler must not stop the drain either.
    }
  };

  while (true) {
    let result;
    try {
      result = await reader.read();
    } catch (error) {
      report(error, 'read');
      return;
    }
    if (result.done) return;
    try {
      onChunk(decoder.decode(result.value, { stream: true }));
    } catch (error) {
      report(error, 'chunk');
    }
  }
}
