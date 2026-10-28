/**
 * Managed superuser password resolution for the postmaster
 * (src/lib/postmaster-password.js).
 *
 * Locks the contract that fixed the omni k8s node-restart incident
 * (2026-07-03): PostgresManager always supported `options.password`
 * (initdb --pwfile + the TCP admin pool), but the postmaster entry never
 * wired it — so a supervisor-rotated superuser password crash-looped the
 * postmaster on every restart. The resolver reads the documented env
 * chain from settings-schema.cjs `server.pgPassword`.
 */

import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolvePostmasterPassword,
  readPasswordFile,
  POSTMASTER_PASSWORD_ENV_VARS,
  DEFAULT_POSTMASTER_PASSWORD,
} from '../../src/lib/postmaster-password.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POSTGRES_SERVER = path.join(REPO_ROOT, 'bin', 'postgres-server.js');

/** A throwaway secret made at run time, so no test holds a literal one. */
function fakeSecret(label) {
  return `${label}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

describe('resolvePostmasterPassword', () => {
  test('defaults to the built-in password with an empty environment', () => {
    expect(resolvePostmasterPassword({})).toEqual({
      password: DEFAULT_POSTMASTER_PASSWORD,
      source: 'default',
    });
  });

  test('AUTOPG_PG_PASSWORD supplies the managed password', () => {
    expect(resolvePostmasterPassword({ AUTOPG_PG_PASSWORD: 's3cret' })).toEqual({
      password: 's3cret',
      source: 'AUTOPG_PG_PASSWORD',
    });
  });

  test('PGSERVE_PG_PASSWORD is honored as the legacy alias', () => {
    expect(resolvePostmasterPassword({ PGSERVE_PG_PASSWORD: 'legacy' })).toEqual({
      password: 'legacy',
      source: 'PGSERVE_PG_PASSWORD',
    });
  });

  test('AUTOPG_PG_PASSWORD wins over the legacy alias (schema env order)', () => {
    const env = { AUTOPG_PG_PASSWORD: 'new', PGSERVE_PG_PASSWORD: 'old' };
    expect(resolvePostmasterPassword(env).password).toBe('new');
  });

  test('empty-string env vars are treated as unset (cannot blank the pool password)', () => {
    const env = { AUTOPG_PG_PASSWORD: '', PGSERVE_PG_PASSWORD: '' };
    expect(resolvePostmasterPassword(env)).toEqual({
      password: DEFAULT_POSTMASTER_PASSWORD,
      source: 'default',
    });
  });

  test('env chain matches the settings-schema documented names', () => {
    expect(POSTMASTER_PASSWORD_ENV_VARS).toEqual(['AUTOPG_PG_PASSWORD', 'PGSERVE_PG_PASSWORD']);
  });
});

describe('postmaster --help documents the managed password env', () => {
  test('help text advertises AUTOPG_PG_PASSWORD and the legacy alias', () => {
    const result = spawnSync(process.execPath, [POSTGRES_SERVER, 'postmaster', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.stdout).toContain('AUTOPG_PG_PASSWORD');
    expect(result.stdout).toContain('PGSERVE_PG_PASSWORD');
  });
});

describe('readPasswordFile', () => {
  const content = fakeSecret('file');
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pwfile-unit-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name, text, mode = 0o600) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode });
    fs.chmodSync(file, mode);
    return file;
  }

  function refusal(file) {
    try {
      readPasswordFile(file);
    } catch (err) {
      return err.message;
    }
    return null;
  }

  test('reads the password and drops one trailing newline', () => {
    expect(readPasswordFile(write('a', `${content}\n`))).toBe(content);
    expect(readPasswordFile(write('b', `${content}\r\n`))).toBe(content);
    expect(readPasswordFile(write('c', content))).toBe(content);
  });

  test('refuses a relative path', () => {
    write('rel', `${content}\n`);
    expect(refusal('rel')).toContain('absolute');
  });

  test('refuses a missing file', () => {
    expect(refusal(path.join(dir, 'missing'))).toContain('cannot read');
  });

  test('refuses a symlink', () => {
    const target = write('target', `${content}\n`);
    const link = path.join(dir, 'link');
    fs.symlinkSync(target, link);
    expect(refusal(link)).toContain('symlink');
  });

  test('refuses a directory', () => {
    expect(refusal(dir)).toContain('regular file');
  });

  test('refuses a FIFO without blocking on it', () => {
    const fifo = path.join(dir, 'fifo');
    expect(spawnSync('mkfifo', ['-m', '600', fifo]).status).toBe(0);
    expect(refusal(fifo)).toContain('regular file');
  });

  test('opens the path once and checks and reads what it opened', () => {
    const file = write('once', `${content}\n`);
    const spies = ['openSync', 'lstatSync', 'statSync', 'readFileSync'].map((name) => spyOn(fs, name));
    const [open, lstat, stat, read] = spies;
    try {
      expect(readPasswordFile(file)).toBe(content);
      expect(open.mock.calls.filter(([target]) => target === file)).toHaveLength(1);
      expect(lstat).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.every(([target]) => typeof target === 'number')).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test.each([0o644, 0o640, 0o604, 0o660])('refuses mode %o', (mode) => {
    expect(refusal(write(`m${mode}`, `${content}\n`, mode))).toContain('0600');
  });

  test('refuses an empty file', () => {
    expect(refusal(write('empty', ''))).toContain('empty');
    expect(refusal(write('nl', '\n'))).toContain('empty');
  });

  test('refuses more than one line', () => {
    expect(refusal(write('two', `${content}\nsecond\n`))).toContain('one line');
  });

  test('no refusal echoes the content', () => {
    const files = [
      write('m644', `${content}\n`, 0o644),
      write('two2', `${content}\nsecond\n`),
    ];
    for (const file of files) {
      expect(refusal(file)).not.toContain(content);
    }
  });
});

describe('postmaster --password-file refusals', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pwfile-cli-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function postmaster(args, env = {}) {
    return spawnSync(
      process.execPath,
      [POSTGRES_SERVER, 'postmaster', '--port', '1', '--data', path.join(dir, 'data'),
        '--socket-dir', path.join(dir, 'sock'), ...args],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH, HOME: dir, AUTOPG_CONFIG_DIR: path.join(dir, 'config'), ...env },
      },
    );
  }

  test('a world-readable file stops the postmaster before anything starts', () => {
    const file = path.join(dir, 'pw');
    const fileSecret = fakeSecret('cli');
    fs.writeFileSync(file, `${fileSecret}\n`, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const result = postmaster(['--password-file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('0600');
    expect(result.stdout + result.stderr).not.toContain(fileSecret);
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
  });

  test('--password-file together with a password env var is refused', () => {
    const file = path.join(dir, 'pw');
    const fileSecret = fakeSecret('cli');
    const envSecret = fakeSecret('env');
    fs.writeFileSync(file, `${fileSecret}\n`, { mode: 0o600 });
    const result = postmaster(['--password-file', file], { AUTOPG_PG_PASSWORD: envSecret });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AUTOPG_PG_PASSWORD');
    expect(result.stdout + result.stderr).not.toContain(fileSecret);
    expect(result.stdout + result.stderr).not.toContain(envSecret);
  });

  test('--password-file needs a value', () => {
    const result = postmaster(['--password-file']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--password-file');
  });

  test('help text documents --password-file', () => {
    const result = spawnSync(process.execPath, [POSTGRES_SERVER, 'postmaster', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.stdout).toContain('--password-file');
  });
});
