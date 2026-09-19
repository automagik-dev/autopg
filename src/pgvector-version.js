/**
 * pgvector .deb version resolution for the auto-installer in `src/postgres.js`.
 *
 * pgdg garbage-collects superseded packages from its pool, so any hard-coded
 * `postgresql-<major>-pgvector_<ver>.pgdg+1_<arch>.deb` URL eventually 404s
 * (issue #145: the pinned `0.8.1-2` vanished once `0.8.5`/`0.8.6` shipped).
 *
 * This module is pure (no I/O, no `this`) so the precedence rules can be unit
 * tested without touching the network. The installer injects the listing
 * fetcher and the environment.
 *
 * Precedence, highest first:
 *   1. `AUTOPG_PGVECTOR_VERSION=<ver>` — operator pin, no listing fetch.
 *   2. The pgdg pool directory listing — every matching version, highest
 *      first (so a just-removed package is skipped in favour of the next).
 *   3. `FALLBACK_PGVECTOR_VERSIONS` — a short known-good list tried in order
 *      when the listing is unreachable or contains no match.
 *
 * `AUTOPG_PGVECTOR_DEB=<file>` (a local .deb, skips the network entirely) is
 * handled by the installer itself; see `parsePgvectorDebFilename` for the
 * version it records in `vector.meta.json`.
 */

/* global fetch, AbortSignal */

export const PGVECTOR_POOL_URL = 'https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgvector/';

/**
 * Known-good versions tried in order when the pool listing is unreachable.
 * Newest first. Update when pgdg moves on — this list is only a safety net.
 */
export const FALLBACK_PGVECTOR_VERSIONS = Object.freeze(['0.8.6-1', '0.8.5-1', '0.8.1-2']);

/**
 * Build the pool download URL for one candidate version. The `+` in
 * `.pgdg+1` must be percent-encoded in the URL path.
 */
export function pgvectorDebUrl({ pgMajor, arch, version }) {
  return `${PGVECTOR_POOL_URL}postgresql-${pgMajor}-pgvector_${version}.pgdg%2B1_${arch}.deb`;
}

/**
 * Compare two Debian version strings (dpkg semantics, minus epochs).
 * Returns <0, 0, >0 like a sort comparator.
 *
 * Algorithm (from deb-version(7)): compare the upstream part, then the
 * Debian revision. Each part is compared by alternating non-digit and digit
 * runs; non-digit runs compare lexically with `~` sorting before anything
 * (even the empty string) and letters before non-letters; digit runs
 * compare numerically.
 */
export function compareDebianVersions(a, b) {
  const [aUp, aRev] = splitRevision(String(a));
  const [bUp, bRev] = splitRevision(String(b));
  return comparePart(aUp, bUp) || comparePart(aRev, bRev);
}

function splitRevision(v) {
  const idx = v.lastIndexOf('-');
  if (idx === -1) return [v, ''];
  return [v.slice(0, idx), v.slice(idx + 1)];
}

function charOrder(c) {
  if (c === '~') return -1;
  if (c === '') return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
}

function compareNonDigit(x, y) {
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const d = charOrder(x[i] ?? '') - charOrder(y[i] ?? '');
    if (d !== 0) return d;
  }
  return 0;
}

function comparePart(x, y) {
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    // Non-digit run
    let xs = '';
    let ys = '';
    while (i < x.length && !/\d/.test(x[i])) xs += x[i++];
    while (j < y.length && !/\d/.test(y[j])) ys += y[j++];
    const nd = compareNonDigit(xs, ys);
    if (nd !== 0) return nd;
    // Digit run
    let xd = '';
    let yd = '';
    while (i < x.length && /\d/.test(x[i])) xd += x[i++];
    while (j < y.length && /\d/.test(y[j])) yd += y[j++];
    const xn = xd === '' ? 0 : Number(xd);
    const yn = yd === '' ? 0 : Number(yd);
    if (xn !== yn) return xn - yn;
  }
  return 0;
}

/**
 * Extract every pgvector version present in a pgdg pool directory listing
 * for the given PG major + Debian arch. Returns unique versions sorted
 * highest first. Tolerates both `+` and `%2B` in the `.pgdg+1` suffix (the
 * listing uses `%2B` in `href` and `+` in the link text).
 *
 * @param {string} html - Raw directory listing body.
 * @param {{pgMajor: string|number, arch: string}} target
 * @returns {string[]}
 */
export function parsePgvectorPoolListing(html, { pgMajor, arch }) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const re = new RegExp(
    `postgresql-${escapeRe(String(pgMajor))}-pgvector_(\\d+\\.\\d+\\.\\d+-\\d+)\\.pgdg(?:\\+|%2B)1_${escapeRe(arch)}\\.deb`,
    'g',
  );
  const found = new Set();
  for (const m of html.matchAll(re)) found.add(m[1]);
  return [...found].sort((x, y) => compareDebianVersions(y, x));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recover the `<ver>` from a pool-style .deb filename or path. Used to
 * record an honest version in `vector.meta.json` when the operator installs
 * a local .deb via `AUTOPG_PGVECTOR_DEB`. Returns null when the name does
 * not follow the pgdg pattern.
 */
export function parsePgvectorDebFilename(file) {
  const m = String(file).match(/pgvector_(\d+\.\d+\.\d+-\d+)\.pgdg(?:\+|%2B)?\d*_/);
  return m ? m[1] : null;
}

/**
 * Resolve the ordered list of pgvector .deb versions the installer should
 * try. Never throws: an unreachable listing degrades to the fallback list.
 *
 * @param {object} args
 * @param {string|number} args.pgMajor
 * @param {string} args.arch - Debian arch (`amd64` | `arm64`).
 * @param {Record<string,string|undefined>} [args.env] - defaults to `process.env`.
 * @param {(url: string) => Promise<string>} [args.fetchListing] - returns the
 *   listing body; any throw is treated as "unreachable". Defaults to
 *   `fetchPoolListing`.
 * @returns {Promise<{versions: string[], source: 'pin'|'pool'|'fallback', error?: string}>}
 */
export async function resolvePgvectorDebVersions({ pgMajor, arch, env = process.env, fetchListing = fetchPoolListing }) {
  const pin = (env.AUTOPG_PGVECTOR_VERSION || '').trim();
  if (pin) {
    return { versions: [pin], source: 'pin' };
  }

  let error;
  try {
    const html = await fetchListing(PGVECTOR_POOL_URL);
    const versions = parsePgvectorPoolListing(html, { pgMajor, arch });
    if (versions.length > 0) {
      return { versions, source: 'pool' };
    }
    error = `no postgresql-${pgMajor}-pgvector ${arch} package found in pool listing`;
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  return { versions: [...FALLBACK_PGVECTOR_VERSIONS], source: 'fallback', error };
}

/**
 * Default listing fetcher: bounded so an unreachable apt mirror cannot stall
 * postmaster startup indefinitely.
 */
async function fetchPoolListing(url, timeoutMs = 15_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`pool listing fetch failed: ${res.status}`);
  return res.text();
}
