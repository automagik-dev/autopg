/**
 * Tests for `src/pgvector-version.js` — pgvector .deb version resolution.
 *
 * Regression for issue #145: the auto-installer pinned `0.8.1-2`, which pgdg
 * garbage-collected from its pool once 0.8.5/0.8.6 shipped, so every
 * `runtime.enablePgvector=true` start 404'd. The resolver now reads the pool
 * listing (highest version wins), honours operator overrides, and degrades
 * to a known-good list when the listing is unreachable.
 *
 * No network: the listing fetcher is injected with a fixture.
 */

import { test, expect, describe } from 'bun:test';
import {
  FALLBACK_PGVECTOR_VERSIONS,
  PGVECTOR_POOL_URL,
  compareDebianVersions,
  parsePgvectorDebFilename,
  parsePgvectorPoolListing,
  pgvectorDebUrl,
  resolvePgvectorDebVersions,
} from '../src/pgvector-version.js';

// Shape of an Apache/nginx autoindex page on apt.postgresql.org: `href`
// percent-encodes the `+`, the link text does not.
function row(name) {
  const href = name.replace('+', '%2B');
  return `<tr><td><a href="${href}">${name}</a></td><td>2026-08-01 12:00</td><td>1.2M</td></tr>`;
}

const LISTING = `<html><body><h1>Index of /pub/repos/apt/pool/main/p/pgvector</h1><table>
${row('postgresql-16-pgvector_0.8.6-1.pgdg+1_amd64.deb')}
${row('postgresql-17-pgvector_0.8.5-1.pgdg+1_amd64.deb')}
${row('postgresql-17-pgvector_0.8.6-1.pgdg+1_amd64.deb')}
${row('postgresql-18-pgvector_0.8.5-1.pgdg+1_amd64.deb')}
${row('postgresql-18-pgvector_0.8.5-1.pgdg+1_arm64.deb')}
${row('postgresql-18-pgvector_0.8.6-1.pgdg+1_amd64.deb')}
${row('postgresql-18-pgvector_0.8.6-2.pgdg+1_arm64.deb')}
${row('postgresql-18-pgvector_0.8.10-1.pgdg+1_amd64.deb')}
${row('postgresql-18-pgvector-dbgsym_0.8.6-1.pgdg+1_amd64.deb')}
${row('pgvector_0.8.6-1.pgdg+1.dsc')}
</table></body></html>`;

describe('compareDebianVersions', () => {
  test('orders numerically per segment, not lexically', () => {
    expect(compareDebianVersions('0.8.10-1', '0.8.6-1')).toBeGreaterThan(0);
    expect(compareDebianVersions('0.8.6-1', '0.8.10-1')).toBeLessThan(0);
    expect(compareDebianVersions('0.8.6-1', '0.8.6-1')).toBe(0);
  });

  test('compares the Debian revision after the upstream version', () => {
    expect(compareDebianVersions('0.8.6-2', '0.8.6-1')).toBeGreaterThan(0);
    expect(compareDebianVersions('0.8.6-1', '0.8.5-9')).toBeGreaterThan(0);
  });

  test('tilde sorts before everything', () => {
    expect(compareDebianVersions('0.9.0~rc1-1', '0.9.0-1')).toBeLessThan(0);
    expect(compareDebianVersions('0.9.0~rc1-1', '0.8.6-1')).toBeGreaterThan(0);
  });
});

describe('parsePgvectorPoolListing', () => {
  test('returns matching versions highest first', () => {
    expect(parsePgvectorPoolListing(LISTING, { pgMajor: '18', arch: 'amd64' }))
      .toEqual(['0.8.10-1', '0.8.6-1', '0.8.5-1']);
  });

  test('filters by arch', () => {
    expect(parsePgvectorPoolListing(LISTING, { pgMajor: '18', arch: 'arm64' }))
      .toEqual(['0.8.6-2', '0.8.5-1']);
  });

  test('filters by PG major (17 must not see 18 packages)', () => {
    expect(parsePgvectorPoolListing(LISTING, { pgMajor: 17, arch: 'amd64' }))
      .toEqual(['0.8.6-1', '0.8.5-1']);
    expect(parsePgvectorPoolListing(LISTING, { pgMajor: '15', arch: 'amd64' })).toEqual([]);
  });

  test('ignores dbgsym packages and non-deb pool entries', () => {
    const versions = parsePgvectorPoolListing(LISTING, { pgMajor: '18', arch: 'amd64' });
    expect(versions).not.toContain('dbgsym');
    expect(versions.every((v) => /^\d+\.\d+\.\d+-\d+$/.test(v))).toBe(true);
  });

  test('accepts a listing with only literal "+" (no %2B) and dedupes', () => {
    const plain = 'postgresql-18-pgvector_0.8.6-1.pgdg+1_amd64.deb postgresql-18-pgvector_0.8.6-1.pgdg+1_amd64.deb';
    expect(parsePgvectorPoolListing(plain, { pgMajor: '18', arch: 'amd64' })).toEqual(['0.8.6-1']);
  });

  test('returns [] for empty / non-string input', () => {
    expect(parsePgvectorPoolListing('', { pgMajor: '18', arch: 'amd64' })).toEqual([]);
    expect(parsePgvectorPoolListing(null, { pgMajor: '18', arch: 'amd64' })).toEqual([]);
  });
});

describe('resolvePgvectorDebVersions', () => {
  const target = { pgMajor: '18', arch: 'amd64' };

  test('pool listing: highest version first, then the rest as retries', async () => {
    const calls = [];
    const fetchListing = async (url) => { calls.push(url); return LISTING; };
    const r = await resolvePgvectorDebVersions({ ...target, env: {}, fetchListing });
    expect(r.source).toBe('pool');
    expect(r.versions).toEqual(['0.8.10-1', '0.8.6-1', '0.8.5-1']);
    expect(calls).toEqual([PGVECTOR_POOL_URL]);
  });

  test('AUTOPG_PGVECTOR_VERSION pins and skips the listing fetch', async () => {
    let fetched = false;
    const fetchListing = async () => { fetched = true; return LISTING; };
    const r = await resolvePgvectorDebVersions({
      ...target,
      env: { AUTOPG_PGVECTOR_VERSION: '0.8.1-2' },
      fetchListing,
    });
    expect(r).toEqual({ versions: ['0.8.1-2'], source: 'pin' });
    expect(fetched).toBe(false);
  });

  test('unreachable listing falls back to the known list in order', async () => {
    const fetchListing = async () => { throw new Error('ENOTFOUND apt.postgresql.org'); };
    const r = await resolvePgvectorDebVersions({ ...target, env: {}, fetchListing });
    expect(r.source).toBe('fallback');
    expect(r.versions).toEqual(['0.8.6-1', '0.8.5-1', '0.8.1-2']);
    expect(r.versions).toEqual([...FALLBACK_PGVECTOR_VERSIONS]);
    expect(r.error).toContain('ENOTFOUND');
  });

  test('listing with no match for this major/arch falls back too', async () => {
    const fetchListing = async () => LISTING;
    const r = await resolvePgvectorDebVersions({ pgMajor: '99', arch: 'amd64', env: {}, fetchListing });
    expect(r.source).toBe('fallback');
    expect(r.versions).toEqual([...FALLBACK_PGVECTOR_VERSIONS]);
    expect(r.error).toContain('postgresql-99-pgvector');
  });

  test('never throws when the fetcher rejects', async () => {
    const fetchListing = () => Promise.reject(new Error('timeout'));
    await expect(resolvePgvectorDebVersions({ ...target, env: {}, fetchListing })).resolves.toBeDefined();
  });
});

describe('deb URL + local filename helpers', () => {
  test('pgvectorDebUrl percent-encodes the pgdg "+" suffix', () => {
    expect(pgvectorDebUrl({ pgMajor: '18', arch: 'amd64', version: '0.8.6-1' }))
      .toBe(`${PGVECTOR_POOL_URL}postgresql-18-pgvector_0.8.6-1.pgdg%2B1_amd64.deb`);
  });

  test('parsePgvectorDebFilename recovers the version for vector.meta.json', () => {
    expect(parsePgvectorDebFilename('/tmp/postgresql-18-pgvector_0.8.6-1.pgdg+1_amd64.deb')).toBe('0.8.6-1');
    expect(parsePgvectorDebFilename('postgresql-18-pgvector_0.8.6-1.pgdg%2B1_arm64.deb')).toBe('0.8.6-1');
    expect(parsePgvectorDebFilename('/tmp/custom-build.deb')).toBeNull();
  });
});
