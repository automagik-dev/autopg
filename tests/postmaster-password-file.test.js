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
 *
 * The Postgres build is copied in from AUTOPG_TEST_PG_CACHE (an extracted
 * `<config>/bin/<platform>`), else from the autopg binary cache when it
 * has one; the source is only read. With neither, the suite runs only
 * under CI, where the postmaster downloads the build on first start.
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

const PG_CACHE_SOURCE = [
  process.env.AUTOPG_TEST_PG_CACHE,
  path.join(
    process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || path.join(os.homedir(), '.autopg'),
    'bin',
    platformKey(),
  ),
].find((dir) => dir && fs.existsSync(path.join(dir, 'bin', 'postgres')));
const CAN_RUN = process.platform !== 'win32' && (PG_CACHE_SOURCE !== undefined || process.env.CI !== undefined);

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

function connect(port, password) {
  return new Bun.SQL({
    hostname: '127.0.0.1',
    port,
    database: 'postgres',
    username: 'postgres',
    password,
    max: 1,
    connectionTimeout: 5,
  });
}

async function login(port, password) {
  const sql = connect(port, password);
  try {
    const [row] = await sql`SELECT current_user AS who, current_setting('log_statement') AS log_statement,
      current_setting('listen_addresses') AS listen_addresses`;
    return row;
  } finally {
    await sql.close();
  }
}

/**
 * The SQLSTATE a query fails with, or null when it succeeds. Awaited
 * directly: Bun.SQL runs a query when it is awaited, and expect().rejects
 * never starts one.
 */
async function failsWith(query) {
  try {
    await query;
  } catch (err) {
    return err.errno ?? err.code ?? 'error';
  }
  return null;
}

function argvOf(pid) {
  return spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

/** argv plus environment (`ps e`), for processes of this user. */
function argvAndEnvOf(pid) {
  return spawnSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function hbaLines(dataDir) {
  return fs.readFileSync(path.join(dataDir, 'pg_hba.conf'), 'utf8')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line && !line.startsWith('#'));
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

/**
 * One scratch run: own HOME, TMPDIR, config, data, socket and log dirs, a
 * free port, and a postmaster started and stopped by the test.
 */
function createRun({ socketName = 'socket' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pwfile-'));
  const dirs = Object.fromEntries(
    ['home', 'config', 'data', 'tmp', 'logs'].map((name) => [name, path.join(root, name)]),
  );
  dirs.socket = path.join(root, socketName);
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (PG_CACHE_SOURCE) {
    fs.cpSync(PG_CACHE_SOURCE, path.join(dirs.config, 'bin', platformKey()), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  const run = { root, dirs, port: freePort(), postmaster: null, logIndex: 0 };

  /** Start the postmaster; resolve once runtime.json is written, reject with its log if it exits. */
  run.start = async (extraArgs = []) => {
    run.logIndex += 1;
    const logPath = path.join(dirs.logs, `postmaster-${run.logIndex}.log`);
    run.postmaster = Bun.spawn(
      [
        process.execPath, POSTGRES_SERVER, 'postmaster',
        '--port', String(run.port),
        '--data', dirs.data,
        '--socket-dir', dirs.socket,
        '--log', 'debug',
        ...extraArgs,
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
    console.log(`spawned postmaster pid ${run.postmaster.pid}`);
    const runtimeJson = path.join(dirs.socket, 'runtime.json');
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (run.postmaster.exitCode !== null) {
        const err = fs.readFileSync(`${logPath}.err`, 'utf8') + fs.readFileSync(logPath, 'utf8');
        throw new Error(`postmaster exited ${run.postmaster.exitCode}: ${err.slice(-2000)}`);
      }
      if (fs.existsSync(runtimeJson)) {
        console.log(`postgres pid ${run.postgresPid()}`);
        return;
      }
      await Bun.sleep(200);
    }
    throw new Error('postmaster did not become ready');
  };

  run.stop = async () => {
    const proc = run.postmaster;
    if (!proc || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    const exited = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => null)]);
    if (exited === null) proc.kill('SIGKILL');
  };

  /** The postgres pid in postmaster.pid, or null when there is none. */
  run.postgresPid = () => {
    const pidFile = path.join(dirs.data, 'postmaster.pid');
    if (!fs.existsSync(pidFile)) return null;
    return Number.parseInt(fs.readFileSync(pidFile, 'utf8').split('\n')[0], 10);
  };

  run.log = () => fs.readdirSync(dirs.logs).map((name) => fs.readFileSync(path.join(dirs.logs, name), 'utf8')).join('');

  run.dispose = async () => {
    await run.stop();
    // A postgres the postmaster left behind must not outlive the test.
    const pid = run.postgresPid();
    if (pid && alive(pid)) {
      console.log(`stopping leftover postgres pid ${pid}`);
      process.kill(pid, 'SIGINT');
      await Bun.sleep(2000);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  return run;
}

function writePasswordFile(run) {
  const password = crypto.randomBytes(24).toString('base64url');
  const file = path.join(run.root, 'pg-password');
  fs.writeFileSync(file, `${password}\n`, { mode: 0o600 });
  return { password, file };
}

describe.skipIf(!CAN_RUN)('postmaster --password-file', () => {
  let run;
  let dirs;
  let port;
  let password;
  let passwordFile;
  const startPostmaster = () => run.start(['--password-file', passwordFile]);

  beforeAll(async () => {
    run = createRun({ socketName: `socket-${'x'.repeat(80)}` });
    ({ dirs, port } = run);
    ({ password, file: passwordFile } = writePasswordFile(run));
    await startPostmaster();
  }, START_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    if (run) await run.dispose();
  }, 40_000);

  test('pg_hba has the one scram line for 127.0.0.1 and no trust line', () => {
    expect(hbaLines(dirs.data)).toEqual([HBA_LINE]);
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
    expect(run.log()).toContain('Admin connection pool initialized');
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

  test('the password is in no argv, no env, no log and no file but its own', () => {
    for (const pid of [run.postmaster.pid, run.postgresPid()]) {
      const argv = argvOf(pid);
      expect(argv.length).toBeGreaterThan(0);
      expect(argv).not.toContain(password);
      const withEnv = argvAndEnvOf(pid);
      expect(withEnv).toContain(`AUTOPG_CONFIG_DIR=${dirs.config}`);
      expect(withEnv).not.toContain(password);
    }
    const postgresArgv = argvOf(run.postgresPid());
    expect(postgresArgv).not.toContain('log_statement=all');
    expect(postgresArgv).not.toContain('pgaudit');
    const leaks = filesUnder(run.root)
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
    await run.stop();
    fs.appendFileSync(path.join(dirs.data, 'pg_hba.conf'), 'local all all trust\nhost all all ::1/128 trust\n');
    await startPostmaster();
    expect(hbaLines(dirs.data)).toEqual([HBA_LINE]);
    expect((await login(port, password)).who).toBe('postgres');
    const reply = await startupReply({ path: path.join(dirs.socket, `.s.PGSQL.${port}`) });
    expect(reply.kind).not.toBe('auth');
  }, START_TIMEOUT_MS + 40_000);

  test('no setting turns statement logging back on, and the password reaches no file', async () => {
    await run.stop();
    const trustHba = path.join(run.root, 'trust-hba.conf');
    fs.writeFileSync(trustHba, 'local all all trust\nhost all all 0.0.0.0/0 trust\n');
    // Loaded through config_file, around the settings name check.
    const libDir = path.join(dirs.config, 'bin', platformKey(), 'lib', 'postgresql');
    const hasAutoExplain = fs.existsSync(libDir)
      && fs.readdirSync(libDir).some((name) => name.startsWith('auto_explain.'));
    const configFile = path.join(run.root, 'extra.conf');
    fs.writeFileSync(
      configFile,
      [
        "log_statement = 'all'",
        'log_min_duration_statement = 0',
        "log_min_error_statement = 'debug5'",
        "log_min_messages = 'debug5'",
        'logging_collector = on',
        ...(hasAutoExplain ? ["shared_preload_libraries = 'auto_explain'", 'auto_explain.log_min_duration = 0'] : []),
        '',
      ].join('\n'),
    );
    const loud = {
      log_statement: 'all',
      log_duration: 'on',
      log_min_duration_statement: 0,
      log_min_duration_sample: 0,
      log_statement_sample_rate: 1,
      log_transaction_sample_rate: 1,
      log_min_error_statement: 'debug5',
      log_min_messages: 'debug5',
      log_parameter_max_length: -1,
      log_parameter_max_length_on_error: -1,
      logging_collector: 'on',
      debug_print_parse: 'on',
      debug_print_rewritten: 'on',
      debug_print_plan: 'on',
      password_encryption: 'md5',
      scram_iterations: 1,
    };
    fs.writeFileSync(
      path.join(dirs.config, 'settings.json'),
      JSON.stringify({
        postgres: {
          log_statement: 'all',
          log_min_duration_statement: 0,
          _extra: { ...loud, hba_file: trustHba, listen_addresses: '*', config_file: configFile },
        },
      }),
    );
    try {
      await startPostmaster();
      expect((await startupReply({ path: path.join(dirs.socket, `.s.PGSQL.${port}`) })).kind).not.toBe('auth');
      expect(await startupReply({ host: '127.0.0.1', port })).toEqual({
        kind: 'auth',
        code: 10,
        mechanisms: ['SCRAM-SHA-256'],
      });

      let row;
      const sql = connect(port, password);
      try {
        [row] = await sql`SELECT current_setting('log_statement') AS log_statement,
          current_setting('listen_addresses') AS listen_addresses,
          current_setting('logging_collector') AS logging_collector,
          current_setting('log_min_error_statement') AS log_min_error_statement,
          current_setting('log_min_messages') AS log_min_messages,
          current_setting('shared_preload_libraries') AS shared_preload_libraries,
          current_setting('password_encryption') AS password_encryption,
          current_setting('scram_iterations') AS scram_iterations`;
        // Statements a password could ride in: a failing ALTER ROLE, a
        // failing statement, a bind value, and an ALTER ROLE that succeeds
        // (to the same password, so later logins still work).
        expect(await failsWith(sql.unsafe(`ALTER ROLE no_such_role PASSWORD '${password}'`))).toBe('42704');
        expect(await failsWith(sql.unsafe(`SELECT '${password}' AS marker, 1 / 0`))).toBe('22012');
        await sql`SELECT ${password}::text AS marker, pg_sleep(0.01)`;
        await sql.unsafe(`ALTER ROLE postgres PASSWORD '${password}'`);
      } finally {
        await sql.close();
      }
      await expect(login(port, `${password}-wrong`)).rejects.toThrow();
      await run.stop();
      // postgres's own output reaches the postmaster log (--log debug), so a logged statement would be there.
      expect(run.log()).toContain('pgOutput');
      const leaks = filesUnder(run.root)
        .filter((file) => file !== passwordFile)
        .filter((file) => fs.readFileSync(file).includes(password))
        .map((file) => path.relative(run.root, file));
      expect(leaks).toEqual([]);
      expect(row).toEqual({
        log_statement: 'none',
        listen_addresses: '127.0.0.1',
        logging_collector: 'off',
        log_min_error_statement: 'panic',
        log_min_messages: 'warning',
        shared_preload_libraries: '',
        password_encryption: 'scram-sha-256',
        scram_iterations: '4096',
      });
    } finally {
      fs.rmSync(path.join(dirs.config, 'settings.json'), { force: true });
    }
  }, START_TIMEOUT_MS + 40_000);
});

describe.skipIf(!CAN_RUN)('postmaster without --password-file', () => {
  let run;

  beforeAll(async () => {
    run = createRun();
    await run.start();
  }, START_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    if (run) await run.dispose();
  }, 40_000);

  test('pg_hba, auth method, socket and temp password file are as before', async () => {
    const lines = hbaLines(run.dirs.data);
    expect(lines).toContain('local all all trust');
    expect(lines.some((line) => /^host\s+all\s+all\s+127\.0\.0\.1\/32\s+password$/.test(line))).toBe(true);
    expect(await startupReply({ host: '127.0.0.1', port: run.port })).toEqual({ kind: 'auth', code: 3, mechanisms: [] });
    const socket = await startupReply({ path: path.join(run.dirs.socket, `.s.PGSQL.${run.port}`) });
    expect(socket).toEqual({ kind: 'auth', code: 0, mechanisms: [] });
    expect((await login(run.port, 'postgres')).listen_addresses).toBe('localhost');
    expect(fs.readdirSync(run.dirs.tmp).filter((name) => name.startsWith('pg-password-'))).toEqual([]);
  });

  test('--password-file on a cluster made without it is refused and leaves no postgres running', async () => {
    await run.stop();
    const { file } = writePasswordFile(run);
    await expect(run.start(['--password-file', file])).rejects.toThrow('postmaster exited 1');
    const pid = run.postgresPid();
    if (pid !== null) expect(alive(pid)).toBe(false);
    const probe = Bun.listen({ hostname: '127.0.0.1', port: run.port, socket: { data() {} } });
    probe.stop(true);
  }, START_TIMEOUT_MS + 40_000);
});
