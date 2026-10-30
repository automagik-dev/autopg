#!/usr/bin/env bun

/**
 * pgserve — Embedded PostgreSQL Server (singleton, v2.4+)
 *
 * Direct postmaster supervision. The bun proxy data plane was removed in
 * the `pgserve-singleton-no-proxy` wish (Group 2). All long-running
 * lifecycles flow through the `postmaster` subcommand: pm2 (Tier A) and
 * systemd-user / launchd (Tier B, separate wish) invoke this script with
 * `pgserve postmaster --port <n> --data <dir> --socket-dir <dir>`. There
 * is no router, no libpq protocol rewriting, no SO_PEERCRED-based
 * startup-message rewriting, and no always-on daemon control socket.
 *
 * For one-off operations (`pgserve install`, `pgserve url`, …) see
 * `bin/autopg-wrapper.cjs` + `src/cli-install.cjs`.
 */

import { PostgresManager } from '../src/postgres.js';
import { resolvePostmasterPassword } from '../src/lib/postmaster-password.js';
import { resolveSocketDir, ensureSocketDir } from '../src/lib/socket-dir.js';
import { writeRuntimeJson, clearRuntimeJson, keepRuntimeJson } from '../src/lib/runtime-json.js';
import { createLogger } from '../src/logger.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Global error handlers — surface unhandled rejections + uncaught errors
// loud so a process supervisor (pm2 / systemd-user / launchd) restarts the
// postmaster cleanly instead of leaving us silently stuck.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

const args = process.argv.slice(2);

// `autopg --version` / `-v` — MUST exit 0 with `autopg <version>`.
//
// This entry point is what `scripts/build-binary.sh` compiles via
// `bun build --compile` (the tarball's `autopg` binary IS this file),
// AND what `bin/autopg-wrapper.cjs` spawns through bun for the npm path.
// Both surfaces previously fell through to `printHelp()` + `exit(1)` —
// `tests/integration/tarball-smoke.sh` swallowed the stderr and reported
// the generic "autopg binary not executable", masking the real cause
// (no `--version` handler ever existed). See BRIEF-v3-build-fix Bug #1a.
//
// Version source: build-binary.sh injects `--define BUILD_VERSION="'<v>'"`,
// so in the compiled binary the bare `BUILD_VERSION` token is replaced with
// a string literal. `typeof` on an undeclared identifier is the one safe
// form in JS (returns 'undefined' without throwing), so the non-compiled
// wrapper path falls back to package.json cleanly.
if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`autopg ${resolveVersion()}\n`);
  process.exit(0);
}

if (args[0] === 'postmaster') {
  await runPostmasterSubcommand(args.slice(1));
} else if (args[0] === 'serve') {
  // Alias `serve` → `postmaster` for symmetry with the v2.3 alias surface.
  // Operators land on the same direct-supervision path either way.
  await runPostmasterSubcommand(args.slice(1));
} else {
  printHelp();
  process.exit(args.length === 0 || args[0] === '--help' || args[0] === 'help' ? 0 : 1);
}

/**
 * `pgserve postmaster` — supervises an embedded PostgreSQL postmaster
 * directly. No router, no bun proxy, no daemon control socket.
 *
 * The postmaster listens on the canonical Unix socket at
 * `<socketDir>/.s.PGSQL.<port>` AND TCP `<port>` (postgres' default
 * `listen_addresses = 'localhost'`). Operators connect with either:
 *
 *     psql -h $XDG_RUNTIME_DIR/pgserve         # Unix socket (no -p)
 *     psql -h 127.0.0.1 -p 5432                # canonical TCP
 */
async function runPostmasterSubcommand(postmasterArgs) {
  const opts = parsePostmasterArgs(postmasterArgs);
  const logger = createLogger({ level: opts.logLevel });

  // Managed superuser password (AUTOPG_PG_PASSWORD / PGSERVE_PG_PASSWORD,
  // default 'postgres'). PostgresManager feeds it to initdb's --pwfile on
  // fresh clusters AND to its TCP admin pool — without this wire a rotated
  // password crash-loops every postmaster restart (admin pool refused).
  // Log the SOURCE only, never the value.
  const { password, source: passwordSource } = resolvePostmasterPassword();
  if (opts.credentialFile !== undefined) {
    // --password-file: scram-only cluster (see PostgresManager credentialFile).
    // The manager opens the file once, before it creates anything.
    if (passwordSource !== 'default') {
      console.error(`pgserve postmaster: --password-file and ${passwordSource} are both set; use one`);
      process.exit(1);
    }
    logger.info({ source: 'password-file' }, 'pgserve postmaster: using managed superuser password');
  } else if (passwordSource !== 'default') {
    logger.info({ source: passwordSource }, 'pgserve postmaster: using managed superuser password');
  }

  // Resolve and ensure the socket directory before postgres tries to bind.
  // Surfaces "not writable" / "wrong owner" failures here with a clear
  // diagnostic instead of leaving the operator to chase a libpq error.
  let socketDir;
  try {
    socketDir = ensureSocketDir(opts.socketDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const manager = new PostgresManager({
    dataDir: opts.dataDir,
    port: opts.port,
    socketDir,
    useRam: opts.useRam,
    enablePgvector: opts.enablePgvector,
    password,
    credentialFile: opts.credentialFile,
    logger: logger.child({ component: 'postgres' }),
  });

  // Surface unexpected backend death so pm2 can restart us cleanly.
  // Mirrors the daemon-mode contract from PR #49 (issue #45).
  manager.on('backendDiedUnexpectedly', ({ code }) => {
    logger.error(
      { code },
      'pgserve postmaster: postgres backend exited unexpectedly; exiting so the supervisor can restart',
    );
    process.exit(1);
  });

  try {
    await manager.start();
  } catch (err) {
    logger.error({ err: err.message }, 'pgserve postmaster: failed to start');
    // start() can fail after postgres is up (the admin pool refused); stop
    // it, or it outlives us with PPID 1, holding the port and data dir.
    await manager.stop().catch((stopErr) => {
      logger.warn({ err: stopErr.message }, 'pgserve postmaster: stop after a failed start failed');
      manager.process?.kill('SIGKILL');
    });
    process.exit(1);
  }

  // cutover G19: drop a runtime discovery file at <socketDir>/runtime.json
  // so consumers' UDS-first probes find the live socket without globbing
  // ephemeral pid-stamped dirs. The file is intentionally separate from
  // ~/.autopg/admin.json (which records supervisor metadata, not live
  // socket info) — that split lets the postmaster restart under a new
  // pid without rewriting the supervisor record. NO `supervisor` key
  // here; the writer rejects it.
  const runtimeRecord = {
    socketDir,
    port: opts.port,
    pid: manager.process?.pid ?? process.pid,
    autopgPid: process.pid,
  };
  let stopKeeper = () => {};
  try {
    writeRuntimeJson(runtimeRecord);
    // Tmp cleaners delete runtime.json on an idle host while we are still up;
    // re-assert it every minute (see keepRuntimeJson).
    stopKeeper = keepRuntimeJson(runtimeRecord, {
      onRewrite: (result) => logger.warn({ result }, 'pgserve postmaster: runtime.json keeper acted (rewritten = file was missing or stale; failed = could not write)'),
    });
  } catch (err) {
    logger.warn(
      { err: err.message },
      'pgserve postmaster: runtime.json write failed; consumers will fall back to admin.json',
    );
  }

  logger.info(
    { port: opts.port, socketDir, dataDir: opts.dataDir },
    opts.credentialFile !== undefined
      ? 'pgserve postmaster: ready (TCP 127.0.0.1 only)'
      : 'pgserve postmaster: ready (Unix socket + TCP)',
  );

  const shutdown = async (signal) => {
    logger.info({ signal }, 'pgserve postmaster: stopping');
    // Clear runtime.json BEFORE stopping the postmaster so the moment
    // a graceful-shutdown signal lands, fresh consumers see "no live
    // socket" instead of racing against a stale-pid record. On crash
    // (uncaughtException, backend died) the file is left behind; the
    // operator-facing detector is `process.kill(record.autopgPid, 0)`.
    stopKeeper();
    clearRuntimeJson(socketDir);
    try {
      await manager.stop();
    } catch (err) {
      logger.warn({ err: err.message }, 'pgserve postmaster: error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Park forever; the supervisor decides when to stop us.
  await new Promise(() => {});
}

function parsePostmasterArgs(postmasterArgs) {
  const opts = {
    port: 5432,
    dataDir: null,
    socketDir: undefined, // resolved via resolveSocketDir() if unset
    logLevel: 'info',
    useRam: false,
    enablePgvector: false,
  };
  for (let i = 0; i < postmasterArgs.length; i++) {
    const arg = postmasterArgs[i];
    switch (arg) {
      case '--port':
      case '-p': {
        const raw = postmasterArgs[++i];
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          console.error(`pgserve postmaster: invalid --port "${raw}"`);
          process.exit(1);
        }
        opts.port = parsed;
        break;
      }
      case '--data':
      case '-d':
        opts.dataDir = postmasterArgs[++i];
        break;
      case '--socket-dir':
      case '-k':
        opts.socketDir = postmasterArgs[++i];
        break;
      case '--log':
      case '-l':
        opts.logLevel = postmasterArgs[++i];
        break;
      case '--ram':
        opts.useRam = true;
        break;
      case '--pgvector':
        opts.enablePgvector = true;
        break;
      case '--password-file': {
        const value = postmasterArgs[++i];
        if (value === undefined || value === '') {
          console.error('pgserve postmaster: --password-file needs a path');
          process.exit(1);
        }
        opts.credentialFile = value;
        break;
      }
      case '--help':
        process.stdout.write(`
pgserve postmaster — direct embedded PostgreSQL supervision (singleton v2.4)

USAGE:
  pgserve postmaster [options]

OPTIONS:
  --port, -p <n>        TCP port (default: 5432)
  --data, -d <path>     Data directory (required for persistence)
  --socket-dir, -k <p>  Unix socket dir (default: $XDG_RUNTIME_DIR/pgserve)
  --log, -l <level>     Log level: error|warn|info|debug (default: info)
  --ram                 Use /dev/shm (Linux only)
  --pgvector            Auto-enable pgvector on new databases
  --password-file <p>   Superuser password file (absolute path, mode 0600,
                        one line). The cluster then takes scram-sha-256
                        logins on 127.0.0.1 only, makes no Unix socket
                        and logs no statements.
  --help                Show this help

ENVIRONMENT:
  AUTOPG_PG_PASSWORD    Managed superuser password (initdb --pwfile on fresh
                        clusters + the admin pool). PGSERVE_PG_PASSWORD is
                        the legacy alias. Default: postgres.

The postmaster binds <socket-dir>/.s.PGSQL.<port> and TCP <port> on
localhost. This entry point is invoked by pm2/systemd-user/launchd; it has
no router, no bun proxy, no daemon control socket.
`);
        process.exit(0);
        // falls through (unreachable)
      default:
        if (arg.startsWith('-')) {
          console.error(`pgserve postmaster: unknown option "${arg}"`);
          process.exit(1);
        }
    }
  }
  if (opts.socketDir === undefined) opts.socketDir = resolveSocketDir();
  return opts;
}

function resolveVersion() {
  // Compiled binary: bun's `--define` already replaced BUILD_VERSION with a
  // string literal. `typeof <undeclared>` is the only reference form that
  // can't throw, so the non-compiled (wrapper/dev) path falls through here.
  if (typeof BUILD_VERSION !== 'undefined' && BUILD_VERSION) return BUILD_VERSION;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  process.stdout.write(`
pgserve — Embedded PostgreSQL Server (singleton, v2.4+)
=======================================================

True concurrent connections, zero config, auto-provision databases. The
postmaster is supervised directly (pm2 Tier A, systemd-user / launchd Tier
B); there is no bun proxy or daemon control socket.

USAGE:
  pgserve install [--port N] [--no-pm2]   # one-shot register under pm2
  pgserve uninstall                       # one-shot tear-down
  pgserve url | port | status [--json]    # discovery / health
  pgserve config <subcommand>             # ~/.autopg/settings.json
  pgserve restart                         # pm2 restart
  pgserve ui                              # autopg console UI
  pgserve postmaster [options]            # long-running supervisor entry
  pgserve serve [options]                 # alias for \`postmaster\`

For postmaster options:    pgserve postmaster --help
For install options:       pgserve install --help (-> handled by wrapper)

CONNECTING:
  postgres://localhost:5432/mydb            # canonical TCP
  psql -h $XDG_RUNTIME_DIR/pgserve mydb     # Unix socket
`);
}
