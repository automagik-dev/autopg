/**
 * `autopg restart` restarts the canonical PM2-owned postmaster and only
 * succeeds after the postmaster publishes a live runtime record.
 *
 * A PM2 `online` state proves that the wrapper process was admitted. It does
 * not prove that PostgreSQL survived startup or accepted a SQL connection.
 * `runtime.json` is written by the wrapper only after that handshake, so the
 * combined state is AutoPG's readiness contract.
 */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const {
  PM2_PROCESS_NAME,
  formatServiceState,
  pm2GetProcess,
  readRecordedSupervisor,
  waitForServiceReadiness,
} = require('./lib/service-state.cjs');

// Restart commands for the supervisors `autopg restart` does not drive
// itself. Unit names match the liveness probes in src/commands/doctor.js.
const EXTERNAL_RESTART_HINTS = {
  'systemd-user': 'systemctl --user restart autopg.service',
  launchd: 'launchctl kickstart -k "gui/$(id -u)/dev.automagik.autopg"',
};

function pm2IsAvailable() {
  try {
    execFileSync('pm2', ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write(`autopg: ${message}\n`);
  return 1;
}

function ok(message) {
  process.stdout.write(`autopg: ${message}\n`);
  return 0;
}

function restartViaPm2() {
  const result = spawnSync('pm2', ['restart', PM2_PROCESS_NAME], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    return fail(`pm2 restart failed (exit ${result.status})`);
  }
  return 0;
}

async function dispatch(_args = [], ctx = {}) {
  const isAvailable = ctx.pm2IsAvailable || pm2IsAvailable;
  const getProcess = ctx.pm2GetProcess || pm2GetProcess;
  const restart = ctx.restartViaPm2 || restartViaPm2;
  const waitUntilReady = ctx.waitForServiceReadiness || waitForServiceReadiness;
  const readSupervisor = ctx.readSupervisor || readRecordedSupervisor;

  // admin.json records who owns the postmaster. When that is not pm2,
  // pointing the operator at `autopg install` would be wrong.
  const supervisor = readSupervisor();
  if (supervisor && supervisor !== 'pm2') {
    const hint = EXTERNAL_RESTART_HINTS[supervisor];
    return fail(
      `AutoPG is supervised by ${supervisor}, not pm2; `
      + (hint ? `restart it with \`${hint}\`` : 'restart it through that supervisor'),
    );
  }

  if (!isAvailable()) {
    return fail('pm2 is unavailable; cannot restart the configured AutoPG service');
  }
  if (!getProcess(PM2_PROCESS_NAME)) {
    return fail(`pm2 process "${PM2_PROCESS_NAME}" is not registered; run \`autopg install\``);
  }

  const restartCode = restart();
  if (restartCode !== 0) return restartCode;

  const state = await waitUntilReady();
  if (!state.ready) {
    return fail(
      `restart did not become ready: ${formatServiceState(state)}. `
      + `Inspect with \`pm2 logs ${PM2_PROCESS_NAME}\``,
    );
  }

  return ok(`restarted and ready (pm2 process "${PM2_PROCESS_NAME}")`);
}

module.exports = {
  dispatch,
  _internals: {
    PM2_PROCESS_NAME,
    pm2GetProcess,
    pm2IsAvailable,
    restartViaPm2,
  },
};
