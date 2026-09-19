/**
 * Regression guard for #159: `autopg doctor` in the compiled v3.2.0 tarball
 * died with "Cannot find module '../lib/service-state.cjs' from
 * '/$bunfs/root/autopg'".
 *
 * Cause: src/commands/doctor.js and uninstall.js loaded in-repo CJS libs via
 * `createRequire(import.meta.url)` + `require('../lib/x.cjs')`. `bun build
 * --compile` cannot see through createRequire, so those modules were never
 * bundled and the path was resolved at runtime inside the binary's virtual
 * /$bunfs, where it does not exist. A static `import ... from '../lib/x.cjs'`
 * is bundled like any other module.
 *
 * This runs against the source tree (no compile needed) so CI catches a
 * reintroduction long before the tarball smoke test would.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_DIRS = ['src/commands', 'src/lib'];

function listSourceFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listSourceFiles(full);
      return /\.(c|m)?js$/.test(entry.name) ? [full] : [];
    });
}

describe('bundled-binary safety (#159)', () => {
  for (const rel of SCANNED_DIRS) {
    test(`no createRequire() under ${rel}`, () => {
      const files = listSourceFiles(path.join(REPO_ROOT, rel));
      expect(files.length).toBeGreaterThan(0);
      const offenders = files.filter((f) => fs.readFileSync(f, 'utf8').includes('createRequire('));
      expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
    });
  }
});
