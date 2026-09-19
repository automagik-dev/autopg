/**
 * `autopg ui [--port N] [--host H] [--no-open]` (also reachable via `pgserve ui`).
 *
 * Boots a tiny http server bound to 127.0.0.1 that:
 *   - serves the static console from `console/dist/` (see resolveConsoleRoot
 *     for the repo vs release-tarball lookup).
 *   - exposes 4 helper endpoints used by the SPA:
 *       GET  /api/settings   → { settings, sources, etag }
 *       PUT  /api/settings   → writeSettings + If-Match etag check
 *       POST /api/restart    → invokes cli-restart.dispatch
 *       GET  /api/status     → shells out to the existing wave-1 status
 *
 * Single-user dev tool: 127.0.0.1 only, no auth, no TLS. Designed to ride
 * inside an operator's localhost session — not to be exposed.
 *
 * Port selection:
 *   --port N      → bind exactly N or fail.
 *   (no flag)     → walk 8433..8533 picking the first free port.
 *
 * Browser opening:
 *   --no-open     → skip browser launch (CI/headless paths).
 *   default       → `open` (macOS) / `xdg-open` (Linux) / `start` (Windows).
 *
 * `--help` / `-h` prints usage + the resolved console root and exits 0
 * without binding a port.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const { loadEffectiveConfig, getSettingsPath } = require('./settings-loader.cjs');
const { writeSettings } = require('./settings-writer.cjs');
const cliRestart = require('./cli-restart.cjs');

// `pg` is a devDependency today — graceful degradation if not installed.
// /api/stats returns { ok: false, reason: 'pg-not-installed' } in that case.
let PgClient = null;
try { PgClient = require('pg').Client; } catch { /* optional */ }
const {
  ValidationError,
  EtagMismatchError,
  ERROR_CODES,
} = require('./settings-validator.cjs');

const PORT_RANGE_START = 8433;
const PORT_RANGE_END = 8533;
const HOST = '127.0.0.1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function parseArgs(args) {
  const out = { port: null, noOpen: false, host: HOST };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      const v = args[++i];
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`invalid --port "${v}"`);
      }
      out.port = n;
    } else if (a === '--no-open') {
      out.noOpen = true;
    } else if (a === '--host') {
      const v = args[++i];
      out.host = v;
      // Loud warning on non-loopback. The console has no auth, no TLS —
      // exposing it on the LAN means any host on the network reads your
      // settings file. Accepted (operator opted in) but flagged.
      if (v !== '127.0.0.1' && v !== 'localhost') {
        process.stderr.write(
          `autopg ui: WARNING binding to ${v} (not loopback) — console has no auth, anyone reaching this address can read settings\n`,
        );
      }
    }
  }
  return out;
}

/**
 * Try to bind a server on each candidate port until one succeeds.
 * Returns a Promise<{server, port}>. Rejects if no port in the range works.
 */
function listenWithFallback(server, host, preferredPort) {
  const candidates = preferredPort
    ? [preferredPort]
    : (() => {
        const list = [];
        for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) list.push(p);
        return list;
      })();

  return new Promise((resolve, reject) => {
    let i = 0;
    function attempt() {
      if (i >= candidates.length) {
        reject(
          new Error(
            preferredPort
              ? `port ${preferredPort} is not available`
              : `no free port in ${PORT_RANGE_START}-${PORT_RANGE_END}`,
          ),
        );
        return;
      }
      const port = candidates[i++];
      const onErr = (err) => {
        if (err.code === 'EADDRINUSE' && !preferredPort) {
          server.removeListener('error', onErr);
          attempt();
          return;
        }
        reject(err);
      };
      server.once('error', onErr);
      server.listen(port, host, () => {
        server.removeListener('error', onErr);
        resolve({ server, port });
      });
    }
    attempt();
  });
}

/**
 * True when running inside the release binary (`bin/autopg-cli.js` compiled
 * with `bun build --compile`). Bun keeps the bundled sources on a virtual
 * filesystem and puts that path in argv[1] (`/$bunfs/root/<entry>` on
 * POSIX, `B:\~BUN\root\<entry>` on Windows). `__dirname` cannot tell us:
 * the bundler inlines it as the BUILD machine's absolute source dir, so
 * inside a tarball install `path.resolve(__dirname, '..', 'console')`
 * points at the CI runner's checkout — which is exactly why v3.2.0 printed
 * "console assets not found" (issue #161). The execPath basename is a
 * second, independent marker: the tarball binary is always `autopg`
 * (install.sh symlinks to it; process.execPath is the resolved target).
 */
function isCompiledBinary({ argv = process.argv, execPath = process.execPath } = {}) {
  const entry = argv[1] || '';
  if (entry.startsWith('/$bunfs/') || entry.includes('~BUN')) return true;
  return path.basename(execPath) === 'autopg';
}

/**
 * Resolve the static document root.
 *
 *   release tarball  → console/dist/ next to the executable
 *                      (`autopg/autopg` + `autopg/console/dist/`, staged by
 *                      scripts/assemble-tarball.sh)
 *   repo / npm       → console/ at the package root (alongside `bin/` and
 *                      `src/`; the npm `files` allowlist keeps the layout)
 *
 * `argv` / `execPath` are injectable for tests only.
 */
function resolveConsoleRoot({ argv = process.argv, execPath = process.execPath } = {}) {
  // After autopg-console-dist (v2.2.2): the SPA ships pre-bundled in
  // console/dist/ instead of as flat .jsx files at console/. Prefer dist/;
  // fall back to console/src/ for repo-checkout dev mode (where dist/ is
  // gitignored and only built on demand).
  const candidates = [];
  if (isCompiledBinary({ argv, execPath })) {
    candidates.push(path.join(path.dirname(execPath), 'console', 'dist'));
  }
  const consoleParent = path.resolve(__dirname, '..', 'console');
  candidates.push(path.join(consoleParent, 'dist'));
  for (const distRoot of candidates) {
    if (fs.existsSync(path.join(distRoot, 'index.html'))) return distRoot;
  }

  const srcRoot = path.join(consoleParent, 'src');
  if (fs.existsSync(srcRoot)) {
    process.stderr.write(
      'autopg ui: running unbuilt sources from console/src/ — run `bun run console:build` for production behavior\n',
    );
    return srcRoot;
  }

  throw new Error(
    `console assets not found: expected index.html under ${candidates.join(' or ')} `
      + '(run `bun run console:build`) or console/src/ (repo checkout)',
  );
}

/**
 * Sanitize a request path against directory traversal, return the absolute
 * file path on disk or null if the request escapes the document root.
 */
function safeJoin(root, urlPath) {
  // Strip query string defensively even though the caller already removed it.
  const clean = urlPath.split('?')[0];
  // Normalize then refuse anything starting with `..` or absolute outside
  // the root.
  const decoded = decodeURIComponent(clean);
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  const candidate = path.resolve(root, normalized);
  if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root) {
    return null;
  }
  return candidate;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { code, message, ...extra } });
}

function readBody(req, { limitBytes = 1_048_576 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ─── handlers ────────────────────────────────────────────────────────────

function handleGetSettings(req, res) {
  try {
    const { settings, sources, etag, path: settingsPath } = loadEffectiveConfig();
    sendJson(res, 200, { settings, sources, etag, path: settingsPath });
  } catch (err) {
    sendError(res, 500, 'LOAD_FAILED', err.message ?? String(err));
  }
}

async function handlePutSettings(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'BAD_BODY', err.message ?? 'invalid JSON');
    return;
  }
  const ifMatch = req.headers['if-match'];
  if (!ifMatch) {
    sendError(res, 428, 'PRECONDITION_REQUIRED', 'If-Match header required');
    return;
  }
  try {
    // Merge the patch onto the current effective tree before writing so
    // partial PUTs only touch the supplied keys. The writer re-validates.
    const { settings: current } = loadEffectiveConfig();
    const merged = deepMergePlain(current, body);
    const { etag } = writeSettings(merged, { ifMatch });
    sendJson(res, 200, { ok: true, etag });
  } catch (err) {
    if (err instanceof EtagMismatchError) {
      sendJson(res, 409, {
        error: {
          code: ERROR_CODES.ETAG_MISMATCH,
          message: 'settings changed on disk; reload before retry',
        },
        currentEtag: err.currentEtag,
      });
      return;
    }
    if (err instanceof ValidationError) {
      sendError(res, 400, err.code, err.detail ?? err.message, { field: err.field });
      return;
    }
    sendError(res, 500, 'WRITE_FAILED', err.message ?? String(err));
  }
}

function deepMergePlain(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMergePlain(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// `cli-restart.dispatch` is async: it resolves only after the postmaster is
// ready (or the readiness wait times out), so the response must wait for it.
// `ctx.restartDispatch` is a test hook, mirroring `ctx.statusOverride`.
async function handlePostRestart(req, res, ctx = {}) {
  try {
    const restartDispatch = ctx.restartDispatch || cliRestart.dispatch;
    const code = await restartDispatch([], { scriptPath: ctx.scriptPath });
    if (code === 0) {
      sendJson(res, 200, { ok: true });
    } else {
      sendError(res, 500, 'RESTART_FAILED', `restart exited with code ${code}`);
    }
  } catch (err) {
    sendError(res, 500, 'RESTART_FAILED', err.message ?? String(err));
  }
}

/**
 * How to shell out for `status --json`. Under the npm wrapper the runtime
 * (node) runs the script; in the release binary `ctx.scriptPath` IS
 * `process.execPath` (see bin/autopg-cli.js) and takes the verb directly —
 * passing it as an argument would make the binary treat its own path as
 * the subcommand and exit with a usage dump.
 */
function statusCommand(scriptPath) {
  const args = ['status', '--json'];
  if (scriptPath && scriptPath !== process.execPath) args.unshift(scriptPath);
  return { file: process.execPath, args };
}

function handleGetStatus(req, res, ctx) {
  // The existing wave-1 `status --json` flow returns the canonical shape.
  // Shell out via the wrapper so the response mirrors what an operator
  // would see at the CLI.
  try {
    if (ctx.statusOverride) {
      sendJson(res, 200, ctx.statusOverride());
      return;
    }
    const { file, args } = statusCommand(ctx.scriptPath);
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const trimmed = out.trim();
    sendJson(res, 200, trimmed ? JSON.parse(trimmed) : {});
  } catch (err) {
    // `pgserve status` exits 1 when not installed but still prints JSON.
    // Surface the parsed payload when present; otherwise wrap the error.
    const stdout = err?.stdout ? err.stdout.toString().trim() : '';
    if (stdout) {
      try {
        sendJson(res, 200, JSON.parse(stdout));
        return;
      } catch {
        // fall through
      }
    }
    sendError(res, 500, 'STATUS_FAILED', err.message ?? String(err));
  }
}

// Cached package.json — read once at module load so we never block on disk.
const PKG_VERSION = (() => {
  try { return require('../package.json').version; } catch { return 'unknown'; }
})();

async function handleGetStats(req, res) {
  if (!PgClient) {
    sendJson(res, 200, {
      ok: false,
      reason: 'pg-not-installed',
      autopg: { version: PKG_VERSION },
    });
    return;
  }
  let client;
  try {
    const { settings } = loadEffectiveConfig();
    const server = settings.server || {};
    client = new PgClient({
      host: server.host || '127.0.0.1',
      port: server.port || 8432,
      database: 'postgres',
      user: server.pgUser || 'postgres',
      password: server.pgPassword || 'postgres',
      connectionTimeoutMillis: 1500,
      query_timeout: 1500,
    });
    client.on('error', () => {}); // never crash the helper on PG hiccup
    await client.connect();
    // Single round-trip query covering everything the footer needs.
    // pg_stat_activity gives client connections; pg_database the user-db
    // count + total size; pg_stat_database the cache + xact aggregates;
    // pg_settings for the short server_version (no parsing); and
    // pg_postmaster_start_time for uptime.
    const { rows: [row] } = await client.query(`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity
          WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()) AS connections,
        (SELECT count(*)::int FROM pg_database
          WHERE NOT datistemplate AND datname <> 'postgres') AS databases,
        (SELECT setting FROM pg_settings WHERE name = 'server_version') AS pg_version,
        EXTRACT(epoch FROM (now() - pg_postmaster_start_time()))::int AS uptime_sec,
        (SELECT round(
          100.0 * sum(blks_hit)::numeric
            / nullif(sum(blks_hit) + sum(blks_read), 0),
          2
        )::float FROM pg_stat_database) AS cache_hit_pct,
        (SELECT sum(xact_commit + xact_rollback)::bigint
          FROM pg_stat_database) AS tx_total,
        (SELECT sum(pg_database_size(datname))::bigint
          FROM pg_database WHERE NOT datistemplate) AS size_bytes
    `);
    sendJson(res, 200, {
      ok: true,
      connections: row.connections,
      databases: row.databases,
      port: server.port || 8432,
      pg: {
        version: row.pg_version,
        uptimeSec: row.uptime_sec,
        cacheHitPct: row.cache_hit_pct,
        txTotal: Number(row.tx_total ?? 0),
        sizeBytes: Number(row.size_bytes ?? 0),
      },
      autopg: { version: PKG_VERSION },
      ts: Date.now(),
    });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      reason: err.code || 'disconnected',
      message: err.message,
      autopg: { version: PKG_VERSION },
    });
  } finally {
    if (client) {
      try { await client.end(); } catch { /* already closed */ }
    }
  }
}

function handleStatic(req, res, root) {
  let url = req.url.split('?')[0];
  if (url === '/' || url === '') url = '/index.html';
  const target = safeJoin(root, url);
  if (!target) {
    sendError(res, 400, 'BAD_PATH', 'invalid path');
    return;
  }
  fs.stat(target, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      // Do not SPA-fallback concrete asset requests. If /app.js or a CSS
      // file is missing, returning index.html as text/html creates strict
      // module MIME failures in the browser and hides the real packaging bug.
      if (path.extname(url)) {
        sendError(res, 404, 'NOT_FOUND', `no file at ${url}`);
        return;
      }
      // SPA fallback: serve index.html on a miss so client routing works.
      const fallback = path.join(root, 'index.html');
      if (fs.existsSync(fallback)) {
        serveFile(res, fallback);
        return;
      }
      sendError(res, 404, 'NOT_FOUND', `no file at ${url}`);
      return;
    }
    serveFile(res, target);
  });
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 500, 'READ_FAILED', err.message);
      return;
    }
    res.writeHead(200, {
      'content-type': mime,
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/**
 * Build the request handler. `ctx.scriptPath` is the absolute path to
 * `bin/autopg-wrapper.cjs` (used for shell-outs). `ctx.consoleRoot`
 * defaults to the repo's `console/` directory.
 */
// Lazy-load the auth verifier to avoid a require cycle with cli-install.
function getAuthVerifier() {
  try {
    return require('./cli-install.cjs').verifyAdminPassword;
  } catch {
    return () => false;
  }
}

/**
 * Basic Auth gate. Returns true if the request is authorized (or auth is
 * disabled via env), false if the response has been sent (401). The handler
 * MUST stop processing when this returns false.
 */
function requireAuth(req, res) {
  // Escape hatch: AUTOPG_DISABLE_AUTH=1 only honored when bound loopback.
  // The startServer loop binds to opts.host (default 127.0.0.1); this check
  // refuses the bypass when the request's interface isn't loopback to keep
  // it useful for CI/tests but useless for accidentally-exposed UIs.
  if (process.env.AUTOPG_DISABLE_AUTH === '1') {
    const remote = req.socket?.remoteAddress || '';
    if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
      return true;
    }
  }

  const verify = getAuthVerifier();
  const header = req.headers['authorization'] || '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/.exec(header);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx >= 0) {
      // Username is ignored — single-tenant tool. Only the password matters.
      const pw = decoded.slice(colonIdx + 1);
      if (verify(pw)) return true;
    }
  }

  res.writeHead(401, {
    'www-authenticate': 'Basic realm="autopg console"',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(
    'autopg console requires authentication.\n' +
      'Username: any (e.g. "admin")\n' +
      'Password: see the value printed by `autopg install` or run `autopg auth rotate-admin-password`.\n',
  );
  return false;
}

function createHandler(ctx = {}) {
  const consoleRoot = ctx.consoleRoot || resolveConsoleRoot();
  return function handler(req, res) {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (!requireAuth(req, res)) return;

    if (url.startsWith('/api/')) {
      if (url === '/api/settings' && method === 'GET') return handleGetSettings(req, res);
      if (url === '/api/settings' && method === 'PUT') return handlePutSettings(req, res);
      if (url === '/api/restart' && method === 'POST') return handlePostRestart(req, res, ctx);
      if (url === '/api/status' && method === 'GET') return handleGetStatus(req, res, ctx);
      if (url === '/api/stats' && method === 'GET') return handleGetStats(req, res);
      sendError(res, 404, 'NOT_FOUND', `${method} ${url}`);
      return;
    }

    // Non-API → static file, GET/HEAD only.
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    handleStatic(req, res, consoleRoot);
  };
}

/**
 * Open a URL in the user's default browser. Best-effort: a failure is
 * logged and the server keeps running. Operators can always copy the
 * URL out of the boot banner.
 */
function openBrowser(url) {
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      process.stderr.write(`autopg: could not auto-open browser; visit ${url}\n`);
    });
    child.unref();
  } catch {
    process.stderr.write(`autopg: could not auto-open browser; visit ${url}\n`);
  }
}

/**
 * Boot the UI server. Resolves to `{ server, port, close }` so callers
 * (and tests) can shut it down deterministically.
 *
 * In CLI mode, callers should pass `wireSignals: true` so SIGINT/SIGTERM
 * stop the server cleanly and the process exits 0.
 */
async function startServer({ args = [], scriptPath, consoleRoot, wireSignals = false, openInBrowser = openBrowser } = {}) {
  const opts = parseArgs(args);
  const handler = createHandler({ scriptPath, consoleRoot });
  const server = http.createServer(handler);
  const { port } = await listenWithFallback(server, opts.host, opts.port);

  const url = `http://${opts.host}:${port}`;
  process.stdout.write(`autopg ui: listening on ${url}\n`);
  process.stdout.write(`autopg ui: settings file is ${getSettingsPath()}\n`);

  if (!opts.noOpen) {
    openInBrowser(url);
  }

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  if (wireSignals) {
    const stop = async (sig) => {
      process.stdout.write(`\nautopg ui: ${sig} received, shutting down\n`);
      await close();
      process.exit(0);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }

  return { server, port, url, close };
}

const UI_USAGE = `Usage: autopg ui [--port N] [--host H] [--no-open]

Serve the autopg console (Basic Auth; password printed by \`autopg install\`).

  --port N      bind exactly N (default: first free port in ${PORT_RANGE_START}-${PORT_RANGE_END})
  --host H      bind address (default: ${HOST})
  --no-open     do not launch a browser
  -h, --help    print this help and where the console assets resolve
`;

/**
 * CLI dispatch entry. Boots the server and parks until SIGINT/SIGTERM.
 * Always returns 0 — the signal handlers exit the process directly.
 *
 * `--help` prints usage plus the resolved console root without binding a
 * port, so a broken install (issue #161: tarball without console/dist/)
 * is diagnosable in one command.
 */
async function dispatch(args = [], ctx = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(UI_USAGE);
    try {
      process.stdout.write(`console root: ${ctx.consoleRoot || resolveConsoleRoot()}\n`);
    } catch (err) {
      process.stdout.write(`console root: unavailable (${err.message ?? err})\n`);
    }
    return 0;
  }
  try {
    await startServer({
      args,
      scriptPath: ctx.scriptPath,
      consoleRoot: ctx.consoleRoot,
      wireSignals: true,
    });
  } catch (err) {
    process.stderr.write(`autopg ui: ${err.message ?? err}\n`);
    return 1;
  }
  // Park forever — signal handlers terminate the process.
  return new Promise(() => {});
}

module.exports = {
  dispatch,
  startServer,
  createHandler,
  parseArgs,
  resolveConsoleRoot,
  // Test surface
  _internals: {
    listenWithFallback,
    safeJoin,
    deepMergePlain,
    handleGetSettings,
    handlePutSettings,
    handlePostRestart,
    handleGetStatus,
    openBrowser,
    isCompiledBinary,
    statusCommand,
    PORT_RANGE_START,
    PORT_RANGE_END,
  },
};
