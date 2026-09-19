/**
 * Tests for src/cli-install.cjs — pgserve install/uninstall/status/url/port.
 *
 * Wave 1 of the canonical-pgserve-pm2-supervision wish (PR #55, issue #56).
 *
 * Strategy: drive the pure paths (config read/write, arg parsing, pm2-args
 * builder) directly. The pm2-spawning paths (install / uninstall) are
 * exercised by spawning the real pgserve binary against a temp HOME so
 * `pm2` is invoked but with no real daemon side-effect when pm2 is
 * either absent OR the test stubs its calls via PATH.
 *
 * No test in this file actually starts pgserve. We only verify the CLI
 * surface — the daemon lifecycle is covered by daemon-control.test.js.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs');

let tmpHome;
let stubBin;
let originalConfigDir;
let originalPath;

function makeStubPm2(mode = 'success') {
  // mode: 'success' | 'failure' | 'missing'
  // Writes a stub `pm2` script into a tempdir we prepend to PATH.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-stub-pm2-'));
  if (mode === 'missing') {
    // Don't create a stub; PATH still has our dir but no pm2 binary.
    return { dir, calls: [] };
  }
  const callLog = path.join(dir, 'calls.log');
  const serviceState = path.join(dir, 'service-state.json');
  const statusFile = path.join(dir, 'process-status');
  const exitCode = mode === 'failure' ? 1 : 0;
  // jlist returns either an empty list (so install proceeds) or a fake
  // process record (so subsequent install calls hit the idempotent
  // path). We toggle via a sentinel file the test owns.
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
const serviceStatePath = ${JSON.stringify(serviceState)};
function refreshRuntime() {
  if (!fs.existsSync(serviceStatePath)) return;
  const state = JSON.parse(fs.readFileSync(serviceStatePath, 'utf8'));
  fs.mkdirSync(state.socketDir, { recursive: true });
  fs.writeFileSync(path.join(state.socketDir, 'runtime.json'), JSON.stringify({
    socketDir: state.socketDir,
    port: state.port,
    pid: Number(process.env.AUTOPG_TEST_LIVE_PID) || process.ppid,
    autopgPid: Number(process.env.AUTOPG_TEST_LIVE_PID) || process.ppid,
    schemaVersion: 1
  }));
}
if (args[0] === '--version') { process.stdout.write('5.0.0-stub\\n'); process.exit(0); }
if (args[0] === 'jlist') {
  const sentinel = ${JSON.stringify(path.join(dir, 'registered'))};
  if (fs.existsSync(sentinel)) {
    refreshRuntime();
    const processStatus = fs.existsSync(${JSON.stringify(statusFile)})
      ? fs.readFileSync(${JSON.stringify(statusFile)}, 'utf8').trim()
      : 'online';
    process.stdout.write(JSON.stringify([{
      name: 'autopg-server',
      pid: Number(process.env.AUTOPG_TEST_LIVE_PID) || 12345,
      pm2_env: { status: processStatus, pm_uptime: Date.now() - 1000, restart_time: 0 }
    }]) + '\\n');
  } else {
    process.stdout.write('[]\\n');
  }
  process.exit(0);
}
if (args[0] === 'start') {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'registered'))}, '');
  fs.writeFileSync(${JSON.stringify(statusFile)}, 'online');
  const nameIndex = args.indexOf('--name');
  if (nameIndex >= 0 && args[nameIndex + 1] === 'autopg-server') {
    const socketIndex = args.lastIndexOf('--socket-dir');
    const portIndex = args.lastIndexOf('--port');
    fs.writeFileSync(serviceStatePath, JSON.stringify({
      socketDir: args[socketIndex + 1],
      port: Number(args[portIndex + 1])
    }));
    refreshRuntime();
  }
  process.exit(${exitCode});
}
if (args[0] === 'delete') {
  try { fs.unlinkSync(${JSON.stringify(path.join(dir, 'registered'))}); } catch {}
  try { fs.unlinkSync(${JSON.stringify(statusFile)}); } catch {}
  process.exit(${exitCode});
}
process.exit(0);
`;
  const pm2Path = path.join(dir, 'pm2');
  fs.writeFileSync(pm2Path, script, { mode: 0o755 });
  return { dir, calls: callLog, statusFile };
}

function readCallLog(callsPath) {
  if (!fs.existsSync(callsPath)) return [];
  return fs.readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runCli(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PGSERVE_CONFIG_DIR: tmpHome,
      AUTOPG_TEST_LIVE_PID: String(process.pid),
      XDG_RUNTIME_DIR: path.join(tmpHome, 'runtime'),
      PATH: `${stubBin.dir}:${process.env.PATH}`,
      // Default test mode: skip the B3 port pre-flight so existing
      // tests that assert on `port: 5432` literal output don't race
      // host-level services on the canonical port. B3's port-pre-
      // flight tests pass `PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '0'` (or
      // unset) explicitly so the production code path fires.
      PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '1',
      ...env,
    },
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-cfg-'));
  stubBin = makeStubPm2('success');
  originalConfigDir = process.env.PGSERVE_CONFIG_DIR;
  originalPath = process.env.PATH;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (stubBin?.dir) fs.rmSync(stubBin.dir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.PGSERVE_CONFIG_DIR;
  else process.env.PGSERVE_CONFIG_DIR = originalConfigDir;
  process.env.PATH = originalPath;
});

describe('pgserve install', () => {
  test('autopg auth is routed by the wrapper before the bun probe', () => {
    const result = runCli(['auth', 'show-admin-path']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(tmpHome, 'admin.json'));
    expect(result.stderr).not.toContain('unknown verb "auth"');
  });

  test('first install registers under pm2 and writes config', () => {
    const result = runCli(['install']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('installed');
    expect(result.stdout).toContain('postgres://localhost:5432');

    const config = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'));
    expect(config.port).toBe(5432);
    expect(config.dataDir).toBe(path.join(tmpHome, 'data'));
    expect(config.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const calls = readCallLog(stubBin.calls);
    const startCall = calls.find((c) => c[0] === 'start' && c.includes('autopg-server'));
    expect(startCall).toBeDefined();
    expect(startCall).toContain('--name');
    expect(startCall).toContain('autopg-server');
    expect(startCall).toContain('--max-restarts');
    expect(startCall).toContain('50');
    // pm2 ≥ 6.0 dropped `--min-uptime` from the CLI surface; install must
    // NOT pass it (compat across pm2 5.x → 6.x).
    expect(startCall).not.toContain('--min-uptime');
    expect(startCall).toContain('--exp-backoff-restart-delay');
    expect(startCall).toContain('--max-memory-restart');
    expect(startCall).toContain('4G');
    expect(startCall).toContain('--kill-timeout');
    expect(startCall).toContain('60000');
    expect(startCall).toContain('--interpreter');
    expect(startCall).toContain('none');

    // pgserve singleton (v2.4): pm2 supervises the postmaster directly via
    // the `pgserve postmaster` subcommand — no router, no bun proxy, no
    // daemon mode. Lock that out: the script-arg handover (after `--`)
    // starts with `postmaster` and includes the canonical socket dir.
    expect(startCall).not.toContain('daemon');
    const dashDashIdx = startCall.indexOf('--');
    const scriptArgs = startCall.slice(dashDashIdx + 1);
    expect(scriptArgs[0]).toBe('postmaster');
    expect(scriptArgs).toContain('--port');
    expect(scriptArgs).toContain('--data');
    expect(scriptArgs).toContain('--socket-dir');
    expect(scriptArgs).toContain('--log');
    expect(scriptArgs).not.toContain('daemon');
  });

  test('second install is idempotent (no second pm2 start)', () => {
    // Since v2.2.3 `autopg install` registers TWO pm2 processes (pgserve +
    // autopg-ui), so plain start-count comparisons are off. Use --no-ui to
    // keep this test focused on daemon-side idempotency.
    runCli(['install', '--no-ui']);
    const calls1 = readCallLog(stubBin.calls);
    const startCount1 = calls1.filter((c) => c[0] === 'start').length;
    expect(startCount1).toBe(1);

    const result2 = runCli(['install', '--no-ui']);
    expect(result2.status).toBe(0);
    expect(result2.stdout).toContain('already installed');

    const calls2 = readCallLog(stubBin.calls);
    const startCount2 = calls2.filter((c) => c[0] === 'start').length;
    expect(startCount2).toBe(1); // no second start
  });

  test('an existing stopped pm2 entry is started and must become ready', () => {
    runCli(['install', '--no-ui']);
    fs.writeFileSync(stubBin.statusFile, 'stopped');

    const result = runCli(['install', '--no-ui']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already installed and ready');

    const calls = readCallLog(stubBin.calls);
    expect(calls).toContainEqual(['start', 'autopg-server']);
  });

  test('autopg install registers BOTH autopg-server and autopg-ui by default', () => {
    runCli(['install']);
    const calls = readCallLog(stubBin.calls);
    const starts = calls.filter((c) => c[0] === 'start');
    // One start each for autopg-server (the postmaster) + autopg-ui.
    expect(starts.length).toBe(2);
    const names = starts.map((c) => {
      const idx = c.indexOf('--name');
      return idx >= 0 ? c[idx + 1] : null;
    });
    expect(names).toContain('autopg-server');
    expect(names).toContain('autopg-ui');
  });

  test('autopg install --no-ui skips the autopg-ui pm2 process', () => {
    const result = runCli(['install', '--no-ui']);
    expect(result.status).toBe(0);
    const calls = readCallLog(stubBin.calls);
    const starts = calls.filter((c) => c[0] === 'start');
    expect(starts.length).toBe(1);
    const idx = starts[0].indexOf('--name');
    expect(starts[0][idx + 1]).toBe('autopg-server');
    // The CLI should advertise the opt-out path on stderr or stdout.
    expect(result.stdout + result.stderr).toContain('skipping console install');
  });

  test('autopg install --ui-port overrides the UI bind port', () => {
    runCli(['install', '--ui-port', '8500']);
    const calls = readCallLog(stubBin.calls);
    const uiStart = calls.find((c) => {
      const i = c.indexOf('--name');
      return i >= 0 && c[i + 1] === 'autopg-ui';
    });
    expect(uiStart).toBeDefined();
    // Script-arg portion (after `--`) should include `--port 8500`.
    const dashIdx = uiStart.indexOf('--');
    const scriptArgs = uiStart.slice(dashIdx + 1);
    expect(scriptArgs).toContain('--port');
    const portIdx = scriptArgs.indexOf('--port');
    expect(scriptArgs[portIdx + 1]).toBe('8500');
  });

  test('autopg uninstall tears down both autopg-server and autopg-ui', () => {
    runCli(['install']);
    runCli(['uninstall', '--yes']);
    const calls = readCallLog(stubBin.calls);
    const deletes = calls.filter((c) => c[0] === 'delete');
    const deletedNames = deletes.map((c) => c[1]);
    expect(deletedNames).toContain('autopg-server');
    expect(deletedNames).toContain('autopg-ui');
  });

  test('--port overrides default', () => {
    const result = runCli(['install', '--port', '8442']);
    expect(result.status).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'));
    expect(config.port).toBe(8442);
    expect(result.stdout).toContain('postgres://localhost:8442');
  });

  test('rejects malformed --port', () => {
    const result = runCli(['install', '--port', 'not-a-number']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid --port');
  });

  test('PGSERVE_MAX_MEMORY env overrides the default memory ceiling', () => {
    const result = runCli(['install'], { PGSERVE_MAX_MEMORY: '8G' });
    expect(result.status).toBe(0);
    const calls = readCallLog(stubBin.calls);
    const startCall = calls.find((c) => c[0] === 'start');
    // The env value flows through to pm2's --max-memory-restart flag so
    // operators on big-iron hosts can tune up without a recompile.
    expect(startCall).toContain('8G');
    expect(startCall).not.toContain('4G');
  });

  test('fails clearly when pm2 is missing', () => {
    // Build a sanitized PATH that has NO pm2 anywhere — we want pm2 to be
    // genuinely missing for this scenario. Invoke the wrapper through the
    // current runtime via its absolute path so we never need to put a
    // node/bun dir back on PATH (under bun's test runner, `process.execPath`
    // resolves to `/home/.../.bun/bin/bun` whose dir typically also contains
    // pm2 — adding it back to PATH leaks pm2 into the spawned process and
    // masks the failure).
    fs.rmSync(stubBin.dir, { recursive: true, force: true });
    stubBin = makeStubPm2('missing');
    const sanitizedPath = (process.env.PATH || '')
      .split(':')
      .filter((p) => {
        try {
          return !fs.existsSync(path.join(p, 'pm2'));
        } catch {
          return true;
        }
      })
      .concat([stubBin.dir])
      .join(':');
    const result = spawnSync(process.execPath, [BIN, 'install'], {
      encoding: 'utf8',
      env: { ...process.env, PGSERVE_CONFIG_DIR: tmpHome, PATH: sanitizedPath },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pm2 not found');
  });
});

describe('pgserve install --help (B2 v2.6.1)', () => {
  test('--help long flag prints usage + exits 0; no install side effects', () => {
    const result = runCli(['install', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--port');
    expect(result.stdout).not.toContain('pgserve: installed');
    // pm2 stub MUST NOT have been touched
    const calls = readCallLog(stubBin.calls);
    expect(calls.find((c) => c[0] === 'start')).toBeUndefined();
    // admin.json + data dir MUST NOT have been created
    expect(fs.existsSync(path.join(tmpHome, 'admin.json'))).toBe(false);
  });

  test('-h short flag is identical to --help', () => {
    const result = runCli(['install', '-h']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    const calls = readCallLog(stubBin.calls);
    expect(calls.find((c) => c[0] === 'start')).toBeUndefined();
  });

  test('--help interleaved with other flags still preempts', () => {
    const result = runCli(['install', '--port', '25432', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    const calls = readCallLog(stubBin.calls);
    expect(calls.find((c) => c[0] === 'start')).toBeUndefined();
  });
});

describe('pgserve unknown verb (B4 v2.6.1)', () => {
  test('pgserve <gibberish> exits 64 with "unknown verb" error', () => {
    const result = runCli(['nonexistent-verb-here']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('unknown verb');
    expect(result.stderr).toContain('nonexistent-verb-here');
    expect(result.stderr).toContain('--help');
  });

  test('pgserve <gibberish-with-flags> still routed to unknown-verb path', () => {
    const result = runCli(['some-fake-verb-xyz', '--port', '5432']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('some-fake-verb-xyz');
  });

  test('top-level flags (--help, --version) are NOT treated as unknown verbs', () => {
    // These should reach postgres-server.js help path or version path; the
    // wrapper must not intercept them as unknown verbs. We assert exit
    // code != 64 (the EX_USAGE we use for unknown verbs).
    const help = runCli(['--help']);
    expect(help.status).not.toBe(64);
    const version = runCli(['--version']);
    expect(version.status).not.toBe(64);
  });

  test('real allowlisted verbs still route correctly (status reaches the dispatcher)', () => {
    // status BEFORE install reports installed=false (per existing test); the
    // important thing here is the wrapper does NOT short-circuit it as
    // unknown.
    const result = runCli(['status']);
    expect(result.status).not.toBe(64);
  });
});

describe('pgserve install port pre-flight (B3 v2.6.1)', () => {
  test('install fails with EADDRINUSE when chosen port is occupied; no side effects', async () => {
    // Bind a tcp listener on a high random port; install should refuse it.
    const occupier = net.createServer();
    await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupier.address().port;
    try {
      // Override default test-mode skip so the production pre-flight
      // path runs; this is the test that exercises the B3 contract.
      const result = runCli(['install', '--port', String(occupiedPort)], {
        PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '0',
      });
      expect(result.status).not.toBe(0);
      const stderrAll = `${result.stderr}${result.stdout}`;
      expect(stderrAll).toMatch(/port \d+ is already in use|EADDRINUSE/);
      expect(stderrAll).toContain('--port');  // recovery hint
      // pm2 stub MUST NOT have been touched
      const calls = readCallLog(stubBin.calls);
      expect(calls.find((c) => c[0] === 'start')).toBeUndefined();
      // admin.json MUST NOT exist
      expect(fs.existsSync(path.join(tmpHome, 'admin.json'))).toBe(false);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  });

  test('install --port <occupied> EADDRINUSE produces non-zero exit code (regression: loop-2/2)', async () => {
    // Loop-2 of /fix budget for PR #103. QA reported detection works,
    // message prints, but exit code is 0. This locks the exit-code
    // contract independent of message-detection contract.
    const occupier = net.createServer();
    await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupier.address().port;
    try {
      const result = runCli(['install', '--port', String(occupiedPort)], {
        PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '0',
      });
      // Hard exit-code assertion (not just message contains)
      expect(result.status).not.toBe(0);
      expect(result.status).toBe(1);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  });

  test('install --port <occupied> exit code 1 propagates under bash pipefail (CV103-2 R6 regression)', async () => {
    // CV103-2 (v2.6.2): qa's 9-variant matrix on v2.6.1 isolated a
    // stdio-pipe race in the EADDRINUSE catch handler. Synchronous
    // `process.exit(1)` raced the libuv stderr flush under
    // stdout-piped / stderr-inherited shapes (R6: `pgserve install | cat`),
    // causing Node to terminate with exit code 0 instead of 1.
    //
    // Regression assertion: under bash's `set -o pipefail`, the
    // pgserve pipeline element's exit code propagates as the overall
    // pipeline status. With the v2.6.2 fix (drop process.exit(1),
    // keep process.exitCode + throw), pgserve exits 1 and pipefail
    // surfaces it.
    const occupier = net.createServer();
    await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupier.address().port;
    try {
      const cmd = `set -o pipefail; "${process.execPath}" "${BIN}" install --port ${occupiedPort} | cat`;
      const result = spawnSync('/bin/bash', ['-c', cmd], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '0',
          PGSERVE_CONFIG_DIR: tmpHome,
          PATH: `${stubBin.dir}:${process.env.PATH}`,
        },
      });
      expect(result.status).toBe(1);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  });

  test('install --port <occupied> exit code 1 visible via PIPESTATUS[0] (CV103-2 R6 regression)', async () => {
    // Companion to the pipefail test above. Bash's PIPESTATUS array
    // exposes each pipeline element's raw exit code regardless of
    // pipefail. Asserting PIPESTATUS[0] == 1 tests the pgserve-side
    // exit code directly, independent of the shell options.
    const occupier = net.createServer();
    await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupier.address().port;
    try {
      const cmd = `"${process.execPath}" "${BIN}" install --port ${occupiedPort} | cat; echo "PIPESTATUS=\${PIPESTATUS[0]}"`;
      const result = spawnSync('/bin/bash', ['-c', cmd], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '0',
          PGSERVE_CONFIG_DIR: tmpHome,
          PATH: `${stubBin.dir}:${process.env.PATH}`,
        },
      });
      expect(result.stdout).toContain('PIPESTATUS=1');
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  });

  test('install with NO --port flag refuses when default 5432 is already bound (B3 T1 contract)', async () => {
    // This mirrors QA-RECIPE-B3 T1: occupy 5432, then `pgserve install` with
    // no --port should refuse via the pre-flight, not exit 0. The default-
    // port path is the load-bearing case the recipe targets — explicit-port
    // tests above can mask it because the pre-flight code path differs.
    const occupier = net.createServer();
    await new Promise((resolve, reject) => {
      occupier.listen(5432, '127.0.0.1', resolve).once('error', (err) => {
        // Skip if 5432 is bound by something else (CI host conflict)
        if (err.code === 'EADDRINUSE') reject(new Error('SKIP-host-bound'));
        else reject(err);
      });
    }).catch((err) => {
      if (err.message === 'SKIP-host-bound') {
        // 5432 is bound by something we don't own; the install pre-flight
        // will see it the same as our test-occupier would. Test still
        // exercises the contract.
      } else throw err;
    });
    try {
      const result = runCli(['install'], {
        PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '0',
      });
      expect(result.status).not.toBe(0);
      const stderrAll = `${result.stderr}${result.stdout}`;
      expect(stderrAll).toMatch(/port \d+ is already in use|EADDRINUSE/);
    } finally {
      if (occupier.listening) await new Promise((resolve) => occupier.close(resolve));
    }
  });

  test('install on a free port proceeds normally (regression guard)', async () => {
    // Find a free port without binding it (so install can grab it). We
    // bind, immediately read the port, then close — small race window
    // is acceptable in test environments.
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const freePort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    // Run with the production pre-flight enabled (no skip) so this
    // test verifies the success-path through the new code.
    const result = runCli(['install', '--port', String(freePort)], {
      PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '0',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/installed/);
  });
});

describe('pgserve url / port', () => {
  test('url after install prints canonical connection string', () => {
    runCli(['install']);
    const result = runCli(['url']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('postgres://localhost:5432/postgres');
  });

  test('port after install prints the registered port', () => {
    runCli(['install', '--port', '8442']);
    const result = runCli(['port']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('8442');
  });

  test('port after default install prints 5432 (canonical)', () => {
    runCli(['install']);
    const result = runCli(['port']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('5432');
  });

  test('url before install fails with helpful message', () => {
    const result = runCli(['url']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not installed');
  });
});

describe('pgserve status', () => {
  test('status before install reports installed=false (exit 1)', () => {
    const result = runCli(['status', '--json']);
    expect(result.status).toBe(1);
    const out = JSON.parse(result.stdout);
    expect(out.installed).toBe(false);
  });

  test('status after install reports readiness separately from pm2 state', () => {
    runCli(['install', '--port', '8482']);
    const result = runCli(['status', '--json']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.installed).toBe(true);
    expect(out.name).toBe('autopg-server');
    expect(out.status).toBe('ready');
    expect(out.ready).toBe(true);
    expect(out.supervisorStatus).toBe('online');
    expect(out.port).toBe(8482);
    expect(out.url).toBe('postgres://localhost:8482/postgres');
  });

  test('status human-readable output includes port + url', () => {
    runCli(['install']);
    const result = runCli(['status']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('port');
    expect(result.stdout).toContain('5432');
    expect(result.stdout).toContain('postgres://localhost:5432/postgres');
  });

  test('status is degraded when pm2 is online but the runtime process is stale', () => {
    runCli(['install', '--port', '8482']);
    const admin = JSON.parse(fs.readFileSync(path.join(tmpHome, 'admin.json'), 'utf8'));
    const runtimePath = path.join(admin.socketDir, 'runtime.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    fs.writeFileSync(runtimePath, JSON.stringify({ ...runtime, autopgPid: 2147483646 }));

    // Prevent the pm2 stub from refreshing runtime for this probe.
    fs.rmSync(path.join(stubBin.dir, 'service-state.json'));
    const result = runCli(['status', '--json']);
    const out = JSON.parse(result.stdout);

    expect(out.supervisorStatus).toBe('online');
    expect(out.ready).toBe(false);
    expect(out.status).toBe('degraded');
    expect(out.runtime.live).toBe(false);
  });
});

describe('pgserve uninstall', () => {
  test('uninstall removes pm2 process but preserves config', () => {
    runCli(['install']);
    expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true);

    const result = runCli(['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('uninstalled');

    const calls = readCallLog(stubBin.calls);
    expect(calls.find((c) => c[0] === 'delete' && c[1] === 'autopg-server')).toBeDefined();

    // Config preserved so a re-install reuses port/dataDir.
    expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true);
  });

  test('uninstall when not installed is a no-op success', () => {
    const result = runCli(['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not registered');
  });
});

describe('pgserve singleton (v2.4) — socket dir + admin.json supervisor record', () => {
  // Use a unique XDG_RUNTIME_DIR per test so we don't pollute the host's
  // canonical socket dir. ensureSocketDir() probes writability on the
  // resolved path and refuses on EACCES — the temp path keeps tests
  // hermetic across CI / dev laptops.
  let tmpXdg;
  beforeEach(() => {
    tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-xdg-'));
  });
  afterEach(() => {
    if (tmpXdg) fs.rmSync(tmpXdg, { recursive: true, force: true });
  });

  function runWithXdg(args, env = {}) {
    return runCli(args, { XDG_RUNTIME_DIR: tmpXdg, ...env });
  }

  test('install creates the canonical socket dir under $XDG_RUNTIME_DIR with mode 0700', () => {
    const result = runWithXdg(['install', '--no-ui']);
    expect(result.status).toBe(0);
    const socketDir = path.join(tmpXdg, 'pgserve');
    expect(fs.existsSync(socketDir)).toBe(true);
    const stat = fs.statSync(socketDir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  test('install passes --socket-dir to the postmaster pm2 args', () => {
    runWithXdg(['install', '--no-ui']);
    const calls = readCallLog(stubBin.calls);
    const startCall = calls.find((c) => c[0] === 'start' && c.includes('autopg-server'));
    const dashIdx = startCall.indexOf('--');
    const scriptArgs = startCall.slice(dashIdx + 1);
    const sdIdx = scriptArgs.indexOf('--socket-dir');
    expect(sdIdx).toBeGreaterThan(-1);
    expect(scriptArgs[sdIdx + 1]).toBe(path.join(tmpXdg, 'pgserve'));
  });

  test('install does NOT pass --pgvector to the postmaster when settings.json omits it (default off)', () => {
    runWithXdg(['install', '--no-ui']);
    const calls = readCallLog(stubBin.calls);
    const startCall = calls.find((c) => c[0] === 'start' && c.includes('autopg-server'));
    const dashIdx = startCall.indexOf('--');
    const scriptArgs = startCall.slice(dashIdx + 1);
    expect(scriptArgs).not.toContain('--pgvector');
  });

  test('install passes --pgvector to the postmaster when settings.json has runtime.enablePgvector=true', () => {
    // Pre-seed settings.json before install so loadEffectiveConfig sees it.
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, 'settings.json'),
      JSON.stringify({ _schemaVersion: 1, runtime: { enablePgvector: true } }),
    );
    runWithXdg(['install', '--no-ui']);
    const calls = readCallLog(stubBin.calls);
    const startCall = calls.find((c) => c[0] === 'start' && c.includes('autopg-server'));
    const dashIdx = startCall.indexOf('--');
    const scriptArgs = startCall.slice(dashIdx + 1);
    // --pgvector must reach the postmaster so PostgresManager.enablePgvector
    // is true and _doEnsurePgvectorFiles runs on PG start. Without this,
    // `autopg config set runtime.enablePgvector true` is silently dropped
    // and consumers (e.g. @khal-os/brain) hit "type \"vector\" does not exist"
    // at CREATE EXTENSION time.
    expect(scriptArgs).toContain('--pgvector');
  });

  test('install writes admin.json with supervisor=pm2 + canonical socketDir + port', () => {
    runWithXdg(['install', '--no-ui']);
    const adminFile = path.join(tmpHome, 'admin.json');
    expect(fs.existsSync(adminFile)).toBe(true);
    const stat = fs.statSync(adminFile);
    expect(stat.mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
    expect(onDisk.supervisor).toBe('pm2');
    expect(onDisk.socketDir).toBe(path.join(tmpXdg, 'pgserve'));
    expect(onDisk.port).toBe(5432);
    expect(onDisk.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('install --no-pm2 skips pm2 register but still writes admin.json with supervisor=external', () => {
    const result = runWithXdg(['install', '--no-pm2', '--no-ui']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--no-pm2');
    expect(result.stdout).toContain('supervisor=external');

    const calls = readCallLog(stubBin.calls);
    expect(calls.filter((c) => c[0] === 'start')).toEqual([]);

    const adminFile = path.join(tmpHome, 'admin.json');
    expect(fs.existsSync(adminFile)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
    expect(onDisk.supervisor).toBe('external');
    expect(onDisk.socketDir).toBe(path.join(tmpXdg, 'pgserve'));
    expect(onDisk.port).toBe(5432);
  });

  test('install refuses with non-zero when admin.json records supervisor=systemd-user', () => {
    // Pre-seed the lock file as if `autopg service install` had already run.
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, 'admin.json'),
      JSON.stringify({
        supervisor: 'systemd-user',
        socketDir: '/run/user/1000/pgserve',
        port: 5432,
        installedAt: '2026-05-01T00:00:00.000Z',
      }),
      { mode: 0o600 },
    );
    const result = runWithXdg(['install', '--no-ui']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/supervisor mismatch|systemd-user/);
    expect(result.stderr).toContain('autopg service uninstall');
  });

  test('install fallback uses /tmp/pgserve when XDG_RUNTIME_DIR is unset', () => {
    // Clear XDG so resolveSocketDir falls back. The canonical /tmp/pgserve
    // path may already exist on the host — that's fine: ensureSocketDir
    // is idempotent and re-chmods to 0700.
    const runtimePath = '/tmp/pgserve/runtime.json';
    const previousRuntime = fs.existsSync(runtimePath)
      ? fs.readFileSync(runtimePath)
      : null;
    try {
      const result = runCli(['install', '--no-ui'], { XDG_RUNTIME_DIR: '' });
      expect(result.status).toBe(0);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpHome, 'admin.json'), 'utf8'));
      expect(onDisk.socketDir).toBe('/tmp/pgserve');
      expect(fs.statSync('/tmp/pgserve').mode & 0o777).toBe(0o700);
    } finally {
      if (previousRuntime) fs.writeFileSync(runtimePath, previousRuntime);
      else fs.rmSync(runtimePath, { force: true });
    }
  });
});

describe('serve alias', () => {
  test('pgserve serve --bogus-flag re-routes to postmaster (singleton v2.4)', () => {
    // pgserve singleton (v2.4): the bun-proxy daemon is gone. `serve` now
    // aliases to `postmaster` via bin/autopg-wrapper.cjs. We can't fully
    // exercise the postmaster without postgres binaries on PATH, so we
    // just verify the wrapper proceeded past the install short-circuit
    // (stderr will be a bun probe error or a postmaster-mode error, never
    // an install-module error).
    const result = spawnSync('node', [BIN, 'serve', '--bogus-flag'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PGSERVE_CONFIG_DIR: tmpHome,
        PATH: `${stubBin.dir}:${process.env.PATH}`,
      },
    });
    expect(result.stderr).not.toContain('pgserve: not installed');
    expect(result.stderr).not.toContain('pm2 not found');
  });
});
