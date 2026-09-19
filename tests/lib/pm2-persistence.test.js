import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  comparePm2Persistence,
  getPm2DumpPath,
  inspectPm2Persistence,
  persistPm2Registrations,
  readPm2Dump,
} = require('../../src/lib/pm2-persistence.cjs');

const NAME = 'autopg-server';

function pm2Env(overrides = {}) {
  return {
    pm_exec_path: '/opt/autopg/bin/postgres-server.js',
    args: ['postmaster', '--port', '8432', '--data', '/data', '--socket-dir', '/run/pgserve'],
    exec_interpreter: 'none',
    max_restarts: 50,
    restart_delay: 2000,
    exp_backoff_restart_delay: 100,
    max_memory_restart: 4294967296,
    kill_timeout: 60000,
    ...overrides,
  };
}

function live(overrides) {
  return { name: NAME, pid: 4242, pm2_env: { status: 'online', ...pm2Env(overrides) } };
}

function dumpOf(...entries) {
  return { file: '/x/dump.pm2', exists: true, entries, error: null };
}

const NO_DUMP = { file: '/x/dump.pm2', exists: false, entries: [], error: null };

describe('comparePm2Persistence', () => {
  test('a live entry missing from an existing dump is not persisted', () => {
    const state = comparePm2Persistence(NAME, live(), dumpOf({ name: 'omni-api' }));
    expect(state.persisted).toBe(false);
    expect(state.reason).toContain('missing from dump.pm2');
  });

  test('a live entry with no dump at all is not persisted', () => {
    const state = comparePm2Persistence(NAME, live(), NO_DUMP);
    expect(state.persisted).toBe(false);
    expect(state.reason).toContain('no dump.pm2 exists');
  });

  test('matching live and saved entries are persisted', () => {
    const state = comparePm2Persistence(NAME, live(), dumpOf({ name: NAME, ...pm2Env() }));
    expect(state).toEqual({ persisted: true, reason: null, differences: [] });
  });

  test('a saved entry on another port is reported by field', () => {
    const saved = { name: NAME, ...pm2Env({ args: ['postmaster', '--port', '5432'] }) };
    const state = comparePm2Persistence(NAME, live(), dumpOf(saved));
    expect(state.persisted).toBe(false);
    expect(state.differences).toEqual(['args']);
  });

  test('changed supervision limits are reported by field', () => {
    const saved = { name: NAME, ...pm2Env({ max_restarts: 10, max_memory_restart: 1 }) };
    const state = comparePm2Persistence(NAME, live(), dumpOf(saved));
    expect(state.differences).toEqual(['max_restarts', 'max_memory_restart']);
  });

  test('an entry that is saved but no longer live is not persisted (stale dump)', () => {
    const state = comparePm2Persistence(NAME, null, dumpOf({ name: NAME, ...pm2Env() }));
    expect(state.persisted).toBe(false);
    expect(state.reason).toContain('not registered with pm2');
  });

  test('absent from both pm2 and the dump is consistent', () => {
    expect(comparePm2Persistence(NAME, null, NO_DUMP).persisted).toBe(true);
  });

  test('an unreadable dump is never treated as persisted', () => {
    const broken = { file: '/x/dump.pm2', exists: true, entries: [], error: 'dump.pm2 is not valid JSON' };
    expect(comparePm2Persistence(NAME, live(), broken).persisted).toBe(false);
  });
});

describe('dump on disk', () => {
  let pm2Home;
  let env;

  beforeEach(() => {
    pm2Home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pm2home-'));
    env = { PM2_HOME: pm2Home };
  });

  afterEach(() => {
    fs.rmSync(pm2Home, { recursive: true, force: true });
  });

  test('reads dump.pm2 from PM2_HOME, never the real ~/.pm2', () => {
    expect(getPm2DumpPath(env)).toBe(path.join(pm2Home, 'dump.pm2'));
    expect(readPm2Dump(env)).toEqual({ file: path.join(pm2Home, 'dump.pm2'), exists: false, entries: [], error: null });
  });

  test('reports malformed JSON instead of throwing', () => {
    fs.writeFileSync(path.join(pm2Home, 'dump.pm2'), '{not json');
    const dump = readPm2Dump(env);
    expect(dump.exists).toBe(true);
    expect(dump.error).toContain('not valid JSON');
  });

  test('persistPm2Registrations saves once, then is a no-op when nothing changed', () => {
    fs.writeFileSync(path.join(pm2Home, 'dump.pm2'), JSON.stringify([{ name: 'omni-api' }]));
    let saves = 0;
    const save = () => {
      saves += 1;
      fs.writeFileSync(
        path.join(pm2Home, 'dump.pm2'),
        JSON.stringify([{ name: 'omni-api' }, { name: NAME, ...pm2Env() }]),
      );
      return { ok: true, reason: null };
    };
    const getProcess = (name) => (name === NAME ? live() : null);

    expect(persistPm2Registrations([NAME, 'autopg-ui'], { env, getProcess, save })).toEqual({
      saved: true,
      ok: true,
      reasons: [],
    });
    expect(persistPm2Registrations([NAME, 'autopg-ui'], { env, getProcess, save })).toEqual({
      saved: false,
      ok: true,
      reasons: [],
    });
    expect(saves).toBe(1);
    expect(inspectPm2Persistence(NAME, { env, getProcess }).persisted).toBe(true);
  });

  test('a save that does not capture the entry is reported as a failure', () => {
    const getProcess = (name) => (name === NAME ? live() : null);
    const result = persistPm2Registrations([NAME], { env, getProcess, save: () => ({ ok: true, reason: null }) });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('no dump.pm2 exists');
  });

  test('a failing pm2 save is reported with its reason', () => {
    const getProcess = (name) => (name === NAME ? live() : null);
    const result = persistPm2Registrations([NAME], {
      env,
      getProcess,
      save: () => ({ ok: false, reason: 'EACCES' }),
    });
    expect(result).toEqual({ saved: false, ok: false, reasons: ['pm2 save failed: EACCES'] });
  });
});
