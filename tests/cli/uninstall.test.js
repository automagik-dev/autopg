/**
 * Tests for `src/commands/uninstall.js` — the `autopg uninstall` surface.
 *
 * Group 1 of the canonical-pgserve-pm2-supervision wish.
 *
 * Strategy: drive the CLI binary against a stub `pm2` on PATH so
 * `pm2 jlist` / `pm2 delete` calls are observable but no real daemon is
 * spawned. Same harness as `tests/cli-install.test.js` so behavior matches
 * the install side of the surface.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseUninstallArgs } from '../../src/commands/uninstall.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs');

let tmpHome;
let stubBin;
let originalConfigDir;
let originalPath;

function makeStubPm2() {
  // Stub script that:
  //   - records every invocation as a JSON line in calls.log
  //   - supports `--version`, `jlist`, `start`, `delete`
  //   - tracks per-process state via sentinel files (one per `--name`)
  //
  // `start` writes a sentinel file `<dir>/registered-<name>` so subsequent
  // `jlist` / `delete` calls see the process. `delete` removes the sentinel
  // (and exits non-zero when the sentinel is missing — pm2's real behavior
  // for `pm2 delete <missing>` — to verify the uninstall path treats that
  // as idempotent).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-stub-pm2-'));
  const callLog = path.join(dir, 'calls.log');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');

if (args[0] === '--version') {
  process.stdout.write('5.0.0-stub\\n');
  process.exit(0);
}

const dir = ${JSON.stringify(dir)};
function sentinelOf(name) { return path.join(dir, 'registered-' + name); }

if (args[0] === 'jlist') {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('registered-')) continue;
    const name = f.slice('registered-'.length);
    out.push({
      name,
      pid: 12345,
      pm2_env: { status: 'online', pm_uptime: Date.now() - 1000, restart_time: 0 },
    });
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.exit(0);
}

if (args[0] === 'start') {
  // pm2 start uses --name <NAME>; capture it for sentinel tracking.
  const i = args.indexOf('--name');
  const name = i >= 0 ? args[i + 1] : 'unknown';
  fs.writeFileSync(sentinelOf(name), '');
  process.exit(0);
}

if (args[0] === 'delete') {
  const name = args[1];
  const s = sentinelOf(name);
  if (fs.existsSync(s)) {
    fs.unlinkSync(s);
    process.exit(0);
  }
  process.exit(1); // pm2 delete <missing> exits non-zero
}

process.exit(0);
`;
  const pm2Path = path.join(dir, 'pm2');
  fs.writeFileSync(pm2Path, script, { mode: 0o755 });
  return { dir, calls: callLog };
}

function readCallLog(callsPath) {
  if (!fs.existsSync(callsPath)) return [];
  return fs.readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function runCli(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOPG_CONFIG_DIR: tmpHome,
      PATH: `${stubBin.dir}:${process.env.PATH}`,
      // Skip the B3 port-preflight (v2.6.1) so tests that don't pin a
      // free `--port` don't race host-level services on 5432. Tests
      // that exercise the B3 contract live in cli-install.test.js and
      // unset this explicitly.
      PGSERVE_TEST_SKIP_PORT_PREFLIGHT: '1',
      ...env,
    },
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-cfg-'));
  stubBin = makeStubPm2();
  originalConfigDir = process.env.AUTOPG_CONFIG_DIR;
  originalPath = process.env.PATH;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (stubBin?.dir) fs.rmSync(stubBin.dir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.AUTOPG_CONFIG_DIR;
  else process.env.AUTOPG_CONFIG_DIR = originalConfigDir;
  process.env.PATH = originalPath;
});

function seedAdminJson(record) {
  fs.mkdirSync(tmpHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(tmpHome, 'admin.json'),
    JSON.stringify(record, null, 2) + '\n',
    { mode: 0o600 },
  );
}

function readAdminJsonOnDisk() {
  const file = path.join(tmpHome, 'admin.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('autopg uninstall — pm2 teardown', () => {
  test('removes both autopg-server and autopg-ui pm2 entries', () => {
    // Pre-register both processes via the stub (cheaper than running install).
    spawnSync(path.join(stubBin.dir, 'pm2'), ['start', '/dev/null', '--name', 'autopg-server']);
    spawnSync(path.join(stubBin.dir, 'pm2'), ['start', '/dev/null', '--name', 'autopg-ui']);

    const result = runCli(['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('uninstalled');
    expect(result.stdout).toContain('autopg-server');
    expect(result.stdout).toContain('autopg-ui');

    const calls = readCallLog(stubBin.calls);
    const deletes = calls.filter((c) => c[0] === 'delete').map((c) => c[1]);
    expect(deletes).toContain('autopg-server');
    expect(deletes).toContain('autopg-ui');
  });

  test('preserves the data dir under ~/.autopg/data', () => {
    fs.mkdirSync(path.join(tmpHome, 'data'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tmpHome, 'data', 'pgdata-marker'), 'keep-me');
    spawnSync(path.join(stubBin.dir, 'pm2'), ['start', '/dev/null', '--name', 'autopg-server']);

    runCli(['uninstall', '--yes']);

    expect(fs.existsSync(path.join(tmpHome, 'data', 'pgdata-marker'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpHome, 'data', 'pgdata-marker'), 'utf8')).toBe('keep-me');
  });
});

describe('autopg uninstall — admin.json supervisor clear', () => {
  test('clears supervisor fields when admin.json records supervisor=pm2', () => {
    seedAdminJson({
      supervisor: 'pm2',
      socketDir: '/run/user/1000/pgserve',
      port: 5432,
      installedAt: '2026-05-08T07:30:00.000Z',
      // Auth surface from cli-install.cjs's writeAdminFile — must be
      // preserved so a re-install can keep the same admin password.
      scheme: 'scrypt',
      salt: 'AAAA',
      hash: 'BBBB',
      createdAt: '2026-05-08T07:30:00.000Z',
      rotatedAt: null,
    });

    const result = runCli(['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cleared supervisor record');

    const onDisk = readAdminJsonOnDisk();
    expect(onDisk).not.toBeNull();
    // Supervisor fields gone.
    expect(onDisk.supervisor).toBeUndefined();
    expect(onDisk.socketDir).toBeUndefined();
    expect(onDisk.port).toBeUndefined();
    expect(onDisk.installedAt).toBeUndefined();
    // Auth fields preserved.
    expect(onDisk.scheme).toBe('scrypt');
    expect(onDisk.salt).toBe('AAAA');
    expect(onDisk.hash).toBe('BBBB');
    expect(onDisk.createdAt).toBe('2026-05-08T07:30:00.000Z');
  });

  test('removes admin.json entirely when only supervisor fields were present', () => {
    seedAdminJson({
      supervisor: 'pm2',
      socketDir: '/tmp/pgserve',
      port: 5432,
      installedAt: '2026-05-08T07:30:00.000Z',
    });
    const result = runCli(['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, 'admin.json'))).toBe(false);
  });

  test('leaves admin.json untouched when no supervisor fields are present', () => {
    seedAdminJson({
      scheme: 'scrypt',
      salt: 'AAAA',
      hash: 'BBBB',
      createdAt: '2026-05-08T07:30:00.000Z',
      rotatedAt: null,
    });
    const before = readAdminJsonOnDisk();
    runCli(['uninstall', '--yes']);
    const after = readAdminJsonOnDisk();
    expect(after).toEqual(before);
  });
});

describe('autopg uninstall — idempotency', () => {
  test('first run removes pm2 entries and supervisor record; second run is a no-op success', () => {
    spawnSync(path.join(stubBin.dir, 'pm2'), ['start', '/dev/null', '--name', 'autopg-server']);
    spawnSync(path.join(stubBin.dir, 'pm2'), ['start', '/dev/null', '--name', 'autopg-ui']);
    seedAdminJson({
      supervisor: 'pm2',
      socketDir: '/tmp/pgserve',
      port: 5432,
      installedAt: '2026-05-08T07:30:00.000Z',
    });

    const first = runCli(['uninstall', '--yes']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('uninstalled');

    const second = runCli(['uninstall', '--yes']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('not registered');
    expect(second.stdout).toContain('nothing to uninstall');
  });

  test('uninstall on a clean host (no pm2 entries, no admin.json) exits 0 with diagnostic', () => {
    const result = runCli(['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not registered');
    expect(result.stdout).toContain('nothing to uninstall');
  });
});

describe('autopg uninstall — install round-trip (no Tier-B-refusal false positive)', () => {
  test('after uninstall, a subsequent install (--no-pm2) succeeds and re-records pm2-class supervisor', () => {
    seedAdminJson({
      supervisor: 'pm2',
      socketDir: '/tmp/pgserve',
      port: 5432,
      installedAt: '2026-05-08T07:30:00.000Z',
    });
    runCli(['uninstall', '--yes']);

    // --no-pm2 keeps the install fully hermetic (no real pm2 register
    // needed) and still exercises the assertSupervisor path. On a clean
    // admin.json (uninstall just cleared it), the install must NOT refuse.
    const result = runCli(['install', '--no-pm2', '--no-ui'], {
      XDG_RUNTIME_DIR: tmpHome,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('supervisor=external');

    const onDisk = readAdminJsonOnDisk();
    expect(onDisk).not.toBeNull();
    expect(onDisk.supervisor).toBe('external');
  });
});

describe('autopg uninstall — audit log', () => {
  test('appends one JSONL entry with event=autopg_uninstall to <configDir>/audit.log', () => {
    spawnSync(path.join(stubBin.dir, 'pm2'), ['start', '/dev/null', '--name', 'autopg-server']);
    runCli(['uninstall', '--yes']);

    const auditFile = path.join(tmpHome, 'audit.log');
    expect(fs.existsSync(auditFile)).toBe(true);
    const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.event).toBe('autopg_uninstall');
    expect(last.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(last.pm2Available).toBe(true);
    expect(Array.isArray(last.pm2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #146: `autopg uninstall --help` executed the uninstall (args were
// dropped at the dispatcher) and took down a live postmaster. `--help`,
// bad flags and the confirmation gate must all return BEFORE any pm2 call.
// runCli() spawns with piped stdio, so every test below is non-TTY.
// ---------------------------------------------------------------------------

describe('autopg uninstall — --help never touches pm2 (issue #146)', () => {
  const SUPERVISOR = { supervisor: 'pm2', socketDir: '/tmp/x', port: 8432, installedAt: 'now' };

  test('--help prints usage, exits 0, makes no pm2 call, leaves admin.json alone', () => {
    seedAdminJson(SUPERVISOR);
    const result = runCli(['uninstall', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: autopg uninstall');
    expect(result.stdout).toContain('--yes');
    expect(readCallLog(stubBin.calls)).toEqual([]);
    expect(readAdminJsonOnDisk()).toEqual(SUPERVISOR);
  });

  test('-h is an alias for --help', () => {
    const result = runCli(['uninstall', '-h']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: autopg uninstall');
    expect(readCallLog(stubBin.calls)).toEqual([]);
  });

  test('--help wins even when combined with --yes', () => {
    seedAdminJson(SUPERVISOR);
    const result = runCli(['uninstall', '--yes', '--help']);
    expect(result.status).toBe(0);
    expect(readCallLog(stubBin.calls)).toEqual([]);
    expect(readAdminJsonOnDisk()).toEqual(SUPERVISOR);
  });

  test('unknown flag prints usage on stderr, exits 2, makes no pm2 call', () => {
    seedAdminJson(SUPERVISOR);
    const result = runCli(['uninstall', '--nuke']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option --nuke');
    expect(result.stderr).toContain('Usage: autopg uninstall');
    expect(result.stdout).toBe('');
    expect(readCallLog(stubBin.calls)).toEqual([]);
    expect(readAdminJsonOnDisk()).toEqual(SUPERVISOR);
  });
});

describe('autopg uninstall — confirmation gate', () => {
  const SUPERVISOR = { supervisor: 'pm2', socketDir: '/tmp/x', port: 8432, installedAt: 'now' };

  test('non-TTY without --yes exits 2 with a --yes hint and tears nothing down', () => {
    runCli(['install', '--port', '18432']);
    seedAdminJson(SUPERVISOR);
    fs.writeFileSync(path.join(stubBin.dir, 'registered-autopg-server'), '');
    const before = readCallLog(stubBin.calls).length;

    const result = runCli(['uninstall']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--yes');
    expect(result.stderr).toContain('data dir preserved');

    const after = readCallLog(stubBin.calls).slice(before);
    expect(after.filter((c) => c[0] === 'delete')).toEqual([]);
    expect(fs.existsSync(path.join(stubBin.dir, 'registered-autopg-server'))).toBe(true);
    expect(readAdminJsonOnDisk()).toEqual(SUPERVISOR);
  });

  test('--yes runs the existing teardown path', () => {
    seedAdminJson(SUPERVISOR);
    fs.writeFileSync(path.join(stubBin.dir, 'registered-autopg-server'), '');
    const result = runCli(['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('uninstalled pm2 entries: autopg-server');
    expect(readCallLog(stubBin.calls).some((c) => c[0] === 'delete' && c[1] === 'autopg-server')).toBe(true);
    expect(readAdminJsonOnDisk()).toBeNull();
  });

  test('-y is an alias for --yes', () => {
    seedAdminJson(SUPERVISOR);
    const result = runCli(['uninstall', '-y']);
    expect(result.status).toBe(0);
    expect(readAdminJsonOnDisk()).toBeNull();
  });
});

describe('parseUninstallArgs (pure)', () => {
  test('recognises help / yes and their short aliases', () => {
    expect(parseUninstallArgs([])).toEqual({ help: false, yes: false, unknown: [] });
    expect(parseUninstallArgs(['--help'])).toEqual({ help: true, yes: false, unknown: [] });
    expect(parseUninstallArgs(['-h'])).toEqual({ help: true, yes: false, unknown: [] });
    expect(parseUninstallArgs(['--yes'])).toEqual({ help: false, yes: true, unknown: [] });
    expect(parseUninstallArgs(['-y'])).toEqual({ help: false, yes: true, unknown: [] });
  });

  test('collects unknown tokens', () => {
    expect(parseUninstallArgs(['--force', 'extra'])).toEqual({ help: false, yes: false, unknown: ['--force', 'extra'] });
  });
});
