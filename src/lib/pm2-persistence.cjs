/**
 * pm2 registration durability.
 *
 * `pm2 start` registers a process with the running pm2 daemon only. What
 * comes back after the daemon restarts — `pm2 resurrect`, which is what the
 * `pm2 startup` unit runs at boot — is whatever `<PM2_HOME>/dump.pm2` held
 * at the last `pm2 save`. A process that is live but missing from the dump
 * silently disappears at the next daemon restart while its consumers are
 * restored and crash-loop against a closed port (issue #144).
 *
 * dump.pm2 is a JSON array whose objects carry the same keys as
 * `pm2 jlist`'s `pm2_env`, so live and persisted state compare field by field.
 */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// What has to survive a resurrect for the same postmaster to come back:
// the executable, its args (port, data dir, socket dir) and the supervision
// limits registered at install time.
const PERSISTED_FIELDS = Object.freeze([
  'pm_exec_path',
  'args',
  'exec_interpreter',
  'max_restarts',
  'restart_delay',
  'exp_backoff_restart_delay',
  'max_memory_restart',
  'kill_timeout',
]);

function getPm2Home(env = process.env) {
  return env.PM2_HOME || path.join(os.homedir(), '.pm2');
}

function getPm2DumpPath(env = process.env) {
  return path.join(getPm2Home(env), 'dump.pm2');
}

/**
 * @returns {{ file: string, exists: boolean, entries: object[], error: string|null }}
 */
function readPm2Dump(env = process.env) {
  const file = getPm2DumpPath(env);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, entries: [], error: null };
    return { file, exists: false, entries: [], error: error.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { file, exists: true, entries: [], error: 'dump.pm2 is not a JSON array' };
    return { file, exists: true, entries: parsed.filter((entry) => entry && typeof entry === 'object'), error: null };
  } catch (error) {
    return { file, exists: true, entries: [], error: `dump.pm2 is not valid JSON: ${error.message}` };
  }
}

function pm2GetProcess(name) {
  try {
    const output = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const processes = JSON.parse(output);
    return Array.isArray(processes)
      ? processes.find((entry) => entry?.name === name) || null
      : null;
  } catch {
    return null;
  }
}

/**
 * Compare a live `pm2 jlist` entry with the dump. Pure: no I/O.
 *
 * @returns {{ persisted: boolean, reason: string|null, differences: string[] }}
 */
function comparePm2Persistence(name, liveEntry, dump) {
  if (dump.error) {
    return { persisted: false, reason: dump.error, differences: [] };
  }
  const saved = dump.entries.find((entry) => entry.name === name) || null;
  if (!liveEntry) {
    return saved
      ? { persisted: false, reason: `${name} is in dump.pm2 but not registered with pm2`, differences: [] }
      : { persisted: true, reason: null, differences: [] };
  }
  if (!saved) {
    const reason = dump.exists
      ? `${name} is registered with pm2 but missing from dump.pm2`
      : `${name} is registered with pm2 but no dump.pm2 exists`;
    return { persisted: false, reason, differences: [] };
  }
  const live = liveEntry.pm2_env || {};
  const differences = PERSISTED_FIELDS.filter(
    (field) => JSON.stringify(live[field] ?? null) !== JSON.stringify(saved[field] ?? null),
  );
  return differences.length === 0
    ? { persisted: true, reason: null, differences }
    : {
        persisted: false,
        reason: `${name} differs between pm2 and dump.pm2 (${differences.join(', ')})`,
        differences,
      };
}

function inspectPm2Persistence(name, { env = process.env, getProcess = pm2GetProcess } = {}) {
  return comparePm2Persistence(name, getProcess(name), readPm2Dump(env));
}

/**
 * Make the live registration of every name in `names` durable. Runs
 * `pm2 save` only when something actually differs, so a re-run with nothing
 * to persist leaves the operator's dump alone, then reads the dump back to
 * prove it.
 *
 * `pm2 save` snapshots the whole process list, not just ours — that is the
 * only interface pm2 offers. It is what an operator would run by hand here.
 *
 * @returns {{ saved: boolean, ok: boolean, reasons: string[] }}
 */
function persistPm2Registrations(names, { env = process.env, getProcess = pm2GetProcess, save = pm2Save } = {}) {
  const pending = names
    .map((name) => inspectPm2Persistence(name, { env, getProcess }))
    .filter((state) => !state.persisted);
  if (pending.length === 0) return { saved: false, ok: true, reasons: [] };

  const result = save();
  if (!result.ok) {
    return { saved: false, ok: false, reasons: [`pm2 save failed: ${result.reason}`] };
  }
  const remaining = names
    .map((name) => inspectPm2Persistence(name, { env, getProcess }))
    .filter((state) => !state.persisted);
  return { saved: true, ok: remaining.length === 0, reasons: remaining.map((state) => state.reason) };
}

function pm2Save() {
  const result = spawnSync('pm2', ['save'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    return { ok: false, reason: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  }
  return { ok: true, reason: null };
}

module.exports = {
  PERSISTED_FIELDS,
  comparePm2Persistence,
  getPm2DumpPath,
  inspectPm2Persistence,
  persistPm2Registrations,
  readPm2Dump,
};
