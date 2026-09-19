/**
 * Regression tests for the `autopg update` case of `dispatch()` in
 * src/cli-install.cjs — issue #160.
 *
 * Every v3.2.0 tarball's `autopg update` died with
 *   Cannot find module '/home/runner/work/autopg/autopg/src/update/index.js'
 *   from '/$bunfs/root/autopg'
 * because the dispatcher built the import specifier at runtime
 * (`path.join(__dirname, 'update', 'index.js')`). `bun build --compile`
 * cannot bundle a computed specifier, so the binary carried the build
 * runner's `__dirname` and resolved it on the operator's host. Two more
 * defects rode along: `--help` was not recognised, so `autopg update --help`
 * ran all seven migration steps (the #146 class of bug), and the verb
 * called `process.exit` itself instead of returning its code.
 *
 * Strategy: (1) a source-level scan that keeps every dynamic import in the
 * dispatcher a string literal; (2) in-process `dispatch('update', …)` with
 * `src/update/index.js` mocked, covering `--help`, the ok/fail return codes
 * and the `.catch` path; (3) the wrapper end to end for `--help`.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_INSTALL = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
const UPDATE_MODULE = path.join(REPO_ROOT, 'src', 'update', 'index.js');
const WRAPPER = path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs');

// ---------------------------------------------------------------------------
// (1) Source scan. `bun build --compile` only bundles `import('<literal>')`;
// anything computed (`import(require(…))`, `import(path.join(…))`, a
// template literal with substitutions) compiles fine and fails on every
// host that is not the build machine. Comments are stripped first so the
// explanatory notes in the dispatcher cannot trip the scan.
// ---------------------------------------------------------------------------

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('src/cli-install.cjs dynamic imports are bundleable (issue #160)', () => {
  const code = stripComments(fs.readFileSync(CLI_INSTALL, 'utf8'));

  test('no import() specifier is computed via require() or path.join()', () => {
    expect(code).not.toMatch(/\bimport\(\s*require\(/);
    expect(code).not.toMatch(/\bimport\(\s*(?:path|require\(['"]node:path['"]\))\.join\(/);
    expect(code).not.toMatch(/\bimport\([^)]*__dirname/);
  });

  test('every import() specifier is a plain string literal', () => {
    const specifiers = [...code.matchAll(/\bimport\(\s*([^\s)])/g)].map((m) => m[1]);
    // Sanity: the dispatcher does use dynamic imports (uninstall, doctor,
    // update, verify, …) — an empty match set would mean the scan broke.
    expect(specifiers.length).toBeGreaterThan(5);
    for (const first of specifiers) {
      expect(["'", '"']).toContain(first);
    }
  });

  test('the update verb imports ./update/index.js by literal', () => {
    expect(code).toMatch(/\bimport\(\s*['"]\.\/update\/index\.js['"]\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// (2) In-process dispatch with the migration module mocked. The mock lets
// each test choose what `update()` does without touching a postmaster.
// ---------------------------------------------------------------------------

const updateMock = mock(async () => ({ ok: true, results: [], summary: 'mocked' }));
mock.module(UPDATE_MODULE, () => ({ update: updateMock }));

describe('dispatch("update", …) in process (issue #160)', () => {
  let cli;
  let tmpHome;
  let stdoutChunks;
  let stderrChunks;
  let originalStdoutWrite;
  let originalStderrWrite;
  let originalConfigDir;
  let originalExitCode;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-update-dispatch-'));
    // Set BEFORE requiring: `ensureMigrationOnce()` skips the ~/.pgserve →
    // ~/.autopg migration when a config-dir override is present, so the
    // dispatcher never looks at the developer's real home.
    originalConfigDir = process.env.AUTOPG_CONFIG_DIR;
    process.env.AUTOPG_CONFIG_DIR = tmpHome;
    originalExitCode = process.exitCode;
    cli = require(CLI_INSTALL);
    updateMock.mockClear();
    updateMock.mockImplementation(async () => ({ ok: true, results: [], summary: 'mocked' }));
    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    // The .catch path sets process.exitCode = 1 on purpose; do not let it
    // leak into the test runner's own exit status. Bun ignores an
    // assignment of `undefined` here, so reset to 0 explicitly.
    process.exitCode = originalExitCode ?? 0;
    if (originalConfigDir === undefined) delete process.env.AUTOPG_CONFIG_DIR;
    else process.env.AUTOPG_CONFIG_DIR = originalConfigDir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('--help prints usage to stdout, returns 0 and never loads the migration', () => {
    const result = cli.dispatch('update', ['--help'], {});
    expect(result).toBe(0);
    const out = stdoutChunks.join('');
    expect(out).toContain('Usage:');
    expect(out).toContain('autopg update');
    expect(out).toContain('--dry-run');
    expect(out).toContain('--skip-steps');
    expect(updateMock).not.toHaveBeenCalled();
    expect(stderrChunks).toEqual([]);
  });

  test('-h is an alias for --help, even alongside other flags', () => {
    expect(cli.dispatch('update', ['--dry-run', '-h'], {})).toBe(0);
    expect(stdoutChunks.join('')).toContain('Usage:');
    expect(updateMock).not.toHaveBeenCalled();
  });

  test('resolves 0 when every step passed and forwards the parsed options', async () => {
    const code = await cli.dispatch('update', ['--quiet', '--dry-run', '--skip-steps', 'a,b'], {});
    expect(code).toBe(0);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0]).toEqual({ quiet: true, dryRun: true, skipSteps: ['a', 'b'] });
    expect(process.exitCode ?? 0).toBe(0);
  });

  test('resolves 1 when the migration reports a failed step', async () => {
    updateMock.mockImplementation(async () => ({ ok: false, results: [], summary: 'mocked fail' }));
    const code = await cli.dispatch('update', [], {});
    expect(code).toBe(1);
  });

  test('a load or runtime error resolves 1 with the reason on stderr (never exit 0)', async () => {
    updateMock.mockImplementation(async () => {
      throw new Error("Cannot find module '/home/runner/work/autopg/autopg/src/update/index.js' from '/$bunfs/root/autopg'");
    });
    const code = await cli.dispatch('update', [], {});
    expect(code).toBe(1);
    expect(process.exitCode).toBe(1);
    const err = stderrChunks.join('');
    expect(err).toContain('autopg update: Cannot find module');
    expect(err).toContain('/$bunfs/root/autopg');
  });
});

// ---------------------------------------------------------------------------
// (3) End to end through the npm wrapper: the real dispatcher, real update
// module on disk, but `--help` must return before any step runs. The
// consumer-signal step is the tell — it writes <configDir>/state/
// upgrade.signal, which is exactly what a `--help` that ran the migration
// left behind.
// ---------------------------------------------------------------------------

describe('autopg update --help through bin/autopg-wrapper.cjs (issue #160)', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-update-wrapper-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function runCli(args) {
    return spawnSync('node', [WRAPPER, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTOPG_CONFIG_DIR: tmpHome,
        XDG_RUNTIME_DIR: path.join(tmpHome, 'runtime'),
        PM2_HOME: path.join(tmpHome, 'pm2'),
      },
    });
  }

  test('--help prints usage, exits 0 and runs no migration step', () => {
    const result = runCli(['update', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('autopg update');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(path.join(tmpHome, 'state', 'upgrade.signal'))).toBe(false);
  });
});
