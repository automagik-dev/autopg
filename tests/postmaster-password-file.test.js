/**
 * `postmaster --password-file <path>` against a real cluster.
 *
 * With a password file the cluster takes scram-sha-256 logins on
 * 127.0.0.1 and nothing else: pg_hba has that one line, postgres listens on
 * 127.0.0.1 only, statement logging is off, and the password reaches initdb
 * and the admin pool by path only, never through argv, a log or SQL.
 *
 * Every run uses its own config dir, data dir, socket dir and a free port.
 * The socket dir name is long enough that `<dir>/.s.PGSQL.<port>` would
 * pass the Unix socket path limit (103 bytes on macOS, 107 on Linux): the
 * cluster must start anyway, because it makes no socket.
 * AUTOPG_TEST_PG_CACHE may name an extracted Postgres build
 * (`<config>/bin/<platform>`) to copy in; without it the postmaster
 * downloads one on first start, as it does in production.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const POSTGRES_SERVER = path.join(REPO_ROOT, 'bin', 'postgres-server.js');
const HBA_LINE = 'host all all 127.0.0.1/32 scram-sha-256';
const START_TIMEOUT_MS = 170_000;

const outsideAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

function freePort() {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

function platformKey() {
  return `${os.platform()}-${os.arch()}`;
}

/**
 * Send a protocol-3 startup message and return the server's first reply:
 * an authentication request, an error, or the connect failure.
 */
function startupReply(target) {
  return new Promise((resolve) => {
    const params = Buffer.from('user\0postgres\0database\0postgres\0\0');
    const head = Buffer.alloc(8);
    head.writeInt32BE(8 + params.length, 0);
    head.writeInt32BE(196608, 4);
    const socket = net.createConnection(target);
    let buf = Buffer.alloc(0);
    const done = (reply) => {
      socket.destroy();
      resolve(reply);
    };
    socket.setTimeout(5000, () => done({ kind: 'timeout' }));
    socket.on('connect', () => socket.write(Buffer.concat([head, params])));
    socket.on('error', (err) => done({ kind: 'refused', code: err.code }));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 5) return;
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) return;
      const body = buf.subarray(5, 1 + len);
      const type = String.fromCharCode(buf[0]);
      if (type === 'R') {
        const code = body.readInt32BE(0);
        const mechanisms = body.subarray(4).toString('utf8').split('\0').filter(Boolean);
        done({ kind: 'auth', code, mechanisms });
      } else if (type === 'E') {
        const fields = {};
        for (const field of body.toString('utf8').split('\0').filter(Boolean)) {
          fields[field[0]] = field.slice(1);
        }
        done({ kind: 'error', code: fields.C, message: fields.M });
      } else {
        done({ kind: 'other', type });
      }
    });
  });
}

async function login(port, password) {
  const sql = new Bun.SQL({
    hostname: '127.0.0.1',
    port,
    database: 'postgres',
    username: 'postgres',
    password,
    max: 1,
    connectionTimeout: 5,
  });
  try {
    const [row] = await sql`SELECT current_user AS who, current_setting('log_statement') AS log_statement,
      current_setting('listen_addresses') AS listen_addresses`;
    return row;
  } finally {
    await sql.close();
  }
}

function argvOf(pid) {
  return spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

describe.skipIf(process.platform === 'win32')('postmaster --password-file', () => {
  let root;
  let dirs;
  let passwordFile;
  let password;
  let port;
  let postmaster;
  let logIndex = 0;

  async function startPostmaster() {
    logIndex += 1;
    const logPath = path.join(dirs.logs, `postmaster-${logIndex}.log`);
    postmaster = Bun.spawn(
      [
        process.execPath, POSTGRES_SERVER, 'postmaster',
        '--port', String(port),
        '--data', dirs.data,
        '--socket-dir', dirs.socket,
        '--password-file', passwordFile,
        '--log', 'debug',
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: dirs.home,
          TMPDIR: dirs.tmp,
          AUTOPG_CONFIG_DIR: dirs.config,
          PGSERVE_CONFIG_DIR: dirs.config,
        },
        stdout: Bun.file(logPath),
        stderr: Bun.file(`${logPath}.err`),
      },
    );
    console.log(`spawned postmaster pid ${postmaster.pid}`);
    const runtimeJson = path.join(dirs.socket, 'runtime.json');
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (postmaster.exitCode !== null) {
        const err = fs.readFileSync(`${logPath}.err`, 'utf8') + fs.readFileSync(logPath, 'utf8');
        throw new Error(`postmaster exited ${postmaster.exitCode}: ${err.slice(-2000)}`);
      }
      if (fs.existsSync(runtimeJson)) return;
      await Bun.sleep(200);
    }
    throw new Error('postmaster did not become ready');
  }

  async function stopPostmaster() {
    if (!postmaster || postmaster.exitCode !== null) return;
    postmaster.kill('SIGTERM');
    const exited = await Promise.race([postmaster.exited, Bun.sleep(30_000).then(() => null)]);
    if (exited === null) postmaster.kill('SIGKILL');
  }

  function postgresPid() {
    return Number.parseInt(fs.readFileSync(path.join(dirs.data, 'postmaster.pid'), 'utf8').split('\n')[0], 10);
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pwfile-'));
    dirs = Object.fromEntries(
      ['home', 'config', 'data', 'socket', 'tmp', 'logs'].map((name) => [name, path.join(root, name)]),
    );
    dirs.socket = path.join(root, `socket-${'x'.repeat(80)}`);
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.env.AUTOPG_TEST_PG_CACHE) {
      fs.cpSync(process.env.AUTOPG_TEST_PG_CACHE, path.join(dirs.config, 'bin', platformKey()), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    password = crypto.randomBytes(24).toString('base64url');
    passwordFile = path.join(root, 'pg-password');
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    port = freePort();
    await startPostmaster();
  }, START_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    await stopPostmaster();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 40_000);

  test('pg_hba has the one scram line for 127.0.0.1 and no trust line', () => {
    const lines = fs.readFileSync(path.join(dirs.data, 'pg_hba.conf'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(lines).toEqual([HBA_LINE]);
  });

  test('a 127.0.0.1 client is asked for SCRAM-SHA-256', async () => {
    const reply = await startupReply({ host: '127.0.0.1', port });
    expect(reply).toEqual({ kind: 'auth', code: 10, mechanisms: ['SCRAM-SHA-256'] });
  });

  test('the password from the file logs in; statement logging is off; only 127.0.0.1 listens', async () => {
    const row = await login(port, password);
    expect(row.who).toBe('postgres');
    expect(row.log_statement).toBe('none');
    expect(row.listen_addresses).toBe('127.0.0.1');
  });

  test("the admin pool's Bun.SQL completes the scram login", () => {
    const log = fs.readdirSync(dirs.logs).map((name) => fs.readFileSync(path.join(dirs.logs, name), 'utf8')).join('');
    expect(log).toContain('Admin connection pool initialized');
  });

  test('a wrong password is refused', async () => {
    await expect(login(port, `${password}x`)).rejects.toThrow();
  });

  test('the built-in default password is refused', async () => {
    await expect(login(port, 'postgres')).rejects.toThrow();
  });

  test('an empty password is refused', async () => {
    await expect(login(port, '')).rejects.toThrow();
  });

  test('a Unix-socket client is refused', async () => {
    const reply = await startupReply({ path: path.join(dirs.socket, `.s.PGSQL.${port}`) });
    expect(reply.kind).not.toBe('auth');
  });

  test('postgres makes no Unix socket', () => {
    expect(fs.readdirSync(dirs.socket).filter((name) => name.startsWith('.s.PGSQL.'))).toEqual([]);
  });

  test('an ::1 client is refused', async () => {
    const reply = await startupReply({ host: '::1', port });
    expect(reply.kind).not.toBe('auth');
  });

  test.skipIf(!outsideAddress)('a client on a non-loopback address is refused', async () => {
    const reply = await startupReply({ host: outsideAddress, port });
    expect(reply.kind).toBe('refused');
  });

  test('the password is in no argv, no log and no file but its own', () => {
    for (const pid of [postmaster.pid, postgresPid()]) {
      const argv = argvOf(pid);
      expect(argv.length).toBeGreaterThan(0);
      expect(argv).not.toContain(password);
    }
    const postgresArgv = argvOf(postgresPid());
    expect(postgresArgv).not.toContain('log_statement=all');
    expect(postgresArgv).not.toContain('pgaudit');
    const leaks = filesUnder(root)
      .filter((file) => file !== passwordFile)
      .filter((file) => fs.readFileSync(file).includes(password));
    expect(leaks).toEqual([]);
    expect(fs.readdirSync(dirs.tmp).filter((name) => name.startsWith('pg-password-'))).toEqual([]);
  });

  test('the password file is left in place and unchanged', () => {
    expect(fs.readFileSync(passwordFile, 'utf8')).toBe(`${password}\n`);
    expect(fs.statSync(passwordFile).mode & 0o777).toBe(0o600);
  });

  test('a restart rewrites an edited pg_hba and logs in again from the file', async () => {
    await stopPostmaster();
    fs.appendFileSync(path.join(dirs.data, 'pg_hba.conf'), 'local all all trust\nhost all all ::1/128 trust\n');
    await startPostmaster();
    const lines = fs.readFileSync(path.join(dirs.data, 'pg_hba.conf'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(lines).toEqual([HBA_LINE]);
    expect((await login(port, password)).who).toBe('postgres');
    const reply = await startupReply({ path: path.join(dirs.socket, `.s.PGSQL.${port}`) });
    expect(reply.kind).not.toBe('auth');
  }, START_TIMEOUT_MS + 40_000);

  test('settings.json postgres._extra cannot swap the hba, widen listening or log statements', async () => {
    await stopPostmaster();
    const trustHba = path.join(root, 'trust-hba.conf');
    fs.writeFileSync(trustHba, 'local all all trust\nhost all all 0.0.0.0/0 trust\n');
    fs.writeFileSync(
      path.join(dirs.config, 'settings.json'),
      JSON.stringify({
        postgres: { _extra: { hba_file: trustHba, listen_addresses: '*', log_statement: 'all' } },
      }),
    );
    try {
      await startPostmaster();
      const reply = await startupReply({ path: path.join(dirs.socket, `.s.PGSQL.${port}`) });
      expect(reply.kind).not.toBe('auth');
      expect(await startupReply({ host: '127.0.0.1', port })).toEqual({
        kind: 'auth',
        code: 10,
        mechanisms: ['SCRAM-SHA-256'],
      });
      const row = await login(port, password);
      expect(row.log_statement).toBe('none');
      expect(row.listen_addresses).toBe('127.0.0.1');
    } finally {
      fs.rmSync(path.join(dirs.config, 'settings.json'), { force: true });
    }
  }, START_TIMEOUT_MS + 40_000);
});
