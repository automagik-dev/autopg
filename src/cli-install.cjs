/**
 * pgserve install / uninstall / status / url / port subcommands.
 *
 * Wave 1 of the canonical-pgserve-pm2-supervision wish (PR #55, issue #56).
 *
 * These subcommands let pgserve own its pm2 lifecycle. Other services that
 * need a Postgres connection (omni, genie, future) shell out to:
 *
 *     pgserve install        # idempotent, registers under pm2
 *     pgserve url            # postgres://localhost:8432/postgres
 *
 * instead of spinning up their own embedded pgserve. End-state: a single
 * shared pgserve under pm2 with hardened defaults, consumed by everyone.
 *
 * This module intentionally lives outside `bin/postgres-server.js` because
 * none of these subcommands need bun (or a running PG backend) — they are
 * filesystem + pm2 wrappers. Keeping them here means `pgserve install`
 * works even when bun isn't healthy yet (the wrapper's bun-probe would
 * otherwise block the install path).
 */

'use strict';

const { spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  PM2_PROCESS_NAME,
  evaluateServiceState,
  formatServiceState,
  waitForServiceReadiness,
} = require('./lib/service-state.cjs');

// pgserve v2.6.1 — `pgserve install --help` should print usage + exit 0,
// not run the install (B2 HIGH from QA-RECIPE-B2.md). Single source of
// truth for the help text so the autopg + pgserve bin invocations show
// the same surface (Decision #7 of finalize wish).
const INSTALL_USAGE = `Usage:
  pgserve install [options]
  autopg install [options]

Register pgserve under pm2 (Tier A supervisor) with hardened defaults.

Options:
  --port <N>            TCP port for postgres (default: 5432)
  --data <path>         Data directory (default: ~/.autopg/data)
  --socket-dir <path>   Unix socket directory (default: $XDG_RUNTIME_DIR/pgserve)
  --ui-port <N>         Port for the autopg UI process (default: 8433)
  --ui-host <host>      Bind host for the UI (default: 127.0.0.1)
  --no-ui               Skip the autopg-ui pm2 process (headless / CI)
  --no-pm2              Skip pm2 registration entirely (Tier B / external supervisor)
  --help, -h            Show this help and exit

Idempotent: re-running with the same args is a no-op when the existing
admin.json + pm2 state already matches.

See \`pgserve --help\` for the full verb list.
`;

function printInstallUsage(stream = process.stdout) {
  stream.write(INSTALL_USAGE);
}

// pgserve v2.6.1 — `pgserve install` on a host where the chosen port is
// already in use must fail BEFORE pm2 / admin.json / data-dir side
// effects (B3 HIGH from QA-RECIPE-B3.md). Pre-flight bind-test on the
// canonical loopback the postmaster will use; on EADDRINUSE we fail
// fast with an operator-readable hint pointing at `--port`.
//
// Synchronous wrapper around net.createServer().listen() — uses
// child_process.spawnSync via a self-bind-then-close so the install
// flow stays synchronous. Returns null on success; throws an Error
// with `code='EADDRINUSE'` on collision.
async function assertPortAvailable(port, host = '127.0.0.1') {
  // Test-only escape hatch. Production never sets this env var. Used by
  // tests that assert on `port: 5432` literal output where the host
  // running the test happens to have 5432 bound (dev workstations
  // running a real pgserve). The port-pre-flight contract itself is
  // covered end-to-end by the B3-collision test which intentionally
  // does NOT set this env var so the pre-flight fires.
  if (process.env.PGSERVE_TEST_SKIP_PORT_PREFLIGHT === '1') return null;

  // Layer 1: connect-probe BOTH IPv4 (127.0.0.1) and IPv6 (::1).
  // Postgres binds both loopback families on startup; any listener on
  // either is an EADDRINUSE for the postmaster. A pure listen()-bind
  // probe can miss this when the conflicting service was started with
  // SO_REUSEADDR or only-one-family, so connect() is the primary check.
  // If connect() succeeds → something is listening → port is busy.
  for (const probeHost of [host, '::1']) {
    const busy = await probePortListening(port, probeHost);
    if (busy) {
      const e = new Error(
        `pgserve install: port ${port} is already in use on ${probeHost} (something is listening).\n` +
        `Specify a different port with \`pgserve install --port <free>\`,\n` +
        `or stop the process bound to ${port} first and retry.`,
      );
      e.code = 'EADDRINUSE';
      throw e;
    }
  }

  // Layer 2: bind-probe to confirm we ourselves can bind without
  // SO_REUSEADDR conflicts. Catches the case where another process
  // bound the same port with SO_REUSEADDR but isn't currently listening
  // (rare but possible for transitional services).
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const e = new Error(
          `pgserve install: port ${port} is already in use on ${host} (EADDRINUSE).\n` +
          `Specify a different port with \`pgserve install --port <free>\`,\n` +
          `or stop the process bound to ${port} first and retry.`,
        );
        e.code = 'EADDRINUSE';
        reject(e);
        return;
      }
      // Non-EADDRINUSE errors (e.g. EACCES on privileged ports) — fail
      // closed with the underlying message; no install side effects yet.
      reject(err);
    });
    server.once('listening', () => {
      server.close(() => resolve(null));
    });
    server.listen(port, host);
  });
}

// Promise that resolves true when something is accepting connections at
// host:port (port is busy), false on ECONNREFUSED (port is free), and
// rejects on any other error so callers can fail closed.
function probePortListening(port, host, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* best-effort */ }
      if (err) reject(err); else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false)); // treat slow/no-response as free
    socket.once('error', (err) => {
      if (err.code === 'ECONNREFUSED') return finish(false);
      if (err.code === 'EHOSTUNREACH' || err.code === 'EADDRNOTAVAIL') return finish(false); // IPv6 not configured, etc.
      finish(false, err);
    });
    socket.connect(port, host);
  });
}

// pgserve singleton (v2.4): the cohort-shared admin-json + socket-dir
// helpers live in `src/lib/*.js` as ESM modules (project convention: new
// modules ship as .js / ESM). cli-install.cjs runs under node — which
// cannot synchronously `require()` ESM — so we cache the dynamic-import
// promise once at module load and await it from async install paths.
const _adminJsonModuleP = import('./lib/admin-json.js');
const _socketDirModuleP = import('./lib/socket-dir.js');
const _runtimeJsonModuleP = import('./lib/runtime-json.js');
const _blockedVersionsModuleP = import('./security/blocked-versions.js');

async function loadCohortModules() {
  const [adminJson, socketDirMod, runtimeJson, blockedVersions] = await Promise.all([
    _adminJsonModuleP,
    _socketDirModuleP,
    _runtimeJsonModuleP,
    _blockedVersionsModuleP,
  ]);
  return { adminJson, socketDirMod, runtimeJson, blockedVersions };
}

// pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 5.
//
// Resolves the running pgserve version from package.json so `assertNotBlocked`
// can compare against the compile-time BLOCKED_VERSIONS list before any
// install/update mutation. We intentionally use the package.json shipped
// with this binary (`require.resolve` from inside cli-install.cjs) rather
// than the version on the host filesystem — we want to refuse THIS binary
// running, not a different binary that might happen to live next door.
function getCurrentVersion() {
  try {
    return require('../package.json').version;
  } catch (_e) {
    return undefined;
  }
}

// pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 1.
//
// The pm2 entry name moves from `pgserve` to `autopg-server` so the canonical
// two-process layout matches the cohort design (`autopg-server` + `autopg-ui`).
// Tier B operators install a systemd-user unit that ALSO claims the
// `autopg-server` lifecycle role — `~/.autopg/admin.json` records which
// supervisor owns the host and `pgserve install` refuses to register pm2 over
// an existing Tier B record.
//
// Default postgres port moves from 8432 (the old bun-proxy listener) to 5432
// (the postgres standard, since the postmaster now binds TCP directly).
// Legacy entry name (pre-v2.4). Self-healing migration in Group 6 will
// `pm2 delete pgserve` after registering `autopg-server`; we surface the
// constant here so cleanup tooling and tests can reference it without
// hardcoding strings.
const LEGACY_PM2_PROCESS_NAME = 'pgserve';
const DEFAULT_PORT = 5432;

// Console UI is auto-supervised under pm2 alongside the daemon since v2.2.3.
// The bundled SPA (console/dist/) is served on this port; operator-facing
// only, 127.0.0.1, no auth, no TLS — matches autopg's "single-user dev tool"
// posture. Opt-out with `autopg install --no-ui` for headless/CI hosts.
const UI_PM2_PROCESS_NAME = 'autopg-ui';
const DEFAULT_UI_PORT = 8433;
const DEFAULT_UI_HOST = '127.0.0.1';
const UI_MAX_MEMORY = '256M';

// Admin password file shape (~/.autopg/admin.json, mode 0600):
//   { scheme: 'scrypt', salt: <b64>, hash: <b64>, createdAt, rotatedAt }
// Generated on first `autopg install`; rotated via `autopg auth
// rotate-admin-password`. cli-ui.cjs reads this via getAdminFilePath()
// and gates Basic Auth against it.
const ADMIN_FILE_NAME = 'admin.json';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 32 };
const ADMIN_PASSWORD_BYTES = 12; // 96 bits → ~24 hex chars; plenty for a localhost dev tool

/**
 * Hardening defaults — tuned for production-grade elasticity, NOT
 * the toy-machine values an initial draft of the wish carried.
 *
 * Earlier draft pinned `maxMemory: 1G` and `maxRestarts: 10`. The
 * operator who reviewed PR #57 caught both as dangerously small for
 * Postgres realistically:
 *   - 1G OOM-kills pgserve under modest load (shared_buffers + autovacuum
 *     workers + connection backends easily exceed 1G with a working set
 *     of any size).
 *   - 10 restart cap burns through during transient flakes (NATS reconnect
 *     loop, parent-process restart, host pressure spikes) before pm2
 *     gives up, leaving the operator with a stopped service in the
 *     morning.
 *
 * Revised defaults:
 *   - 4G memory ceiling — covers realistic load while still bounded so
 *     a runaway query can't eat the host.
 *   - 50 max restarts. Earlier drafts paired this with `--min-uptime` to
 *     only count rapid failures, but pm2 ≥ 6.0 dropped `--min-uptime` from
 *     the CLI surface (it survives only inside ecosystem files now). We
 *     keep the budget generous enough that occasional long-uptime crashes
 *     don't burn through it; if you observe restart-budget exhaustion
 *     from non-rapid crashes, raise `maxRestarts` rather than reintroducing
 *     `--min-uptime` (which would break install on pm2 6.x).
 *   - Exponential backoff on repeated failures (100ms → 60s) so we don't
 *     hammer on persistent issues.
 *   - 60s graceful shutdown window — Postgres needs time to flush WAL.
 *
 * Override at install time via env:
 *   PGSERVE_MAX_MEMORY=8G  pgserve install
 *
 * These mirror the values omni and genie will use for their own pm2
 * services. The constants are duplicated across repos (avoids a new
 * shared package) but the values are pinned in the wish.
 */
const HARDENED_DEFAULTS = {
  maxRestarts: 50,
  restartDelayMs: 4000,
  expBackoffRestartDelayMs: 100,
  // pm2 caps `--exp-backoff-restart-delay` ramp at the current backoff
  // doubling — practical max ~60s. Documented for operator clarity.
  expBackoffMaxMs: 60_000,
  maxMemory: process.env.PGSERVE_MAX_MEMORY || '4G',
  killTimeoutMs: 60_000,
  logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
};

/**
 * Resolve the config directory. AUTOPG_CONFIG_DIR (the new var) wins,
 * PGSERVE_CONFIG_DIR (the legacy var) is honored as a fall-through, and
 * `~/.autopg/` is the new default. The legacy default `~/.pgserve/` is
 * NOT consulted here — `settings-migrate.js` handles the one-shot copy.
 *
 * Soft-rename rule: AUTOPG_<X> beats PGSERVE_<X>. When only the legacy
 * env is set we still honor it but the loader emits a one-time
 * deprecation log via logger.warn (see settings-loader.js).
 */
function getConfigDir() {
  return (
    process.env.AUTOPG_CONFIG_DIR ||
    process.env.PGSERVE_CONFIG_DIR ||
    path.join(os.homedir(), '.autopg')
  );
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function getLogsDir() {
  return path.join(getConfigDir(), 'logs');
}

function getDataDir() {
  return path.join(getConfigDir(), 'data');
}

function readConfig() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// cutover G19: discovery layer used by `autopg port / url / status`.
//
// Order of precedence (most-authoritative first):
//   1. `<socketDir>/runtime.json` — written by the live postmaster at greet
//      time, removed on graceful shutdown. Carries the *current* port + pid
//      for an actually-running daemon.
//   2. `~/.autopg/admin.json` — supervisor record written at install time.
//      Survives postmaster restarts; doesn't reflect runtime state.
//   3. `~/.autopg/config.json` — legacy pre-G19 install record. Final
//      fallback so older installs that haven't been re-installed under v2.4
//      still discover cleanly.
//
// All readers swallow errors — discovery must never throw on a missing or
// truncated file. Synchronous on purpose: `dispatch()` for status/url/port
// is sync and the wrapper handles only `Promise OR number` return types.
function readRuntimeJsonSync(socketDir) {
  if (typeof socketDir !== 'string' || socketDir.length === 0) return null;
  const file = path.join(socketDir, 'runtime.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

function readAdminJsonSync() {
  const file = path.join(getConfigDir(), ADMIN_FILE_NAME);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveCanonicalSocketDir() {
  // Mirror src/lib/socket-dir.js#resolveSocketDir — pure function, no fs
  // touch. Inlined here so the sync discovery layer doesn't need a top-
  // level await on the ESM module.
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : '/tmp';
  return path.join(base, 'pgserve');
}

function isLivePid(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Compose a discovery view from runtime.json (preferred), admin.json
 * (fallback), and config.json (legacy fallback). Returns:
 *   {
 *     runtime: { socketDir, port, pid, autopgPid, schemaVersion } | null,
 *     admin:   { supervisor, socketDir, port, installedAt, ... }    | null,
 *     config:  { port, dataDir, registeredAt }                       | null,
 *     // composed view — best effort merge for callers that just want
 *     // "where do I connect right now?":
 *     socketDir: <string|null>,
 *     port:      <number|null>,
 *     liveAutopg: <boolean>     // true when runtime.json names a live pid
 *   }
 */
function readDiscovery() {
  const config = readConfig();
  const admin = readAdminJsonSync();
  // Prefer the socket dir the supervisor recorded at install time — that's
  // the path operators configured. Only fall back to the canonical resolver
  // when the install record is missing (fresh-host case).
  const socketDir = (admin && typeof admin.socketDir === 'string' && admin.socketDir.length > 0)
    ? admin.socketDir
    : resolveCanonicalSocketDir();
  const runtime = readRuntimeJsonSync(socketDir);

  // PR #80 P2 fix: previous logic treated ANY parsed runtime.json as
  // authoritative — a malformed-but-JSON file (no port, no socketDir) would
  // hide later admin.json / config fallbacks because composedPort stayed
  // null while the precedence chain stopped early. Validate that runtime
  // actually carries a usable port + socketDir before treating it as live.
  // Mirrors the admin / config branches' Number.isInteger guard.
  let composedSocketDir = null;
  let composedPort = null;
  const runtimeUsable = runtime
    && Number.isInteger(runtime.port)
    && typeof runtime.socketDir === 'string'
    && runtime.socketDir.length > 0;
  if (runtimeUsable) {
    composedSocketDir = runtime.socketDir;
    composedPort = runtime.port;
  } else if (admin && Number.isInteger(admin.port)) {
    composedSocketDir = admin.socketDir ?? socketDir;
    composedPort = admin.port;
  } else if (config && Number.isInteger(config.port)) {
    composedPort = config.port;
    composedSocketDir = socketDir;
  }

  return {
    runtime,
    admin,
    config,
    socketDir: composedSocketDir,
    port: composedPort,
    liveAutopg: !!(runtime && isLivePid(runtime.autopgPid)),
  };
}

function writeConfig(config) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = `${getConfigPath()}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, getConfigPath());
}

/**
 * Run `pm2 jlist` and return the entry for our process, or null when not
 * registered. Returns null on any failure (pm2 missing, JSON parse error,
 * etc.) — callers should treat that as "not installed" rather than crash.
 */
function pm2GetProcess(name) {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const list = JSON.parse(out);
    return list.find((p) => p && p.name === name) || null;
  } catch {
    return null;
  }
}

function pm2IsAvailable() {
  try {
    execFileSync('pm2', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective supervision config — start from HARDENED_DEFAULTS,
 * overlay any values found in `~/.autopg/settings.json` `supervision`
 * section. Failures fall through to defaults silently so `pgserve install`
 * still works on a fresh machine before `autopg config init` has run.
 *
 * Precedence: defaults < settings.json < env (env wins via loadEffectiveConfig).
 */
function getEffectiveSupervision() {
  try {
    const { loadEffectiveConfig } = require('./settings-loader.cjs');
    const { settings } = loadEffectiveConfig();
    const sup = settings?.supervision || {};
    return {
      maxRestarts: sup.maxRestarts ?? HARDENED_DEFAULTS.maxRestarts,
      minUptimeMs: sup.minUptimeMs ?? HARDENED_DEFAULTS.minUptimeMs,
      restartDelayMs: sup.restartDelayMs ?? HARDENED_DEFAULTS.restartDelayMs,
      expBackoffRestartDelayMs: sup.expBackoffRestartDelayMs ?? HARDENED_DEFAULTS.expBackoffRestartDelayMs,
      expBackoffMaxMs: sup.expBackoffMaxMs ?? HARDENED_DEFAULTS.expBackoffMaxMs,
      maxMemory: sup.maxMemory ?? HARDENED_DEFAULTS.maxMemory,
      killTimeoutMs: sup.killTimeoutMs ?? HARDENED_DEFAULTS.killTimeoutMs,
      logDateFormat: sup.logDateFormat ?? HARDENED_DEFAULTS.logDateFormat,
    };
  } catch {
    return { ...HARDENED_DEFAULTS };
  }
}

/**
 * Read the effective `runtime.enablePgvector` setting from settings.json.
 * Defaults to `false` (matches HARDENED_DEFAULTS behavior). Returns boolean.
 *
 * Precedence: defaults < settings.json < env (env wins via loadEffectiveConfig).
 *
 * This is what propagates `autopg config set runtime.enablePgvector true` into
 * the pm2-supervised postmaster's CLI args. Without this read, settings.json's
 * `enablePgvector` would be silently ignored and `--pgvector` would never reach
 * the postmaster's `parsePostmasterArgs`, so `_doEnsurePgvectorFiles` (which
 * downloads + stages vector.so on PG start when `enablePgvector` is true) would
 * never run — leaving fresh installs without the extension files. See
 * https://github.com/namastexlabs/pgserve/issues/<TBD> for the regression
 * surfaced by `@khal-os/brain` v1.61.x dogfood.
 */
function getEffectiveEnablePgvector() {
  try {
    const { loadEffectiveConfig } = require('./settings-loader.cjs');
    const { settings } = loadEffectiveConfig();
    return settings?.runtime?.enablePgvector === true;
  } catch {
    return false;
  }
}

function buildPm2StartArgs({ scriptPath, port, dataDir, socketDir }) {
  const logs = {
    out: path.join(getLogsDir(), `${PM2_PROCESS_NAME}-out.log`),
    error: path.join(getLogsDir(), `${PM2_PROCESS_NAME}-error.log`),
  };
  const supervision = getEffectiveSupervision();
  const enablePgvector = getEffectiveEnablePgvector();
  const postmasterArgs = [
    // pgserve singleton (v2.4): pm2 supervises the postmaster directly via
    // the `pgserve postmaster` subcommand — no router, no bun proxy, no
    // daemon control socket. Postgres binds the canonical Unix socket
    // under <socketDir> AND TCP <port> natively. Operators connect via
    //   psql -h $XDG_RUNTIME_DIR/pgserve     (Unix socket, no -p)
    //   psql -h 127.0.0.1 -p 5432            (canonical TCP)
    'postmaster',
    '--port',
    String(port),
    '--data',
    dataDir,
    '--socket-dir',
    socketDir,
    '--log',
    'warn',
  ];
  if (enablePgvector) postmasterArgs.push('--pgvector');
  return [
    'start',
    scriptPath,
    '--name',
    PM2_PROCESS_NAME,
    '--interpreter',
    'none',
    '--max-restarts',
    String(supervision.maxRestarts),
    // pm2 ≥ 6.0 dropped `--min-uptime` from the CLI surface — passing it
    // aborts the install. Restart budget (50) is sized to absorb a few
    // long-uptime crashes without burning through.
    '--restart-delay',
    String(supervision.restartDelayMs),
    '--exp-backoff-restart-delay',
    String(supervision.expBackoffRestartDelayMs),
    '--max-memory-restart',
    supervision.maxMemory,
    '--kill-timeout',
    String(supervision.killTimeoutMs),
    '--log-date-format',
    supervision.logDateFormat,
    '--output',
    logs.out,
    '--error',
    logs.error,
    '--',
    ...postmasterArgs,
  ];
}

function ensureLogsDir() {
  const dir = getLogsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function fail(message) {
  process.stderr.write(`pgserve: ${message}\n`);
  process.exit(1);
}

function note(message) {
  process.stderr.write(`pgserve: ${message}\n`);
}

function ok(message) {
  process.stdout.write(`pgserve: ${message}\n`);
}

/**
 * Resolve the autopg wrapper used to launch the UI under pm2. The wrapper
 * lives next to `postgres-server.js` (same `bin/` dir).
 */
function getUiBinPath(scriptPath) {
  return path.join(path.dirname(scriptPath), 'autopg-wrapper.cjs');
}

/**
 * pm2 start args for the UI process. Smaller memory cap than the daemon
 * (idle node http server, no postgres backend), shares the same restart
 * budget + exp-backoff as pgserve.
 */
function buildUiPm2StartArgs({ uiBinPath, uiPort, uiHost }) {
  const logs = {
    out: path.join(getLogsDir(), `${UI_PM2_PROCESS_NAME}-out.log`),
    error: path.join(getLogsDir(), `${UI_PM2_PROCESS_NAME}-error.log`),
  };
  const supervision = getEffectiveSupervision();
  return [
    'start',
    uiBinPath,
    '--name',
    UI_PM2_PROCESS_NAME,
    '--interpreter',
    'none',
    '--max-restarts',
    String(supervision.maxRestarts),
    '--restart-delay',
    String(supervision.restartDelayMs),
    '--exp-backoff-restart-delay',
    String(supervision.expBackoffRestartDelayMs),
    '--max-memory-restart',
    UI_MAX_MEMORY,
    '--kill-timeout',
    String(supervision.killTimeoutMs),
    '--log-date-format',
    supervision.logDateFormat,
    '--output',
    logs.out,
    '--error',
    logs.error,
    '--',
    'ui',
    '--no-open',
    '--port',
    String(uiPort),
    '--host',
    uiHost,
  ];
}

/**
 * Register `autopg-ui` under pm2. Soft-fails: if pm2 is missing, the bin
 * is missing, or the spawn fails — log a note and return 0 anyway. The
 * daemon is the load-bearing process; the UI is convenience.
 */
function cmdInstallUi(ctx, options = {}) {
  if (!pm2IsAvailable()) {
    note('pm2 not found; skipping UI install (run `autopg ui` on demand)');
    return 0;
  }

  const uiBinPath = getUiBinPath(ctx.scriptPath);
  if (!fs.existsSync(uiBinPath)) {
    note(`UI bin not found at ${uiBinPath}; skipping UI install`);
    return 0;
  }

  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;
  const uiHost = options.uiHost ?? DEFAULT_UI_HOST;
  const refresh = options.refresh === true;

  // If a UI process already exists: refresh-mode replaces it (pick up new
  // host/port/etc); idempotent-mode keeps it. Default behavior is
  // idempotent — operators who want to apply new flags pass --with-ui
  // (which sets refresh=true) so the change takes effect without a
  // separate uninstall step.
  const existing = pm2GetProcess(UI_PM2_PROCESS_NAME);
  if (existing && !refresh) {
    ok(`UI already installed (pm2 process "${UI_PM2_PROCESS_NAME}", status=${existing.pm2_env?.status ?? 'unknown'})`);
    return 0;
  }
  if (existing && refresh) {
    spawnSync('pm2', ['delete', UI_PM2_PROCESS_NAME], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  ensureLogsDir();
  const pm2Args = buildUiPm2StartArgs({ uiBinPath, uiPort, uiHost });
  const result = spawnSync('pm2', pm2Args, { stdio: 'inherit' });
  if (result.status !== 0) {
    note(`UI install failed (exit ${result.status}); daemon is unaffected. Run \`autopg ui\` manually.`);
    return 0;
  }
  ok(`UI ${refresh && existing ? 'refreshed' : 'installed'}: pm2 process "${UI_PM2_PROCESS_NAME}" on http://${uiHost}:${uiPort}`);
  return 0;
}

// `cmdUninstall` + `cmdUninstallUi` migrated to `src/commands/uninstall.js`
// as part of canonical-pgserve-pm2-supervision Group 1. The dispatch
// `case 'uninstall'` above dynamically imports the new module.

// ─── Admin password (Basic Auth for `autopg ui`) ─────────────────────────

function getAdminFilePath() {
  return path.join(getConfigDir(), ADMIN_FILE_NAME);
}

function generateAdminPassword() {
  // 12 bytes → 24 hex chars, grouped in 4-char chunks for human transcription:
  // "7f3a-92c1-8ed4-1b6c-..." (no ambiguous chars beyond hex; matches the
  // "really simple, don't reinvent" bar — operators copy-paste from a single
  // stdout line into a browser dialog).
  const raw = crypto.randomBytes(ADMIN_PASSWORD_BYTES).toString('hex');
  return raw.match(/.{1,4}/g).join('-');
}

function hashAdminPassword(password, salt) {
  // scrypt is RFC 7914 + built into Node since 10.5. No npm dep.
  return crypto.scryptSync(password, salt, SCRYPT_PARAMS.dkLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
}

function writeAdminFile({ password, rotated = false }) {
  const salt = crypto.randomBytes(32);
  const hash = hashAdminPassword(password, salt);
  const file = getAdminFilePath();
  const now = new Date().toISOString();
  // pgserve singleton (v2.4): admin.json is shared with the supervisor
  // record (`{ supervisor, socketDir, port, installedAt }`) written by
  // `src/lib/admin-json.js`. Merge with any existing fields so the scrypt
  // Basic-Auth scheme can never wipe the supervisor metadata (and vice
  // versa).
  const existing = readAdminFile() || {};
  const payload = {
    ...existing,
    scheme: 'scrypt',
    params: SCRYPT_PARAMS,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: rotated ? existing.createdAt ?? now : now,
    rotatedAt: rotated ? now : null,
  };
  ensureConfigDir();
  // Atomic write: tmp + rename. mode 0600 enforced via fchmod after write.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return payload;
}

function readAdminFile() {
  try {
    const raw = fs.readFileSync(getAdminFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function ensureConfigDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Verify a candidate password against the stored hash. Returns true on match.
 * Used by cli-ui.cjs at every Basic Auth check. Constant-time comparison
 * via crypto.timingSafeEqual.
 */
function verifyAdminPassword(candidate) {
  const stored = readAdminFile();
  if (!stored || stored.scheme !== 'scrypt') return false;
  const salt = Buffer.from(stored.salt, 'base64');
  const expected = Buffer.from(stored.hash, 'base64');
  const params = stored.params || SCRYPT_PARAMS;
  let actual;
  try {
    actual = crypto.scryptSync(candidate, salt, params.dkLen, {
      N: params.N,
      r: params.r,
      p: params.p,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function ensureAdminPassword({ rotate = false } = {}) {
  const existing = readAdminFile();
  // pgserve singleton (v2.4): admin.json may exist with only supervisor
  // fields (`{ supervisor, socketDir, port, installedAt }`) and no scrypt
  // scheme yet. Treat "no scrypt scheme" as "no password" so the install
  // path still mints one on first run.
  const hasScryptScheme = !!(existing && existing.scheme === 'scrypt');
  if (hasScryptScheme && !rotate) return null;
  const password = generateAdminPassword();
  writeAdminFile({ password, rotated: !!hasScryptScheme });
  return password;
}

function cmdAuthRotate() {
  const password = ensureAdminPassword({ rotate: true });
  if (!password) {
    fail('admin password rotation produced no new password (unexpected)');
  }
  process.stdout.write(`pgserve: admin password rotated. New password (printed ONCE):\n\n  ${password}\n\n`);
  process.stdout.write(`Saved hash to ${getAdminFilePath()} (mode 0600).\n`);
  process.stdout.write(`Existing browser sessions will be re-prompted on their next request.\n`);
  return 0;
}

function cmdAuthDispatch(args) {
  const sub = args[0];
  switch (sub) {
    case 'rotate-admin-password':
      return cmdAuthRotate();
    case 'show-admin-path':
      process.stdout.write(`${getAdminFilePath()}\n`);
      return 0;
    default:
      fail(`pgserve auth: unknown subcommand "${sub ?? ''}". Try: rotate-admin-password | show-admin-path`);
  }
}

/**
 * `pgserve install [--port N] [--data PATH] [--no-ui] [--ui-port N]`
 *
 * Idempotent. When the process is already registered, prints a reuse line
 * and exits 0 without touching anything. Otherwise: writes `~/.pgserve/
 * config.json` (creating the dir if needed), then registers the process
 * under pm2 with the hardened defaults.
 *
 * Since v2.2.3: also auto-supervises the autopg console UI under pm2 as
 * `autopg-ui` (default port 8433). Opt out via `--no-ui`. The UI is a thin
 * http server bound to 127.0.0.1 — single-user dev tool, no auth, no TLS.
 *
 * `scriptPath` is the path to `bin/postgres-server.js` resolved by the
 * wrapper before this module is required (avoids re-resolving here).
 */
async function cmdInstall(args, ctx) {
  // B2 (v2.6.1): `--help` / `-h` MUST short-circuit before any side
  // effects (no pm2 spawn, no admin.json write, no data-dir create).
  if (args.includes('--help') || args.includes('-h')) {
    printInstallUsage();
    process.exit(0);
  }

  const { adminJson, socketDirMod, blockedVersions } = await loadCohortModules();

  // pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 5.
  // Refuse to install if THIS binary's version appears in the compile-time
  // blocklist. Runs first (before any host-touching work) so the operator
  // sees a clear `EBLOCKEDVERSION:` diagnostic with the locked reason +
  // remediation hint, exit code 4 (distinct from generic install failures).
  const currentVersion = getCurrentVersion();
  if (currentVersion) {
    try {
      blockedVersions.assertNotBlocked(currentVersion);
    } catch (err) {
      if (err.code === 'EBLOCKEDVERSION') {
        process.stderr.write(`${err.message}\n`);
        process.exit(4);
      }
      throw err;
    }
  }

  // pgserve singleton (v2.4): refuse to install if a different supervisor
  // (Tier B systemd-user / launchd) already owns the host. The cohort
  // contract guarantees one and only one supervisor records itself in
  // `~/.autopg/admin.json`. `pgserve install` is the Tier A (pm2) entry —
  // it asserts that nothing else has already claimed the host before
  // touching pm2.
  const noPm2 = args.includes('--no-pm2');
  const expectedSupervisor = noPm2 ? 'external' : 'pm2';
  try {
    adminJson.assertSupervisor(expectedSupervisor, { configDir: getConfigDir() });
  } catch (err) {
    fail(err.message);
  }

  if (!noPm2 && !pm2IsAvailable()) {
    fail('pm2 not found in PATH. Install with: bun add -g pm2  (or npm i -g pm2). Pass --no-pm2 for CI / Tier B-bound hosts.');
  }

  const port = parsePort(args) ?? readConfig()?.port ?? DEFAULT_PORT;
  const noUi = args.includes('--no-ui');
  const withUi = args.includes('--with-ui');
  const redeploy = args.includes('--redeploy');
  const existingBeforeInstall = pm2GetProcess(PM2_PROCESS_NAME);

  // B3 (v2.6.1): pre-flight bind-test the chosen port BEFORE creating
  // pm2 entries / admin.json / data dir. Without this, an operator on
  // a host where 5432 is already occupied gets pm2 reporting `online`
  // while the postmaster crashes silently — divergence between
  // supervisor state and data-plane state. Fail fast with a clear hint.
  try {
    if (!withUi && !existingBeforeInstall) await assertPortAvailable(port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`${err.message}\n`);
      // CV103-2 (v2.6.2): drop the synchronous `process.exit(1)` here.
      // QA's 9-variant repro on v2.6.1 isolated a stdio-pipe race:
      // when stdout is piped (e.g. `pgserve install | cat`) but
      // stderr is inherited, `process.exit(1)` runs Node's shutdown
      // sequence faster than the libuv stderr buffer can flush, and
      // Node has been observed to terminate with exit code 0 instead
      // of 1. Node's own docs flag this:
      //
      //   process.exit() will force the process to exit as quickly as
      //   possible … including I/O operations to process.stdout and
      //   process.stderr.
      //   (https://nodejs.org/api/process.html#processexitcode_1)
      //
      // Recommended pattern: set process.exitCode and let Node exit
      // gracefully on its own once the event loop drains. We also
      // throw so the wrapper's rejection handler can suppress its
      // duplicate stderr write — see bin/autopg-wrapper.cjs.
      process.exitCode = 1;
      throw err;
    }
    throw err;
  }

  const dataDir = parseDataDir(args) ?? readConfig()?.dataDir ?? getDataDir();

  // Set up the canonical socket directory before pm2 launches the
  // postmaster. `ensureSocketDir` enforces mode 0700 and probes writability
  // so failure surfaces here — not as a libpq bind error a few seconds
  // into pm2 backoff.
  const socketDir = parseSocketDir(args) ?? socketDirMod.resolveSocketDir();
  try {
    socketDirMod.ensureSocketDir(socketDir);
  } catch (err) {
    fail(err.message);
  }

  const uiPort = parseUiPort(args) ?? DEFAULT_UI_PORT;
  const uiHost = parseUiHost(args) ?? DEFAULT_UI_HOST;

  if (noUi && withUi) {
    fail('--no-ui and --with-ui are mutually exclusive');
  }

  // --with-ui: UI-only path. Don't touch the daemon — register or refresh
  // autopg-ui only. Useful for v2.2.2 → v2.2.3 upgrades where the daemon
  // is fine and only the UI is missing, AND for changing UI host/port
  // post-install without restarting postgres.
  if (withUi) {
    cmdInstallUi(ctx, { uiPort, uiHost, refresh: true });
    return 0;
  }

  // --no-pm2: skip pm2 register entirely. Used by CI fixture provisioning
  // (no sudo, no pm2 ambient state) and by Tier B-bound hosts that will
  // immediately hand off to `autopg service install`. Still record the
  // supervisor + canonical socket dir + port in admin.json so downstream
  // tooling (pgserve doctor, omni install, genie install) can discover
  // where to connect without an active pm2 entry.
  if (noPm2) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeConfig({ port, dataDir, registeredAt: readConfig()?.registeredAt ?? new Date().toISOString() });
    writeSupervisorRecord(adminJson, { supervisor: 'external', socketDir, port });
    ok(`installed (--no-pm2): supervisor=external, socketDir=${socketDir}, port=${port}`);
    ok(`url: postgres://localhost:${port}/postgres`);
    note(`--no-pm2: pm2 register skipped. Start the postmaster manually with \`pgserve postmaster --port ${port} --data ${dataDir} --socket-dir ${socketDir}\` or hand off to systemd-user / launchd.`);
    return 0;
  }

  // --redeploy: full reset. Tear down both processes, then proceed with
  // a fresh install. Equivalent to `autopg uninstall && autopg install`
  // but in one verb.
  if (redeploy) {
    const had = pm2GetProcess(PM2_PROCESS_NAME);
    if (had) {
      spawnSync('pm2', ['delete', PM2_PROCESS_NAME], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    spawnSync('pm2', ['delete', UI_PM2_PROCESS_NAME], { stdio: ['ignore', 'pipe', 'pipe'] });
    note('--redeploy: removed any existing pm2 processes; reinstalling fresh');
  }

  // Idempotent: already-registered = no-op success. Still reconcile the UI
  // process so re-running `autopg install` after an upgrade picks up the UI
  // even on hosts where the daemon was registered pre-v2.2.3.
  const existing = redeploy ? null : pm2GetProcess(PM2_PROCESS_NAME);
  if (existing) {
    if (existing.pm2_env?.status !== 'online') {
      const startResult = spawnSync('pm2', ['start', PM2_PROCESS_NAME], { stdio: 'inherit' });
      if (startResult.status !== 0) {
        fail(`pm2 start failed (exit ${startResult.status}). Logs: ${getLogsDir()}/${PM2_PROCESS_NAME}-error.log`);
      }
    }
    // Refresh config in case install was re-run with new flags — but
    // don't tear down the live process. Operators wanting a port change
    // should `uninstall` then `install` (or pass --redeploy).
    writeConfig({ port, dataDir, registeredAt: readConfig()?.registeredAt ?? new Date().toISOString() });
    writeSupervisorRecord(adminJson, { supervisor: 'pm2', socketDir, port });
    const state = await waitForServiceReadiness();
    if (!state.ready) {
      fail(
        `pm2 process "${PM2_PROCESS_NAME}" did not become ready: ${formatServiceState(state)}. `
        + `Logs: ${getLogsDir()}/${PM2_PROCESS_NAME}-error.log`,
      );
    }
    ok(`already installed and ready (pm2 process "${PM2_PROCESS_NAME}")`);
    if (!noUi) cmdInstallUi(ctx, { uiPort, uiHost });
    return 0;
  }

  ensureLogsDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const pm2Args = buildPm2StartArgs({ scriptPath: ctx.scriptPath, port, dataDir, socketDir });
  const result = spawnSync('pm2', pm2Args, { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`pm2 start failed (exit ${result.status}). Logs: ${getLogsDir()}/${PM2_PROCESS_NAME}-error.log`);
  }

  writeConfig({ port, dataDir, registeredAt: new Date().toISOString() });
  writeSupervisorRecord(adminJson, { supervisor: 'pm2', socketDir, port });
  const state = await waitForServiceReadiness();
  if (!state.ready) {
    fail(
      `pm2 process "${PM2_PROCESS_NAME}" did not become ready: ${formatServiceState(state)}. `
      + `Logs: ${getLogsDir()}/${PM2_PROCESS_NAME}-error.log`,
    );
  }
  ok(`installed and ready: pm2 process "${PM2_PROCESS_NAME}" on port ${port} (socket: ${socketDir}, data: ${dataDir})`);
  ok(`url: postgres://localhost:${port}/postgres`);

  if (noUi) {
    note('--no-ui set; skipping console install. Run `autopg ui` on demand.');
  } else {
    // Generate admin password BEFORE starting the UI process, so the UI
    // server reads admin.json on first request without a race. Print
    // ONCE — operator must copy now or run `autopg auth rotate-admin-
    // password` to get a new one.
    const newPassword = ensureAdminPassword();
    if (newPassword) {
      process.stdout.write('\n');
      process.stdout.write(`  🔑 ADMIN PASSWORD (printed ONCE — saved hash at ${getAdminFilePath()}):\n`);
      process.stdout.write(`     ${newPassword}\n`);
      process.stdout.write('\n');
      process.stdout.write('  Browser will prompt on first access. Rotate via:\n');
      process.stdout.write('     autopg auth rotate-admin-password\n\n');
    }
    cmdInstallUi(ctx, { uiPort, uiHost, refresh: redeploy });
  }
  return 0;
}

/**
 * Persist the supervisor record into `~/.autopg/admin.json`. Wraps
 * `writeAdminJson` from the cohort-shared module so the install path can
 * pin its own ISO timestamp + log a friendly diagnostic on the
 * supervisor-lock refusal.
 */
function writeSupervisorRecord(adminJson, { supervisor, socketDir, port }) {
  try {
    adminJson.writeAdminJson(
      {
        supervisor,
        socketDir,
        port,
        installedAt: new Date().toISOString(),
      },
      { configDir: getConfigDir() },
    );
  } catch (err) {
    // The "Tier B already owns this host" error is the contract failure
    // we surface to operators. Other errors (EACCES, ENOSPC, etc.) just
    // pass through with their stock message.
    fail(err.message);
  }
}

/**
 * `pgserve status [--json]`
 *
 * Reports both pm2 state and on-disk discovery (runtime.json → admin.json
 * → config.json fallback chain). Exits 0 with status info regardless of
 * running/stopped — operators script around the JSON output. Non-zero
 * only when nothing was ever installed (no admin.json AND no config.json).
 *
 * Cutover G19: surfaces `runtime` (live socket discovery) and `socketDir`
 * top-level so consumers can pick UDS vs TCP without parsing pm2 jlist.
 */
function cmdStatus(args) {
  const json = args.includes('--json');
  const discovery = readDiscovery();
  const { config, admin, runtime } = discovery;

  if (!config && !admin) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
    } else {
      ok('not installed (run: pgserve install)');
    }
    return 1;
  }

  const proc = pm2GetProcess(PM2_PROCESS_NAME);
  const supervisor = admin?.supervisor ?? (proc ? 'pm2' : null);
  const supervisorStatus = supervisor === 'pm2'
    ? proc?.pm2_env?.status ?? 'missing'
    : supervisor;
  const pid = proc?.pid ?? null;
  const uptimeMs = proc?.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null;
  const restarts = proc?.pm2_env?.restart_time ?? 0;

  const port = discovery.port;
  const socketDir = discovery.socketDir;
  const dataDir = config?.dataDir ?? null;
  const serviceState = evaluateServiceState({
    supervisor,
    supervisorStatus,
    supervisorPid: pid,
    configuredPort: port,
    runtime,
    runtimeLive: discovery.liveAutopg,
  });

  const payload = {
    installed: true,
    name: PM2_PROCESS_NAME,
    status: serviceState.status,
    ready: serviceState.ready,
    supervisorStatus,
    pid,
    port,
    socketDir,
    dataDir,
    logsDir: getLogsDir(),
    url: port ? `postgres://localhost:${port}/postgres` : null,
    uptimeMs,
    restarts,
    registeredAt: config?.registeredAt ?? null,
    supervisor,
    runtime: runtime
      ? {
          socketDir: runtime.socketDir,
          port: runtime.port,
          pid: runtime.pid,
          autopgPid: runtime.autopgPid,
          schemaVersion: runtime.schemaVersion,
          live: discovery.liveAutopg,
        }
      : null,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`name        ${payload.name}\n`);
  process.stdout.write(`status      ${payload.status}${payload.pid ? ` (pid ${payload.pid})` : ''}\n`);
  if (payload.supervisor) {
    process.stdout.write(`supervisor  ${payload.supervisor} (${payload.supervisorStatus})\n`);
  }
  if (payload.port != null) process.stdout.write(`port        ${payload.port}\n`);
  if (payload.url) process.stdout.write(`url         ${payload.url}\n`);
  if (payload.socketDir) process.stdout.write(`socketDir   ${payload.socketDir}\n`);
  if (payload.dataDir) process.stdout.write(`dataDir     ${payload.dataDir}\n`);
  process.stdout.write(`logsDir     ${payload.logsDir}\n`);
  if (payload.runtime) {
    process.stdout.write(`runtime     pid=${payload.runtime.pid} autopgPid=${payload.runtime.autopgPid} live=${payload.runtime.live}\n`);
  } else {
    process.stdout.write(`runtime     (no runtime.json — postmaster down or never started)\n`);
  }
  if (payload.uptimeMs != null) {
    const sec = Math.floor(payload.uptimeMs / 1000);
    process.stdout.write(`uptime      ${sec}s\n`);
  }
  process.stdout.write(`restarts    ${payload.restarts}\n`);
  if (payload.registeredAt) process.stdout.write(`registered  ${payload.registeredAt}\n`);
  return 0;
}

/**
 * `pgserve url`
 *
 * Discovery API. Prints the canonical TCP connection string. Downstream
 * installers (genie install, omni install) call this to learn where to
 * connect, instead of hardcoding a port. The TCP form is stable across
 * Tier A / Tier B / fingerprint-disabled hosts; UDS callers should
 * resolve `<socketDir>/.s.PGSQL.<port>` from `autopg status --json`.
 */
function cmdUrl() {
  const discovery = readDiscovery();
  if (discovery.port == null) {
    fail('not installed (run: pgserve install)');
  }
  process.stdout.write(`postgres://localhost:${discovery.port}/postgres\n`);
  return 0;
}

/** `pgserve port` — print the canonical port from runtime.json → admin.json → config.json. */
function cmdPort() {
  const discovery = readDiscovery();
  if (discovery.port == null) {
    fail('not installed (run: pgserve install)');
  }
  process.stdout.write(`${discovery.port}\n`);
  return 0;
}

function parsePort(args) {
  const i = args.indexOf('--port');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--port requires a value');
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid --port "${v}"`);
  return n;
}

function parseDataDir(args) {
  const i = args.indexOf('--data');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--data requires a value');
  return path.resolve(v);
}

function parseSocketDir(args) {
  const i = args.indexOf('--socket-dir');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--socket-dir requires a value');
  return path.resolve(v);
}

function parseUiPort(args) {
  const i = args.indexOf('--ui-port');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--ui-port requires a value');
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid --ui-port "${v}"`);
  return n;
}

function parseUiHost(args) {
  const i = args.indexOf('--ui-host');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--ui-host requires a value');
  // Pass through verbatim. cli-ui.cjs warns on non-loopback at bind time.
  return v;
}

/**
 * One-shot migration check from `~/.pgserve/` → `~/.autopg/`. Runs once
 * per process at the top of dispatch() so every CLI entry point gets
 * the cutover. Fully best-effort: any failure is swallowed (we never
 * want migration to block an `autopg status` invocation).
 */
let _migrationChecked = false;
function ensureMigrationOnce() {
  if (_migrationChecked) return;
  _migrationChecked = true;
  try {
    const { migrateIfNeeded } = require('./settings-migrate.cjs');
    const result = migrateIfNeeded();
    if (result.migrated) {
      process.stderr.write(
        `autopg: migrated ${result.legacy} → ${result.fresh} (one-time)\n`,
      );
    }
  } catch {
    // Swallow — operator can re-run migration manually if needed.
  }
}

/**
 * Entry point invoked by the wrapper. Returns the exit code (or a Promise
 * for async subcommands such as `ui`). Throws on unknown subcommand so
 * the wrapper's normal flow can take over (the router treats any
 * non-recognized subcommand as "pass through to the postgres-server.js
 * dispatcher").
 *
 * `ctx.scriptPath` is the path to `bin/postgres-server.js` (used by
 * install for the pm2 entry point). For `restart` and `ui` we need the
 * wrapper script path instead — `ctx.wrapperPath`. The wrapper provides
 * both before calling dispatch.
 */
function dispatch(subcommand, args, ctx) {
  ensureMigrationOnce();
  switch (subcommand) {
    case 'install':
      return cmdInstall(args, ctx);
    case 'uninstall':
      // canonical-pgserve-pm2-supervision Group 1: the uninstall surface
      // moved to `src/commands/uninstall.js` so the cohort baseline (pm2
      // teardown + admin.json supervisor clear + audit-log entry) lives
      // alongside `src/lib/pm2-args.js` instead of inside this legacy
      // dispatcher. dispatch() returns a Promise here; the wrapper
      // already handles both numeric and Promise returns.
      //
      // `args` MUST be forwarded (issue #146): without it `--help` was
      // silently dropped and `autopg uninstall --help` tore down the
      // postmaster instead of printing usage.
      return import('./commands/uninstall.js').then((mod) => mod.runUninstall({ argv: args }));
    case 'doctor':
      // pgserve-singleton-no-proxy Group 3: read-only V1. Reports the
      // active supervisor + postmaster reachability + admin.json /
      // runtime.json health. --fix tiered modes deferred to a follow-up
      // (SHARED-DESIGN §3.2).
      return import('./commands/doctor.js').then((mod) => mod.runDoctor(args).then((code) => process.exit(code)));
    case 'status':
      return cmdStatus(args);
    case 'url':
      return cmdUrl();
    case 'port':
      return cmdPort();
    case 'update': {
      // v3.0.0 verb rename — `upgrade` → `update`. Clean cutover per
      // pgserve-singleton-no-proxy Group 6 + Felipe directive
      // 2026-05-10. `pgserve upgrade` is no longer a recognised verb.
      const opts = {
        quiet: args.includes('--quiet'),
        dryRun: args.includes('--dry-run'),
        skipSteps: (() => {
          const idx = args.indexOf('--skip-steps');
          if (idx === -1) return [];
          return (args[idx + 1] || '').split(',').filter(Boolean);
        })(),
      };
      return import(require('node:path').join(__dirname, 'update', 'index.js'))
        .then((mod) => mod.update(opts))
        .then((r) => process.exit(r.ok ? 0 : 1));
    }
    case 'config': {
      const cfg = require('./cli-config.cjs');
      const [sub, ...rest] = args;
      return cfg.dispatch(sub, rest);
    }
    case 'restart': {
      const restart = require('./cli-restart.cjs');
      return restart.dispatch(args, { scriptPath: ctx.wrapperPath });
    }
    case 'ui': {
      const ui = require('./cli-ui.cjs');
      return ui.dispatch(args, { scriptPath: ctx.wrapperPath });
    }
    case 'auth':
      return cmdAuthDispatch(args);
    case 'verify': {
      // pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
      // `pgserve verify` is a pure-node command (cosign shellout + HMAC
      // cache token write); routes through the same async-import pattern
      // as `uninstall` so the ESM module isn't eagerly loaded.
      return import('./commands/verify.js').then((mod) => mod.runVerify(args));
    }
    case 'trust':
      // pgserve singleton (v2.4) — wish Group 3, second read-only verb.
      // `pgserve trust add/list/remove` manages the user-extensible cosign
      // trust store at ~/.pgserve/trust/identities.json. Pure node.
      // The wrapper handles the numeric-exit-code case; matches the
      // verify dispatch style so the wrapper, not the verb, owns
      // process.exit.
      return import('./commands/trust.js').then((mod) => mod.runTrust(args));
    case 'gc':
      // pgserve singleton (v2.4) — wish Group 3, verb 3. `pgserve gc`
      // sweeps orphaned databases. Default mode is dry-run; --apply
      // performs the actual DROP. Composes the orphan classifier +
      // audit-log writer + psql shellout primitives.
      return import('./commands/gc.js').then((mod) => mod.runGc(args));
    case 'provision':
      // pgserve singleton (v2.4) — wish Group 3, verb 4. Idempotent
      // CREATE ROLE / DATABASE / GRANT + UPSERT pgserve_meta. Honest
      // idempotency-driven serialization (see provision.js header for
      // why no advisory lock). Pure node + psql shellout.
      return import('./commands/provision.js').then((mod) => mod.runProvision(args));
    case 'create-app':
      // autopg-distribution-cutover-finalize (v2.6) — wish Group 3.
      // Registers a consumer slug + writes admin.json/manifest.json,
      // freezing TRUSTED_IDENTITIES into autopg_meta.locked_roots at
      // create time. Idempotent: re-runs touch last_updated only and
      // preserve the original locked_roots snapshot (BRIEF v5 A6).
      return import('./commands/create-app.js').then((mod) => mod.runCreateApp(args));
    default:
      throw new Error(`pgserve: dispatch called with unknown subcommand "${subcommand}"`);
  }
}

module.exports = {
  // Public API for the wrapper.
  dispatch,
  // B2 + B3: surfaced so unit tests can drive helpers without the
  // full install side-effect chain.
  printInstallUsage,
  assertPortAvailable,
  INSTALL_USAGE,
  // Auth surface used by cli-ui.cjs.
  verifyAdminPassword,
  getAdminFilePath,
  readAdminFile,
  // Test surface.
  _internals: {
    HARDENED_DEFAULTS,
    PM2_PROCESS_NAME,
    DEFAULT_PORT,
    getConfigDir,
    getConfigPath,
    getLogsDir,
    getDataDir,
    readConfig,
    writeConfig,
    buildPm2StartArgs,
    getEffectiveSupervision,
    parsePort,
    parseDataDir,
    generateAdminPassword,
    hashAdminPassword,
    writeAdminFile,
    ensureAdminPassword,
  },
};
