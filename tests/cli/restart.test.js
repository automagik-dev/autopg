/**
 * Tests for src/cli-restart.cjs.
 *
 * Strategy:
 *   - Inject PM2 and readiness stubs through the dispatch context so tests
 *     exercise lifecycle decisions without touching the host supervisor.
 *   - Point AUTOPG_CONFIG_DIR at an empty tempdir so the recorded-supervisor
 *     lookup never reads the developer's real ~/.autopg/admin.json.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let tmpHome;
let originalConfigDir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-restart-'));
  originalConfigDir = process.env.AUTOPG_CONFIG_DIR;
  process.env.AUTOPG_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.AUTOPG_CONFIG_DIR;
  else process.env.AUTOPG_CONFIG_DIR = originalConfigDir;
});

function captureStderr(run) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  return Promise.resolve()
    .then(run)
    .then((value) => ({ value, stderr: captured }))
    .finally(() => {
      process.stderr.write = original;
    });
}

function freshRestart() {
  const restartPath = path.join(REPO_ROOT, 'src', 'cli-restart.cjs');
  delete require.cache[restartPath];
  return require(restartPath);
}

describe('pm2 supervised path', () => {
  test('restarts the canonical autopg-server process and waits for readiness', async () => {
    const restart = freshRestart();
    let restartCalled = false;
    let requestedProcess = null;
    let readinessChecked = false;
    const code = await restart.dispatch([], {
      scriptPath: 'unused',
      pm2IsAvailable: () => true,
      pm2GetProcess: (name) => {
        requestedProcess = name;
        return { name: 'autopg-server', pid: 1234 };
      },
      restartViaPm2: () => {
        restartCalled = true;
        return 0;
      },
      waitForServiceReadiness: async () => {
        readinessChecked = true;
        return { ready: true, status: 'ready' };
      },
    });
    expect(code).toBe(0);
    expect(requestedProcess).toBe('autopg-server');
    expect(restartCalled).toBe(true);
    expect(readinessChecked).toBe(true);
  });

  test('returns 1 when restartViaPm2 fails', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      scriptPath: 'unused',
      pm2IsAvailable: () => true,
      pm2GetProcess: () => ({ name: 'autopg-server' }),
      restartViaPm2: () => 1,
    });
    expect(code).toBe(1);
  });

  test('returns 1 when the restarted process never becomes ready', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      pm2IsAvailable: () => true,
      pm2GetProcess: () => ({ name: 'autopg-server' }),
      restartViaPm2: () => 0,
      waitForServiceReadiness: async () => ({
        ready: false,
        status: 'degraded',
        supervisorStatus: 'online',
        runtimeLive: false,
        reasons: ['runtime process is not live'],
      }),
    });
    expect(code).toBe(1);
  });

  test('fails instead of spawning an unmanaged daemon when pm2 is unavailable', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      pm2IsAvailable: () => false,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(1);
  });

  test('fails instead of spawning an unmanaged daemon when the pm2 entry is missing', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      pm2IsAvailable: () => true,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(1);
  });
});

describe('non-pm2 supervisors', () => {
  function neverTouchPm2() {
    throw new Error('pm2 must not be probed when another supervisor owns AutoPG');
  }

  test('points systemd-user hosts at systemctl instead of `autopg install`', async () => {
    const restart = freshRestart();
    const { value, stderr } = await captureStderr(() => restart.dispatch([], {
      readSupervisor: () => 'systemd-user',
      pm2IsAvailable: neverTouchPm2,
      pm2GetProcess: neverTouchPm2,
      restartViaPm2: neverTouchPm2,
    }));
    expect(value).toBe(1);
    expect(stderr).toContain('supervised by systemd-user');
    expect(stderr).toContain('systemctl --user restart autopg.service');
    expect(stderr).not.toContain('autopg install');
  });

  test('points launchd hosts at launchctl kickstart', async () => {
    const restart = freshRestart();
    const { value, stderr } = await captureStderr(() => restart.dispatch([], {
      readSupervisor: () => 'launchd',
      pm2IsAvailable: neverTouchPm2,
    }));
    expect(value).toBe(1);
    expect(stderr).toContain('dev.automagik.autopg');
  });

  test('reads the recorded supervisor from admin.json', async () => {
    fs.writeFileSync(path.join(tmpHome, 'admin.json'), JSON.stringify({ supervisor: 'external' }));
    const restart = freshRestart();
    const { value, stderr } = await captureStderr(() => restart.dispatch([], {
      pm2IsAvailable: neverTouchPm2,
    }));
    expect(value).toBe(1);
    expect(stderr).toContain('supervised by external');
    expect(stderr).toContain('restart it through that supervisor');
  });
});

describe('module helpers', () => {
  test('uses the canonical pm2 process name', () => {
    const restart = freshRestart();
    expect(restart._internals.PM2_PROCESS_NAME).toBe('autopg-server');
  });
});
