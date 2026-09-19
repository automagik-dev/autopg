/**
 * Canonical AutoPG service readiness.
 *
 * Supervisor state and data-plane readiness are deliberately separate:
 * PM2 can report `online` while the postmaster is still starting or has
 * already failed. The postmaster writes runtime.json only after PostgreSQL
 * accepts `SELECT 1`, so readiness requires both signals to agree.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PM2_PROCESS_NAME = 'autopg-server';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

function getConfigDir(env = process.env) {
  return env.AUTOPG_CONFIG_DIR
    || env.PGSERVE_CONFIG_DIR
    || path.join(os.homedir(), '.autopg');
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function pm2GetProcess(name = PM2_PROCESS_NAME) {
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
 * Supervisor recorded in admin.json at install time (`pm2`, `systemd-user`,
 * `launchd`, `external`), or null when nothing is recorded.
 */
function readRecordedSupervisor(env = process.env) {
  return readJson(path.join(getConfigDir(env), 'admin.json'))?.supervisor || null;
}

function evaluateServiceState({
  supervisor,
  supervisorStatus,
  supervisorPid,
  configuredPort,
  runtime,
  runtimeLive,
}) {
  const reasons = [];
  const pm2Ready = supervisor !== 'pm2' || supervisorStatus === 'online';
  const runtimePresent = runtime !== null && runtime !== undefined;
  const runtimeOwnedBySupervisor = supervisor !== 'pm2'
    || (Number.isInteger(supervisorPid) && runtime?.autopgPid === supervisorPid);
  const portMatches = !runtimePresent
    || !Number.isInteger(configuredPort)
    || runtime.port === configuredPort;

  if (!pm2Ready) {
    reasons.push(`pm2 process is ${supervisorStatus || 'missing'}`);
  }
  if (!runtimePresent) {
    reasons.push('runtime record is missing');
  } else if (!runtimeLive) {
    reasons.push('runtime process is not live');
  }
  if (runtimePresent && !runtimeOwnedBySupervisor) {
    reasons.push(
      `runtime pid ${runtime.autopgPid ?? 'missing'} does not match pm2 pid ${supervisorPid ?? 'missing'}`,
    );
  }
  if (!portMatches) {
    reasons.push(`runtime port ${runtime.port} does not match configured port ${configuredPort}`);
  }

  const ready = pm2Ready
    && runtimePresent
    && runtimeLive === true
    && runtimeOwnedBySupervisor
    && portMatches;
  let status = 'degraded';
  if (ready) status = 'ready';
  else if (supervisorStatus === 'stopped' || supervisorStatus === 'missing') status = 'stopped';
  else if (supervisorStatus === 'errored') status = 'failed';

  return {
    ready,
    status,
    supervisor: supervisor || null,
    supervisorStatus: supervisorStatus || null,
    supervisorPid: Number.isInteger(supervisorPid) ? supervisorPid : null,
    configuredPort: Number.isInteger(configuredPort) ? configuredPort : null,
    runtime: runtime || null,
    runtimeLive: runtimeLive === true,
    reasons,
  };
}

function inspectServiceState({
  env = process.env,
  getProcess = pm2GetProcess,
  processIsAlive = isProcessAlive,
} = {}) {
  const configDir = getConfigDir(env);
  const admin = readJson(path.join(configDir, 'admin.json'));
  const config = readJson(path.join(configDir, 'config.json'));
  const processRecord = getProcess(PM2_PROCESS_NAME);
  const supervisor = admin?.supervisor || (processRecord ? 'pm2' : null);
  const supervisorStatus = supervisor === 'pm2'
    ? processRecord?.pm2_env?.status || 'missing'
    : supervisor || null;
  const socketDir = admin?.socketDir
    || path.join(env.XDG_RUNTIME_DIR || '/tmp', 'pgserve');
  const runtime = readJson(path.join(socketDir, 'runtime.json'));
  const configuredPort = Number.isInteger(admin?.port)
    ? admin.port
    : Number.isInteger(config?.port)
      ? config.port
      : null;

  return evaluateServiceState({
    supervisor,
    supervisorStatus,
    supervisorPid: processRecord?.pid,
    configuredPort,
    runtime,
    runtimeLive: processIsAlive(runtime?.autopgPid),
  });
}

async function waitForServiceReadiness({
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  inspect = inspectServiceState,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = await inspect();

  while (!state.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    state = await inspect();
  }

  return state;
}

function formatServiceState(state) {
  if (!state) return 'service state unavailable';
  if (state.ready) return 'ready';
  return state.reasons?.length > 0
    ? state.reasons.join('; ')
    : `status=${state.status || 'unknown'}`;
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  PM2_PROCESS_NAME,
  evaluateServiceState,
  formatServiceState,
  inspectServiceState,
  pm2GetProcess,
  readRecordedSupervisor,
  waitForServiceReadiness,
  _internals: {
    getConfigDir,
    isProcessAlive,
    pm2GetProcess,
    readJson,
  },
};
