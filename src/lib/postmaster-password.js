/**
 * Managed superuser password resolution for the postmaster entry.
 *
 * PostgresManager has always accepted `options.password` — it flows into
 * initdb's `--pwfile` (fresh clusters) and the TCP admin pool — but the
 * `postmaster` subcommand never wired it, silently pinning the built-in
 * 'postgres' default. Supervisors that rotate the superuser password (the
 * k8s Helm chart's provision Job, for example) then crash-loop the
 * postmaster on every restart: the admin pool re-authenticates fresh at
 * each boot and is refused (observed in the omni k8s node-restart
 * incident, 2026-07-03).
 *
 * Resolution order mirrors settings-schema.cjs `server.pgPassword`:
 *   AUTOPG_PG_PASSWORD > PGSERVE_PG_PASSWORD (legacy) > 'postgres'.
 *
 * Env is the right channel for supervised deployments (k8s secretKeyRef,
 * pm2 env files) — settings.json is non-secret and stays password-free.
 * Empty strings are treated as unset so `AUTOPG_PG_PASSWORD=` in a unit
 * file cannot lock the pool out with a blank password.
 */

import fs from 'node:fs';
import path from 'node:path';

export const POSTMASTER_PASSWORD_ENV_VARS = ['AUTOPG_PG_PASSWORD', 'PGSERVE_PG_PASSWORD'];

export const DEFAULT_POSTMASTER_PASSWORD = 'postgres';

/**
 * Resolve the superuser password the postmaster should hand to
 * PostgresManager. Returns `{ password, source }` where `source` is the
 * env var name that supplied it, or `'default'` — callers may log the
 * SOURCE for operability, never the value.
 */
export function resolvePostmasterPassword(env = process.env) {
  for (const name of POSTMASTER_PASSWORD_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return { password: value, source: name };
    }
  }
  return { password: DEFAULT_POSTMASTER_PASSWORD, source: 'default' };
}

/**
 * Read the superuser password from a file the supervisor owns
 * (`postmaster --password-file <path>`). The file is the only channel: the
 * password never goes through argv, env, SQL or a log. Refused unless the
 * path is absolute and names a regular file (not a symlink) owned by this
 * user with no group or other permission bits, holding one non-empty line.
 * The file is opened once (no symlink followed, no blocking on a FIFO) and
 * the checks run on what was opened, so a swap after the check cannot be
 * read. One trailing newline is dropped, as initdb's --pwfile does. Errors
 * name the path and the reason, never the content.
 */
export function readPasswordFile(filePath) {
  const refuse = (reason) => new Error(`password file ${filePath}: ${reason}`);
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw refuse('the path must be absolute');
  }
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ELOOP') throw refuse('it is a symlink');
    throw refuse(`cannot read it (${err.code ?? err.message})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw refuse('it is not a regular file');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw refuse('it is not owned by this user');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw refuse(`its mode is ${(stat.mode & 0o777).toString(8).padStart(4, '0')}; it must be 0600 or stricter`);
    }
    const password = fs.readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (password.length === 0) throw refuse('it is empty');
    if (/[\r\n]/.test(password)) throw refuse('it must hold one line');
    return password;
  } finally {
    fs.closeSync(fd);
  }
}
