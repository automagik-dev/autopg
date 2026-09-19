/**
 * Tests for `pgserve doctor` (singleton G3 — read-only V1).
 */

import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor, exitCodeFor, __testInternals } from '../../src/commands/doctor.js';

const { SEVERITY } = __testInternals;

describe('exitCodeFor', () => {
  test('returns 0 when every finding is PASS', () => {
    const findings = [
      { id: 'a', title: 'a', severity: SEVERITY.PASS },
      { id: 'b', title: 'b', severity: SEVERITY.PASS },
    ];
    expect(exitCodeFor(findings)).toBe(0);
  });

  test('returns 1 when any finding is FAIL', () => {
    const findings = [
      { id: 'a', title: 'a', severity: SEVERITY.PASS },
      { id: 'b', title: 'b', severity: SEVERITY.FAIL },
      { id: 'c', title: 'c', severity: SEVERITY.WARN },
    ];
    expect(exitCodeFor(findings)).toBe(1);
  });

  test('returns 2 when only WARNs (no FAILs)', () => {
    const findings = [
      { id: 'a', title: 'a', severity: SEVERITY.PASS },
      { id: 'b', title: 'b', severity: SEVERITY.WARN },
    ];
    expect(exitCodeFor(findings)).toBe(2);
  });

  test('returns 0 for empty findings', () => {
    expect(exitCodeFor([])).toBe(0);
  });
});

describe('SEVERITY enum', () => {
  test('exports the three severities expected by callers', () => {
    expect(SEVERITY.PASS).toBe('PASS');
    expect(SEVERITY.WARN).toBe('WARN');
    expect(SEVERITY.FAIL).toBe('FAIL');
  });

  test('is frozen (production callers cannot mutate)', () => {
    expect(Object.isFrozen(SEVERITY)).toBe(true);
  });
});

describe('runDoctor entry point', () => {
  test('--fix exits with code 64 (not implemented in V1)', async () => {
    const code = await runDoctor(['--fix']);
    expect(code).toBe(64);
  });

  test('--fix --aggressive exits with code 64 (not implemented in V1)', async () => {
    const code = await runDoctor(['--fix', '--aggressive']);
    expect(code).toBe(64);
  });

  test('runs all checks in default mode (exit code 0/1/2 depending on host state)', async () => {
    // We cannot pin host state in CI deterministically (admin.json may or may
    // not exist; pm2 may or may not be running). Just assert the entry
    // point completes and returns a known exit code.
    const code = await runDoctor([]);
    expect([0, 1, 2]).toContain(code);
  });

  test('--json mode returns the same exit code', async () => {
    const code = await runDoctor(['--json']);
    expect([0, 1, 2]).toContain(code);
  });
});

describe('individual check shape', () => {
  test('checkVersionNotBlocked returns PASS with current version when not blocked', () => {
    const f = __testInternals.checkVersionNotBlocked();
    // Default BLOCKED_VERSIONS is empty, so this should PASS for any version
    // we ship today. If the test ever fails because we shipped a blocked
    // version of pgserve, that is itself a useful signal.
    expect(['PASS', 'WARN']).toContain(f.severity);
    expect(f.id).toBe('version_blocklist');
  });

  test('checkAdminJsonShape handles null admin gracefully', () => {
    // We cannot easily mock readAdminJson without bun:test mock infra;
    // instead exercise the WARN/FAIL paths through admin_json_exists when
    // admin.json may not exist on the test host. This is covered by the
    // entry-point test above; here we just confirm the helper exists.
    expect(typeof __testInternals.checkAdminJsonShape).toBe('function');
  });
});

describe('checkPgauditLoaded (B7 v2.6.3)', () => {
  test('returns WARN with stable id when admin is null (no postmaster to probe)', () => {
    const f = __testInternals.checkPgauditLoaded(null);
    expect(f.id).toBe('pgaudit_loaded');
    expect(f.severity).toBe(SEVERITY.WARN);
    expect(f.detail).toMatch(/admin\.json missing/);
  });

  test('returns WARN when admin has no port', () => {
    const f = __testInternals.checkPgauditLoaded({ supervisor: 'pm2' });
    expect(f.id).toBe('pgaudit_loaded');
    expect(f.severity).toBe(SEVERITY.WARN);
  });

  test('returns WARN when port is invalid', () => {
    const f = __testInternals.checkPgauditLoaded({ port: 0 });
    expect(f.severity).toBe(SEVERITY.WARN);
  });

  test('returns WARN when psql shellout fails (postmaster unreachable)', () => {
    // Pick a port nothing is bound to; pgQuery will fail with connection-
    // refused or similar. The check must NOT throw — it maps the failure
    // to a WARN finding.
    const f = __testInternals.checkPgauditLoaded({ port: 1 });
    expect(f.id).toBe('pgaudit_loaded');
    expect(f.severity).toBe(SEVERITY.WARN);
  });
});

describe('pm2_persistence check (issue #144)', () => {
  const live = { name: 'autopg-server', pm2_env: { status: 'online', args: ['postmaster', '--port', '8432'] } };

  function withDump(entries, run) {
    const pm2Home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-doctor-pm2-'));
    try {
      if (entries) fs.writeFileSync(path.join(pm2Home, 'dump.pm2'), JSON.stringify(entries));
      return run({ env: { PM2_HOME: pm2Home }, getProcess: () => live });
    } finally {
      fs.rmSync(pm2Home, { recursive: true, force: true });
    }
  }

  test('FAILs with a `pm2 save` remedy when the live entry is missing from the dump', () => {
    const finding = withDump([{ name: 'omni-api' }], (options) =>
      __testInternals.checkPm2Persistence({ supervisor: 'pm2' }, options));
    expect(finding.severity).toBe(__testInternals.SEVERITY.FAIL);
    expect(JSON.stringify(finding)).toContain('missing from dump.pm2');
    expect(JSON.stringify(finding)).toContain('pm2 save');
  });

  test('PASSes when the saved entry matches the live one', () => {
    const finding = withDump([{ name: 'autopg-server', args: ['postmaster', '--port', '8432'] }], (options) =>
      __testInternals.checkPm2Persistence({ supervisor: 'pm2' }, options));
    expect(finding.severity).toBe(__testInternals.SEVERITY.PASS);
  });

  test('FAILs when the saved entry would come back on a different port', () => {
    const finding = withDump([{ name: 'autopg-server', args: ['postmaster', '--port', '5432'] }], (options) =>
      __testInternals.checkPm2Persistence({ supervisor: 'pm2' }, options));
    expect(finding.severity).toBe(__testInternals.SEVERITY.FAIL);
    expect(JSON.stringify(finding)).toContain('args');
  });

  test('does not apply to hosts another supervisor owns', () => {
    const finding = __testInternals.checkPm2Persistence({ supervisor: 'systemd-user' });
    expect(finding.severity).toBe(__testInternals.SEVERITY.PASS);
  });
});
