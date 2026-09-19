/**
 * `autopg uninstall` — Tier A teardown of the rootless pm2 supervisor.
 *
 * Group 1 of the canonical-pgserve-pm2-supervision wish. Idempotent.
 *
 * Removes:
 *   - pm2 entry `autopg-server` (the postmaster, registered by `autopg install`)
 *   - pm2 entry `autopg-ui`     (the console SPA, registered by `autopg install`)
 *   - the supervisor record in `~/.autopg/admin.json` (the four supervisor
 *     fields managed by `src/lib/admin-json.js` — preserves the scrypt
 *     Basic-Auth scheme so a re-install can keep the same admin password).
 *
 * Preserves:
 *   - the data directory under `~/.autopg/data/`
 *   - `~/.autopg/config.json`
 *   - `admin.json` auth fields (scheme/salt/hash/createdAt/rotatedAt/...)
 *
 * Writes one JSONL audit-log entry to `<configDir>/audit.log`.
 *
 * Idempotent contract: running uninstall twice in a row is a no-op on the
 * second call. After uninstall, a subsequent `autopg install` succeeds
 * without a Tier-B-refusal false positive — `assertSupervisor` treats a
 * missing supervisor field as "host is free to install".
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  ADMIN_FILE_MODE,
  getAdminFilePath,
  readAdminJson,
} from '../lib/admin-json.js';

export const TIER_A_PM2_PROCESSES = Object.freeze(['autopg-server', 'autopg-ui']);
export const SUPERVISOR_FIELDS = Object.freeze([
  'supervisor',
  'socketDir',
  'port',
  'installedAt',
]);

function getConfigDir() {
  return (
    process.env.AUTOPG_CONFIG_DIR
    || process.env.PGSERVE_CONFIG_DIR
    || path.join(os.homedir(), '.autopg')
  );
}

function pm2IsAvailable() {
  try {
    execFileSync('pm2', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

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

/**
 * Always-attempt pm2 delete. `pm2 delete <missing>` exits non-zero but the
 * call is idempotent server-side, so any non-zero exit is treated as
 * "already absent" rather than a hard failure. We snapshot pm2 jlist
 * BEFORE the delete to report whether the entry actually existed.
 */
function tearDownPm2(name) {
  if (!pm2IsAvailable()) {
    return { name, removed: false, status: 'pm2-missing' };
  }
  const before = pm2GetProcess(name);
  const res = spawnSync('pm2', ['delete', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (res.status === 0) {
    return {
      name,
      removed: !!before,
      status: before ? 'removed' : 'already-absent',
    };
  }
  return {
    name,
    removed: false,
    status: 'already-absent',
    exitCode: res.status,
  };
}

/**
 * Atomically clear the supervisor fields from admin.json. Preserves all
 * other fields (notably the scrypt Basic-Auth scheme written by
 * `cli-install.cjs`'s `writeAdminFile`). Removes the file entirely if
 * clearing leaves an empty object.
 *
 * Returns { changed, file, hadSupervisor }.
 */
function clearSupervisorRecord(configDir) {
  const file = getAdminFilePath(configDir);
  const existing = readAdminJson({ configDir });
  if (!existing) {
    return { changed: false, file, hadSupervisor: false };
  }
  const hadSupervisor = SUPERVISOR_FIELDS.some((k) => k in existing);
  if (!hadSupervisor) {
    return { changed: false, file, hadSupervisor: false };
  }
  const cleared = { ...existing };
  for (const field of SUPERVISOR_FIELDS) {
    delete cleared[field];
  }
  if (Object.keys(cleared).length === 0) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    return { changed: true, file, hadSupervisor: true };
  }
  const tmp = `${file}.tmp.${process.pid}`;
  const json = `${JSON.stringify(cleared, null, 2)}\n`;
  fs.writeFileSync(tmp, json, { mode: ADMIN_FILE_MODE });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, ADMIN_FILE_MODE);
  return { changed: true, file, hadSupervisor: true };
}

function appendAuditLog(configDir, payload) {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const file = path.join(configDir, 'audit.log');
  const record = {
    ts: new Date().toISOString(),
    event: 'autopg_uninstall',
    ...payload,
  };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function emit(level, msg, silent) {
  if (silent) return;
  const stream = level === 'err' ? process.stderr : process.stdout;
  stream.write(`autopg: ${msg}\n`);
}

const UNINSTALL_USAGE = `Usage: autopg uninstall [options]

Stop and remove the pm2-supervised autopg processes (autopg-server, autopg-ui)
and clear the supervisor record from ~/.autopg/admin.json.

Preserved: the data directory (~/.autopg/data), config.json, settings.json and
the admin Basic-Auth credentials — \`autopg install\` brings everything back.

Options:
  -y, --yes    Skip the confirmation prompt. Required on a non-interactive
               terminal (scripts, CI, pipes).
  -h, --help   Show this help and exit.

Examples:
  autopg uninstall          # prompts before stopping the postmaster
  autopg uninstall --yes    # non-interactive
`;

const CONFIRM_PROMPT = 'This stops autopg-server/autopg-ui under pm2 (data dir preserved). Continue? [y/N] ';

function printUninstallUsage(stream = process.stdout) {
  stream.write(UNINSTALL_USAGE);
}

/**
 * Parse `autopg uninstall` argv. Pure — exported for tests.
 *
 * @param {string[]} [argv]
 * @returns {{help: boolean, yes: boolean, unknown: string[]}}
 */
export function parseUninstallArgs(argv = []) {
  const out = { help: false, yes: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--yes' || arg === '-y') out.yes = true;
    else out.unknown.push(arg);
  }
  return out;
}

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

/**
 * Run the uninstall flow. Resolves to a numeric exit code.
 *
 * Order matters (issue #146): `--help` and argument validation return
 * BEFORE any pm2 call, and the postmaster is only stopped after an explicit
 * confirmation — an interactive `[y/N]` prompt on a TTY, or `--yes` / `-y`
 * (mandatory on a non-interactive terminal, which returns 2 otherwise).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] — the subcommand's arguments (everything
 *   after `uninstall`).
 * @param {boolean} [opts.yes] — programmatic equivalent of `--yes`.
 * @param {string} [opts.configDir] — override the autopg config dir (used
 *   by tests; production code should leave this undefined and let env vars
 *   resolve).
 * @param {boolean} [opts.silent] — suppress stdout/stderr writes.
 */
export async function runUninstall(opts = {}) {
  const configDir = opts.configDir || getConfigDir();
  const silent = opts.silent === true;
  const args = parseUninstallArgs(Array.isArray(opts.argv) ? opts.argv : []);

  if (args.help) {
    printUninstallUsage(process.stdout);
    return 0;
  }
  if (args.unknown.length > 0) {
    process.stderr.write(`autopg: uninstall: unknown option ${args.unknown.join(' ')}\n`);
    printUninstallUsage(process.stderr);
    return 2;
  }

  if (!(args.yes || opts.yes === true)) {
    if (!isInteractive()) {
      emit(
        'err',
        'uninstall stops autopg-server/autopg-ui under pm2 (data dir preserved); refusing without confirmation on a non-interactive terminal. Re-run with --yes.',
        silent,
      );
      return 2;
    }
    const confirmed = await askConfirmation(CONFIRM_PROMPT);
    if (!confirmed) {
      emit('out', 'uninstall aborted; nothing changed', silent);
      return 1;
    }
  }

  const pm2Available = pm2IsAvailable();
  if (!pm2Available) {
    emit(
      'err',
      'pm2 not found in PATH; skipping pm2 teardown (admin.json supervisor record will still be cleared).',
      silent,
    );
  }

  const pm2Results = TIER_A_PM2_PROCESSES.map((name) => tearDownPm2(name));

  let supervisorClear;
  try {
    supervisorClear = clearSupervisorRecord(configDir);
  } catch (err) {
    emit('err', `failed to clear supervisor record in admin.json: ${err.message}`, silent);
    return 1;
  }

  try {
    appendAuditLog(configDir, {
      pm2Available,
      pm2: pm2Results,
      supervisorRecord: {
        changed: supervisorClear.changed,
        hadSupervisor: supervisorClear.hadSupervisor,
        file: supervisorClear.file,
      },
    });
  } catch {
    // Audit must never break uninstall.
  }

  const removed = pm2Results.filter((r) => r.removed).map((r) => r.name);
  const absent = pm2Results.filter((r) => r.status === 'already-absent').map((r) => r.name);

  if (removed.length === 0 && !supervisorClear.changed) {
    emit(
      'out',
      `not registered under pm2 (${TIER_A_PM2_PROCESSES.join(', ')}); nothing to uninstall`,
      silent,
    );
    return 0;
  }

  if (removed.length > 0) {
    emit(
      'out',
      `uninstalled pm2 entries: ${removed.join(', ')} (data dir preserved at ${path.join(configDir, 'data')})`,
      silent,
    );
  }
  if (absent.length > 0 && removed.length > 0) {
    emit('out', `(already absent: ${absent.join(', ')})`, silent);
  }
  if (supervisorClear.changed) {
    emit('out', `cleared supervisor record from ${supervisorClear.file}`, silent);
  } else if (removed.length > 0) {
    emit('out', `no supervisor record to clear in ${supervisorClear.file}`, silent);
  }
  return 0;
}
