import { describe, expect, test } from 'bun:test';

const {
  evaluateServiceState,
  waitForServiceReadiness,
} = require('../../src/lib/service-state.cjs');

describe('evaluateServiceState', () => {
  test('is ready only when supervisor and postmaster runtime agree', () => {
    expect(evaluateServiceState({
      supervisor: 'pm2',
      supervisorStatus: 'online',
      supervisorPid: 123,
      configuredPort: 5432,
      runtime: { port: 5432, autopgPid: 123 },
      runtimeLive: true,
    })).toMatchObject({
      ready: true,
      status: 'ready',
      supervisorStatus: 'online',
      runtimeLive: true,
    });
  });

  test('reports a degraded service when pm2 is online but runtime is stale', () => {
    const state = evaluateServiceState({
      supervisor: 'pm2',
      supervisorStatus: 'online',
      supervisorPid: 123,
      configuredPort: 5432,
      runtime: { port: 5432, autopgPid: 123 },
      runtimeLive: false,
    });

    expect(state.ready).toBe(false);
    expect(state.status).toBe('degraded');
    expect(state.reasons).toContain('runtime process is not live');
  });

  test('reports a port mismatch as degraded', () => {
    const state = evaluateServiceState({
      supervisor: 'pm2',
      supervisorStatus: 'online',
      supervisorPid: 123,
      configuredPort: 5432,
      runtime: { port: 8432, autopgPid: 123 },
      runtimeLive: true,
    });

    expect(state.ready).toBe(false);
    expect(state.reasons).toContain('runtime port 8432 does not match configured port 5432');
  });

  test('rejects a live runtime marker owned by a different process', () => {
    const state = evaluateServiceState({
      supervisor: 'pm2',
      supervisorStatus: 'online',
      supervisorPid: 456,
      configuredPort: 5432,
      runtime: { port: 5432, autopgPid: 123 },
      runtimeLive: true,
    });

    expect(state.ready).toBe(false);
    expect(state.reasons).toContain('runtime pid 123 does not match pm2 pid 456');
  });
});

describe('waitForServiceReadiness', () => {
  test('polls until the service becomes ready', async () => {
    let calls = 0;
    const state = await waitForServiceReadiness({
      timeoutMs: 50,
      pollIntervalMs: 1,
      inspect: () => {
        calls += 1;
        return calls === 1
          ? { ready: false, status: 'degraded' }
          : { ready: true, status: 'ready' };
      },
    });

    expect(state.ready).toBe(true);
    expect(calls).toBe(2);
  });

  test('returns the last observed state on timeout', async () => {
    const state = await waitForServiceReadiness({
      timeoutMs: 2,
      pollIntervalMs: 1,
      inspect: () => ({ ready: false, status: 'degraded', reasons: ['not ready'] }),
    });

    expect(state).toMatchObject({ ready: false, status: 'degraded' });
  });
});
