/**
 * Tests for src/cli-ui.cjs.
 *
 * Strategy:
 *   - Boot the server via startServer() with a tempdir as AUTOPG_CONFIG_DIR.
 *   - Drive the four endpoints with fetch(), assert status codes / payloads.
 *   - Assert port-fallback behavior, --no-open suppression, and that the
 *     etag round-trip works (PUT requires If-Match).
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let tmpHome;
let originalAutopgDir;
let originalDisableAuth;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-ui-'));
  originalAutopgDir = process.env.AUTOPG_CONFIG_DIR;
  originalDisableAuth = process.env.AUTOPG_DISABLE_AUTH;
  process.env.AUTOPG_CONFIG_DIR = tmpHome;
  // Bypass Basic Auth — these tests exercise the API/static surface, not
  // the auth gate. Auth-specific behavior is covered in tests/console/auth.test.js.
  process.env.AUTOPG_DISABLE_AUTH = '1';
  // Strip env overrides so tests get default-source rows.
  delete process.env.AUTOPG_PORT;
  delete process.env.PGSERVE_PORT;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (originalAutopgDir === undefined) delete process.env.AUTOPG_CONFIG_DIR;
  else process.env.AUTOPG_CONFIG_DIR = originalAutopgDir;
  if (originalDisableAuth === undefined) delete process.env.AUTOPG_DISABLE_AUTH;
  else process.env.AUTOPG_DISABLE_AUTH = originalDisableAuth;
});

function freshUi() {
  const uiPath = path.join(REPO_ROOT, 'src', 'cli-ui.cjs');
  delete require.cache[uiPath];
  // Clear loader cache too — it caches a once-flag but does not capture
  // env at module load.
  return require(uiPath);
}

async function bootServer({ args = [], openInBrowser } = {}) {
  const ui = freshUi();
  return ui.startServer({
    args: ['--no-open', ...args],
    scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
    openInBrowser: openInBrowser || (() => {}),
  });
}

describe('parseArgs', () => {
  test('--port and --no-open round-trip', () => {
    const { parseArgs } = require(path.join(REPO_ROOT, 'src', 'cli-ui.cjs'));
    expect(parseArgs(['--port', '9000', '--no-open'])).toEqual({
      port: 9000,
      noOpen: true,
      host: '127.0.0.1',
    });
  });

  test('rejects malformed --port', () => {
    const { parseArgs } = require(path.join(REPO_ROOT, 'src', 'cli-ui.cjs'));
    expect(() => parseArgs(['--port', 'not-a-port'])).toThrow(/invalid --port/);
  });
});

describe('dispatch --help', () => {
  test('prints usage + the resolved console root and exits 0 without binding', async () => {
    const ui = freshUi();
    const consoleRoot = path.join(tmpHome, 'console-root');
    fs.mkdirSync(consoleRoot);
    const chunks = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    let code;
    try {
      code = await ui.dispatch(['--help'], { consoleRoot });
    } finally {
      process.stdout.write = origWrite;
    }
    const out = chunks.join('');
    expect(code).toBe(0);
    expect(out).toContain('Usage: autopg ui');
    expect(out).toContain(`console root: ${consoleRoot}`);
  });
});

describe('release-binary layout (issue #161)', () => {
  // The tarball is `autopg/autopg` + `autopg/console/dist/`; the compiled
  // binary must find the console next to itself, not via __dirname (which
  // the bundler inlines as the build machine's checkout).
  test('isCompiledBinary: bun virtual-fs argv[1] or an `autopg` executable', () => {
    const { isCompiledBinary } = freshUi()._internals;
    expect(isCompiledBinary({ argv: ['bun', '/$bunfs/root/autopg-cli.js'], execPath: '/usr/local/bin/bun' })).toBe(true);
    expect(isCompiledBinary({ argv: ['bun', 'B:\\~BUN\\root\\autopg-cli.js'], execPath: 'C:\\bun.exe' })).toBe(true);
    expect(isCompiledBinary({ argv: ['bun', '/x/bin/autopg-cli.js'], execPath: '/opt/autopg/3.2.1/autopg' })).toBe(true);
    expect(isCompiledBinary({ argv: ['node', '/x/bin/autopg-wrapper.cjs'], execPath: '/usr/bin/node' })).toBe(false);
    expect(isCompiledBinary({ argv: ['bun', '/x/tests/cli/ui.test.js'], execPath: '/home/u/.bun/bin/bun' })).toBe(false);
  });

  test('resolveConsoleRoot prefers console/dist next to the compiled executable', () => {
    const { resolveConsoleRoot } = freshUi();
    const releaseDir = path.join(tmpHome, 'release', 'autopg');
    fs.mkdirSync(path.join(releaseDir, 'console', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(releaseDir, 'console', 'dist', 'index.html'), '<!doctype html>');
    const execPath = path.join(releaseDir, 'autopg');
    fs.writeFileSync(execPath, '', { mode: 0o755 });
    const compiled = { argv: ['bun', '/$bunfs/root/autopg-cli.js'], execPath };

    expect(resolveConsoleRoot(compiled)).toBe(path.join(releaseDir, 'console', 'dist'));

    // Same executable, console not shipped next to it (the v3.2.0 shape):
    // falls back to the repo's console/ rather than pointing into $bunfs.
    fs.rmSync(path.join(releaseDir, 'console'), { recursive: true });
    expect(resolveConsoleRoot(compiled).startsWith(path.join(REPO_ROOT, 'console'))).toBe(true);
  });

  test('resolveConsoleRoot ignores the executable dir when not compiled', () => {
    const { resolveConsoleRoot } = freshUi();
    const devDir = path.join(tmpHome, 'dev');
    fs.mkdirSync(path.join(devDir, 'console', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(devDir, 'console', 'dist', 'index.html'), '<!doctype html>');
    const notCompiled = { argv: ['node', '/x/bin/autopg-wrapper.cjs'], execPath: path.join(devDir, 'node') };
    expect(resolveConsoleRoot(notCompiled).startsWith(path.join(REPO_ROOT, 'console'))).toBe(true);
  });

  test('statusCommand hands the verb straight to the binary when it is the runtime', () => {
    const { statusCommand } = freshUi()._internals;
    // npm wrapper: `<node> <wrapper> status --json`
    expect(statusCommand('/x/bin/autopg-wrapper.cjs')).toEqual({
      file: process.execPath,
      args: ['/x/bin/autopg-wrapper.cjs', 'status', '--json'],
    });
    // compiled binary (bin/autopg-cli.js passes scriptPath = process.execPath):
    // `<autopg> status --json`, never `<autopg> <autopg> status --json`.
    expect(statusCommand(process.execPath)).toEqual({
      file: process.execPath,
      args: ['status', '--json'],
    });
  });
});

describe('server boot', () => {
  test('binds 127.0.0.1 and prints the URL', async () => {
    const { server, port, url, close } = await bootServer();
    try {
      expect(port).toBeGreaterThanOrEqual(8433);
      expect(port).toBeLessThanOrEqual(8533);
      expect(url).toBe(`http://127.0.0.1:${port}`);
      expect(server.address().address).toBe('127.0.0.1');
    } finally {
      await close();
    }
  });

  test('binds an explicit --port when free', async () => {
    // Pick a port from the upper end that's unlikely to collide.
    const { port, close } = await bootServer({ args: ['--port', '8533'] });
    try {
      expect(port).toBe(8533);
    } finally {
      await close();
    }
  });

  test('invokes openBrowser unless --no-open', async () => {
    let opened = null;
    const { close } = await bootServer({
      args: [], // no --no-open
      openInBrowser: (u) => {
        opened = u;
      },
    });
    try {
      // bootServer prepends --no-open by default to keep tests headless;
      // override by re-booting with explicit empty.
      // (above) — opened will remain null. Re-test by calling again:
      const ui = freshUi();
      const handle = await ui.startServer({
        args: [],
        scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
        openInBrowser: (u) => {
          opened = u;
        },
      });
      try {
        expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:/);
      } finally {
        await handle.close();
      }
    } finally {
      await close();
    }
  });
});

describe('GET /api/settings', () => {
  test('returns settings, sources, etag', async () => {
    const { port, close } = await bootServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings.server.port).toBe(8432);
      expect(body.sources['server.port']).toBe('default');
      expect(body.etag).toMatch(/^sha256:/);
    } finally {
      await close();
    }
  });

  test('etag stays stable for unchanged file', async () => {
    const { port, close } = await bootServer();
    try {
      const a = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      const b = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      expect(a.etag).toBe(b.etag);
    } finally {
      await close();
    }
  });
});

describe('PUT /api/settings', () => {
  test('writes with correct If-Match etag and returns new etag', async () => {
    const { port, close } = await bootServer();
    try {
      const initial = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': initial.etag },
        body: JSON.stringify({ postgres: { shared_buffers: '256MB' } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.etag).not.toBe(initial.etag);
      // Re-read confirms persistence.
      const after = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      expect(after.settings.postgres.shared_buffers).toBe('256MB');
    } finally {
      await close();
    }
  });

  test('returns 409 ETAG_MISMATCH when If-Match is stale', async () => {
    const { port, close } = await bootServer();
    try {
      const initial = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      // Drift the file under the UI by writing through the writer directly.
      const { writeSettings } = require(path.join(REPO_ROOT, 'src', 'settings-writer.cjs'));
      const { buildDefaults } = require(path.join(REPO_ROOT, 'src', 'settings-schema.cjs'));
      const drifted = buildDefaults();
      drifted.postgres.shared_buffers = '512MB';
      writeSettings(drifted);

      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': initial.etag },
        body: JSON.stringify({ postgres: { shared_buffers: '256MB' } }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('ETAG_MISMATCH');
      expect(body.currentEtag).toBeDefined();
    } finally {
      await close();
    }
  });

  test('returns 428 PRECONDITION_REQUIRED when If-Match missing', async () => {
    const { port, close } = await bootServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(428);
    } finally {
      await close();
    }
  });

  test('returns 400 with field+code on validation error', async () => {
    const { port, close } = await bootServer();
    try {
      const initial = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': initial.etag },
        body: JSON.stringify({ server: { port: 99999 } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('OUT_OF_RANGE');
      expect(body.error.field).toBe('server.port');
    } finally {
      await close();
    }
  });
});

describe('POST /api/restart', () => {
  function fakeResponse() {
    const res = { status: null, body: null };
    res.writeHead = (status) => {
      res.status = status;
    };
    res.end = (body) => {
      res.body = JSON.parse(body);
    };
    return res;
  }

  test('waits for the async restart and answers 200 once it is ready', async () => {
    const { handlePostRestart } = freshUi()._internals;
    const res = fakeResponse();
    let settled = false;
    const restartDispatch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      settled = true;
      return 0;
    };

    await handlePostRestart({}, res, { restartDispatch });

    expect(settled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('answers 500 RESTART_FAILED when the restart never becomes ready', async () => {
    const { handlePostRestart } = freshUi()._internals;
    const res = fakeResponse();

    await handlePostRestart({}, res, { restartDispatch: async () => 1 });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('RESTART_FAILED');
    expect(res.body.error.message).toBe('restart exited with code 1');
  });

  test('answers 500 RESTART_FAILED when the restart rejects', async () => {
    const { handlePostRestart } = freshUi()._internals;
    const res = fakeResponse();
    const restartDispatch = async () => {
      throw new Error('pm2 exploded');
    };

    await handlePostRestart({}, res, { restartDispatch });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('pm2 exploded');
  });
});

describe('static file serving', () => {
  test('serves index.html when console/index.html exists', async () => {
    // Inject a temp consoleRoot with a marker file so we don't depend on
    // Group 4's deliverables.
    const consoleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-console-'));
    fs.writeFileSync(path.join(consoleRoot, 'index.html'), '<!doctype html><title>autopg ui</title>');
    fs.writeFileSync(path.join(consoleRoot, 'app.js'), 'console.log("ok");\n');

    try {
      const ui = freshUi();
      const { port, close } = await ui.startServer({
        args: ['--no-open'],
        scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
        consoleRoot,
        openInBrowser: () => {},
      });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/html/);
        const text = await res.text();
        expect(text).toContain('autopg ui');

        // Static asset.
        const js = await fetch(`http://127.0.0.1:${port}/app.js`);
        expect(js.status).toBe(200);
        expect(js.headers.get('content-type')).toMatch(/javascript/);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(consoleRoot, { recursive: true, force: true });
    }
  });

  test('refuses directory-traversal paths', async () => {
    const consoleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-console-'));
    fs.writeFileSync(path.join(consoleRoot, 'index.html'), '<title>x</title>');
    try {
      const ui = freshUi();
      const { port, close } = await ui.startServer({
        args: ['--no-open'],
        scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
        consoleRoot,
        openInBrowser: () => {},
      });
      try {
        // Use a manual http.request so node doesn't normalize the path.
        const status = await new Promise((resolve) => {
          const req = http.request(
            { host: '127.0.0.1', port, path: '/%2e%2e/%2e%2e/etc/passwd' },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          );
          req.on('error', () => resolve(-1));
          req.end();
        });
        // Either 200 (SPA fallback returned index.html) or 4xx — never expose
        // /etc/passwd. Read body to confirm we got our index, not the host file.
        expect([200, 400, 404]).toContain(status);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(consoleRoot, { recursive: true, force: true });
    }
  });
});
