<div align="center">
  <h1>pgserve</h1>
  <p><strong>Embedded PostgreSQL Server with TRUE Concurrent Connections</strong></p>

  <p>
    <a href="https://www.npmjs.com/package/pgserve"><img src="https://img.shields.io/npm/v/pgserve?style=flat-square&color=00D9FF" alt="npm version"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square" alt="Node.js">
    <img src="https://img.shields.io/badge/PostgreSQL-18-blue?style=flat-square" alt="PostgreSQL">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"></a>
    <a href="https://discord.gg/xcW8c7fF3R"><img src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" alt="Discord"></a>
  </p>

  <p><em>npx pgserve and it just works, no credentials needed. Zero config, auto-provision databases, unlimited concurrent connections.</em></p>

  <p>
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-features">Features</a> •
    <a href="#-cli-reference">CLI</a> •
    <a href="#-api">API</a> •
    <a href="#-performance">Performance</a>
  </p>
</div>

<br>

## Quick Start

```bash
npx pgserve
```

Connect from any PostgreSQL client — databases auto-create on first connection:

```bash
psql postgresql://localhost:8432/myapp
```

> Note: v2 default is the Unix socket — see [Daemon mode](#daemon-mode). The TCP form above is the v1 compat path.

> **Naming.** The npm package stays `pgserve`. The CLI now also ships as
> `autopg` — both bins route to the same dispatcher. Use `autopg` for the
> new console (`autopg ui`) and configuration surface (`autopg config`,
> `autopg restart`); `pgserve <subcommand>` keeps working as a forever
> alias. Settings live at `~/.autopg/settings.json` and are migrated
> from `~/.pgserve/` automatically on first run. See
> [Console](#console-autopg-ui) and [Configuration](#configuration).

<br>

## Features

<table>
  <tr>
    <td><b>Real PostgreSQL 18</b></td>
    <td>Native binaries, not WASM — full compatibility, extensions support</td>
  </tr>
  <tr>
    <td><b>Unlimited Concurrency</b></td>
    <td>Native PostgreSQL process forking — no connection locks</td>
  </tr>
  <tr>
    <td><b>Zero Config</b></td>
    <td>Just run <code>pgserve</code>, connect to any database name</td>
  </tr>
  <tr>
    <td><b>Auto-Provision</b></td>
    <td>Databases created automatically on first connection</td>
  </tr>
  <tr>
    <td><b>Memory Mode</b></td>
    <td>Fast and ephemeral for development (default)</td>
  </tr>
  <tr>
    <td><b>RAM Mode</b></td>
    <td>Use <code>--ram</code> for /dev/shm storage (Linux, 2x faster)</td>
  </tr>
  <tr>
    <td><b>Persistent Mode</b></td>
    <td>Use <code>--data ./path</code> for durable storage</td>
  </tr>
  <tr>
    <td><b>Async Replication</b></td>
    <td>Sync to real PostgreSQL with minimal overhead</td>
  </tr>
  <tr>
    <td><b>pgvector Built-in</b></td>
    <td>Use <code>--pgvector</code> for auto-enabled vector similarity search</td>
  </tr>
  <tr>
    <td><b>Cross-Platform</b></td>
    <td>Linux x64, macOS ARM64/x64, Windows x64</td>
  </tr>
  <tr>
    <td><b>Any Client Works</b></td>
    <td>psql, node-postgres, Prisma, Drizzle, TypeORM</td>
  </tr>
</table>

<br>

## Installation

```bash
# Canonical install — signed binary from GitHub Releases
curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash

# Pinned version
PGSERVE_VERSION=v2.6.0 curl -fsSL .../install.sh | bash
```

> `install.sh` fetches the signed tarball from GitHub Releases and verifies it via `gh attestation verify` (Sigstore Rekor public-good). Requires the [`gh` CLI](https://cli.github.com/). pgserve no longer depends on npm — the install + update path is binary tarballs all the way down (run `autopg update` for in-place version migrations; renamed from `pgserve upgrade` in v3.0.0).

### Windows

Download `pgserve-windows-x64.exe` from [GitHub Releases](https://github.com/automagik-dev/autopg/releases).

Double-click to run, or use CLI:

```cmd
pgserve-windows-x64.exe --port 5432
pgserve-windows-x64.exe --data C:\pgserve-data
```

<br>

## CLI Reference

`autopg` and `pgserve` are interchangeable — every subcommand routes
through the same dispatcher. Use whichever you prefer; new examples in
this README and in `console/` use `autopg`.

```
autopg [options]                       # foreground server (alias: pgserve)
autopg daemon                          # long-lived background daemon
autopg install [--port N] [--data P]   # register pgserve under pm2
autopg uninstall [--yes]               # remove from pm2 (data dir kept); confirms first
autopg status                          # pm2 + on-disk config snapshot
autopg url | autopg port               # canonical connection string / port
autopg config <list|get|set|edit|path|init>   # manage ~/.autopg/settings.json
autopg restart                         # restart autopg-server; succeeds only when PostgreSQL is ready
autopg ui [--port N] [--no-open]       # local web console on 127.0.0.1
```

### v2.6 cohort verbs

The 2.6 release adds five operator-facing verbs for health probing, trust-store
management, orphan-database GC, fingerprint provisioning, and per-consumer app
registration:

```
autopg doctor [--json]                # read-only health probe
autopg trust <list|add|remove> [...]  # manage ~/.pgserve/trust/identities.json
autopg gc [--dry-run|--apply]         # sweep orphan databases (audit log)
autopg provision <fingerprint>        # idempotent DB + role provisioning
autopg create-app <slug>              # per-consumer manifest LOCK 1
autopg verify [--slug <slug>] <bin>   # cosign verify against trust list or locked roots
```

Full reference:
[`docs/migrations/v2.6-from-v2.5.md`](docs/migrations/v2.6-from-v2.5.md) ·
[`docs/pgserve-meta.md`](docs/pgserve-meta.md) ·
[`docs/trust-store.md`](docs/trust-store.md).

Foreground options accepted by `autopg` / `pgserve` (no subcommand):

```
Options:
  --port <number>       PostgreSQL port (default: 8432)
  --data <path>         Data directory for persistence (default: in-memory)
  --ram                 Use RAM storage via /dev/shm (Linux only, fastest)
  --host <host>         Host to bind to (default: 127.0.0.1)
  --log <level>         Log level: error, warn, info, debug (default: info)
  --cluster             Force cluster mode (auto-enabled on multi-core)
  --no-cluster          Force single-process mode
  --workers <n>         Number of worker processes (default: CPU cores)
  --no-provision        Disable auto-provisioning of databases
  --sync-to <url>       Sync to real PostgreSQL (async replication)
  --sync-databases <p>  Database patterns to sync (comma-separated)
  --pgvector            Auto-enable pgvector extension on new databases
  --max-connections <n> Max concurrent connections (default: 1000)
  --help                Show help message
```

<details>
<summary><b>Examples</b></summary>

```bash
# Development (memory mode, auto-clusters on multi-core)
pgserve

# RAM mode (Linux only, 2x faster)
pgserve --ram

# Persistent storage
pgserve --data /var/lib/pgserve

# Custom port
pgserve --port 5433

# Enable pgvector for AI/RAG applications
pgserve --pgvector

# RAM mode + pgvector (fastest for AI workloads)
pgserve --ram --pgvector

# Sync to production PostgreSQL
pgserve --sync-to "postgresql://user:pass@db.example.com:5432/prod"
```

</details>

<br>

## Daemon mode

`pgserve@2` ships a singleton daemon that binds a Unix control socket
inside `$XDG_RUNTIME_DIR/pgserve` (fallback `/tmp/pgserve`). One daemon
per host serves every consumer on the box — no port conflicts, no
credentials, kernel-rooted identity. Run it under PM2 or systemd so it
restarts automatically.

```bash
# Foreground (for debugging)
pgserve daemon

# Stop a running daemon
pgserve daemon stop
```

A second `pgserve daemon` invocation while the first is running exits with
`already running, pid N`. A daemon killed with `kill -9` leaves an orphan
PID file + socket; the next `pgserve daemon` boot detects the dead pid and
cleans both up automatically.

Connect from any libpq client (no host/port/user/password required —
the daemon authenticates via SO_PEERCRED on accept):

```bash
psql -h "${XDG_RUNTIME_DIR:-/tmp}/pgserve" -d myapp
# or via connection URI
psql "postgresql:///myapp?host=${XDG_RUNTIME_DIR:-/tmp}/pgserve"
```

### Supervised by PM2 — `autopg install` (recommended)

`autopg install` registers pgserve as a hardened pm2 process in one
command. Idempotent: re-running it is a no-op when already installed.

```bash
autopg install                    # one-shot register + start under pm2
autopg install --port 8442        # custom port
autopg install --data /data/pg    # custom data dir

autopg url                        # postgres://localhost:8432/postgres
autopg port                       # 8432
autopg status                     # pm2 + on-disk config snapshot
autopg uninstall                  # remove from pm2; keep data dir (prompts; --yes for scripts)
```

**Hardened defaults** (tuned for production-grade Postgres workloads,
not toy-machine values):

| Flag | Default | Why |
|------|---------|-----|
| `--max-memory-restart` | `4G` | Postgres realistic working set: shared_buffers + autovacuum + connection backends. 1G OOM-kills under modest load. Override with `PGSERVE_MAX_MEMORY=8G autopg install`. |
| `--max-restarts` | `50` | Tolerates extended outages (NATS reconnect storms, host pressure). Combined with `--min-uptime`, only RAPID failures count. |
| `--min-uptime` | `10000` ms | Restart counts against the cap only when the process crashed within 10s of starting. Healthy long-uptime crashes don't burn the budget. |
| `--restart-delay` | `4000` ms | Initial gap between restarts. |
| `--exp-backoff-restart-delay` | `100` → ~60000 ms | Exponential spread on repeated failures so we don't hammer pm2 + the host on persistent issues. |
| `--kill-timeout` | `60000` ms | Postgres needs time to flush WAL on graceful shutdown; 60s headroom. |
| `--log-date-format` | `YYYY-MM-DD HH:mm:ss.SSS` | Operator-friendly timestamps in pm2 logs. |
| `--output` / `--error` | `~/.pgserve/logs/pgserve-{out,error}.log` | Rotates via pm2-logrotate (install separately). |

Config: `~/.pgserve/config.json` (override the directory with
`PGSERVE_CONFIG_DIR`). Memory ceiling: env-tunable via
`PGSERVE_MAX_MEMORY` at install time.

Downstream services that need a Postgres connection can shell out to
`autopg install` (no-op if already running) and read the canonical URL
from `autopg url` instead of spinning up their own embedded pgserve.

#### Manual ecosystem.config.cjs (legacy)

```javascript
module.exports = {
  apps: [{
    name: 'pgserve',
    script: 'pgserve',
    args: 'daemon',
    autorestart: true,
    max_memory_restart: '1G',
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
  }],
};
```

```bash
pm2 start ecosystem.config.cjs && pm2 save
```

### Supervised by systemd

`/etc/systemd/user/pgserve.service`:

```ini
[Unit]
Description=pgserve daemon
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/env npx pgserve daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable for the current user:

```bash
systemctl --user enable --now pgserve
journalctl --user -u pgserve -f
```

The systemd user unit inherits `XDG_RUNTIME_DIR` automatically; the daemon
binds `${XDG_RUNTIME_DIR}/pgserve/control.sock` (mode 0600, dir mode 0700)
plus a `.s.PGSQL.5432` symlink so off-the-shelf PostgreSQL clients connect
without further configuration.

<br>

## Fingerprint isolation

Each consumer is identified by a **kernel-rooted fingerprint** derived from
the peer's `SO_PEERCRED` plus the resolved `package.json` `name`, collapsed
to 12 hex chars. The daemon auto-creates one database per fingerprint —
`app_<sanitized-name>_<12hex>` — and refuses to route a peer into any other
database with SQLSTATE `28P01 invalid_authorization — database fingerprint
mismatch`.

```bash
# What `psql -l` shows on a host with three consumers:
$ psql -h "${XDG_RUNTIME_DIR:-/tmp}/pgserve" -l
        Name           |  Owner   | ...
-----------------------+----------+----
 app_genie_a1b2c3d4e5f6 | postgres | ...
 app_brain_4f3e2d1c0b9a | postgres | ...
 app_omni_9876543210ab  | postgres | ...
```

**Monorepo rule:** the **root** `package.json` `name` wins. Every workspace
under it shares one fingerprint and one database — sub-packages do **not**
get their own. If you need separate isolation, run them from separate
checkouts.

**Sanitization:** non-`[a-z0-9]` runs collapse to `_`, lowercased, truncated
to 30 chars so the final DB name stays within PostgreSQL's 63-char limit.
A name like `@scope/foo bar` becomes `_scope_foo_bar`.

**Emergency kill switch:** `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1`
disables enforcement for the daemon process. Use it as a debugging tool
only — every bypassed connection emits an `enforcement_kill_switch_used`
audit event and the daemon logs a deprecation warning at boot.

<br>

## Long-running apps: `pgserve.persist`

Default lifecycle is **ephemeral**: a database whose `liveness_pid` is dead
AND whose `last_connection_at` is older than 24h is dropped on the next GC
sweep (boot, hourly, sampled on-connect). Reaped DBs emit
`db_reaped_ttl` or `db_reaped_liveness` audit events.

If your app holds state worth keeping past 24h of idle — genie's wish/agent
store, internal dashboards, anything you'd be unhappy to lose — declare
persistence in `package.json`:

```jsonc
{
  "name": "my-long-lived-app",
  "pgserve": { "persist": true }
}
```

Persisted databases are **never** reaped, regardless of liveness or TTL.
Dev workloads with long debug cycles do not normally need this — any new
connection slides the TTL window forward. Reach for `pgserve.persist` when
the app is genuinely long-lived (production daemon, dashboard, durable
agent state), not just for convenience.

<br>

## Console (`autopg ui`)

A local web console for inspecting and editing the running cluster.
Runs in-process via `node:http`, binds 127.0.0.1 only, single-user dev
tool — no auth, no TLS, never expose it.

```bash
autopg ui                  # walk 8433–8533 picking the first free port
autopg ui --port 8500      # bind exactly 8500
autopg ui --no-open        # skip browser launch (CI / headless)
```

The first stateful screen — **Settings** — is functional today: it
renders the 6-section schema (server / runtime / sync / supervision /
postgres / ui), validates inline, and round-trips through
`~/.autopg/settings.json` with optimistic concurrency (sha256 etag +
`If-Match`). The other 10 screens (Databases, Tables, SQL, Optimizer,
Security, Ingress, Health, Sync, RLM-trace, RLM-sim) are scaffolded
as `[ coming soon ]` placeholders — Health ships next.

The UI shells out to the CLI for every mutation (`autopg config set`
under PUT, `autopg restart` under POST). The daemon stays untouched
— no HTTP API, no signal-based reload — so the console works even
when no daemon is running.

See [`console/README.md`](./console/README.md) for the local dev loop
and design-system source.

<br>

## Configuration

The CLI is the source of truth. Settings live at
`~/.autopg/settings.json` (override the directory with
`AUTOPG_CONFIG_DIR`; the legacy `PGSERVE_CONFIG_DIR` is still honored
and falls back to `~/.pgserve/`). Every write is atomic, chmod 0600,
and tagged with a sha256 etag for optimistic concurrency on the UI
helper's PUT path.

Schema sections (one per `~/.autopg/settings.json` top-level key):

| Section | Purpose |
|---------|---------|
| `server` | Router port/host, backend socket, superuser credentials |
| `runtime` | Log level, auto-provision, pgvector, data dir |
| `sync` | WAL-based logical replication toggle |
| `supervision` | pm2 hardening defaults (memory, restart, kill timeout) |
| `postgres` | 15 curated GUCs (`shared_buffers`, `wal_level`, …) + `_extra` raw passthrough |
| `ui` | Console theme / phosphor / density / CRT toggle |

```bash
autopg config init                              # write defaults
autopg config list                              # KEY VALUE SOURCE table
autopg config get postgres.shared_buffers       # machine-friendly value
autopg config set postgres.shared_buffers 256MB # validates + atomic write
autopg config edit                              # opens $EDITOR on settings.json
autopg config path                              # absolute path (honors AUTOPG_CONFIG_DIR)
```

**Precedence:** `default < file < env`. `AUTOPG_*` env vars beat
`PGSERVE_*` (the legacy form is still honored with a one-time
deprecation log per process, so existing operators keep working).
The console shows a yellow `OVERRIDDEN BY ENV` chip on rows whose
env var is currently set.

**GUC passthrough:** `postgres._extra` is a free-form `{ gucName: scalar }`
map for any PostgreSQL setting outside the curated 15. Names must match
`^[a-z][a-z0-9_]*$`; values must be string / number / boolean (no
newlines, no leading `-`). Both layers are revalidated at boot, so a
typo logs a `logger.warn` and is dropped — postgres still starts.

**One-shot migration:** on first run, if `~/.pgserve/` exists and
`~/.autopg/` does not, the contents are copied (preserving mtimes)
and a `MIGRATED-FROM-PGSERVE.md` marker is dropped in the old dir.
Idempotent — second run is a no-op.

Full schema reference: [`docs/settings-schema.md`](./docs/settings-schema.md).

<br>

## Compat TCP via `--listen`

TCP is **off by default** in v2. Bring it back only when you need it
(Kubernetes pods, remote sync, legacy clients that cannot speak Unix
sockets) by opting in:

```bash
pgserve daemon --listen :5432
# Repeatable for multiple binds:
pgserve daemon --listen :5432 --listen 0.0.0.0:5433
```

TCP peers cannot use `SO_PEERCRED`, so they **must** authenticate at
connect time. Issue a bearer token bound to a known fingerprint:

```bash
# Prints the token ONCE; the daemon stores only its hash.
pgserve daemon issue-token --fingerprint a1b2c3d4e5f6

# TCP client passes it via libpq application_name:
#   ?fingerprint=a1b2c3d4e5f6&token=<bearer>

# Revoke when done:
pgserve daemon revoke-token <token-id>
```

Audit events: `tcp_token_issued`, `tcp_token_used`, `tcp_token_denied`.
Tokens are verified with constant-time compare. Without a valid token a
TCP connection is refused — there is no anonymous TCP path.

Verify no port is bound when `--listen` is **not** set:

```bash
ss -tlnp | grep pgserve   # no rows expected
```

<br>

## API

Daemon-first apps can let the first caller install/start the singleton and
then connect through the Unix socket. The daemon derives the app identity
from kernel peer credentials and routes it to that app's signed fingerprint
database.

```javascript
import { daemonClientOptions, ensureDaemon } from 'pgserve';
import postgres from 'postgres';

await ensureDaemon({
  dataDir: `${process.env.HOME}/.pgserve/data`,
  logLevel: 'warn',
});

const sql = postgres(daemonClientOptions());
await sql`SELECT current_database()`;
```

The classic TCP router API remains available for explicit v1-compatible
embedded servers:

```javascript
import { startMultiTenantServer } from 'pgserve';

const server = await startMultiTenantServer({
  port: 8432,
  host: '127.0.0.1',
  baseDir: null,        // null = memory mode
  logLevel: 'info',
  autoProvision: true,
  enablePgvector: true, // Auto-enable pgvector on new databases
  syncTo: null,         // Optional: PostgreSQL URL for replication
  syncDatabases: null   // Optional: patterns like "myapp,tenant_*"
});

// Get stats
console.log(server.getStats());

// Graceful shutdown
await server.stop();
```

<br>

## Framework Integration

<details>
<summary><b>node-postgres</b></summary>

```javascript
import pg from 'pg';

const client = new pg.Client({
  connectionString: 'postgresql://localhost:8432/myapp'
});

await client.connect();
await client.query('CREATE TABLE users (id SERIAL, name TEXT)');
await client.query("INSERT INTO users (name) VALUES ('Alice')");
const result = await client.query('SELECT * FROM users');
console.log(result.rows);
await client.end();
```

</details>

<details>
<summary><b>Prisma</b></summary>

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```bash
# .env
DATABASE_URL="postgresql://localhost:8432/myapp"

# Run migrations
npx prisma migrate dev
```

</details>

<details>
<summary><b>Drizzle</b></summary>

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://localhost:8432/myapp'
});

const db = drizzle(pool);
const users = await db.select().from(usersTable);
```

</details>

<br>

## Async Replication

Sync ephemeral pgserve data to a real PostgreSQL database. Uses native logical replication for **zero performance impact** on the hot path.

```bash
# Sync all databases
pgserve --sync-to "postgresql://user:pass@db.example.com:5432/mydb"

# Sync specific databases (supports wildcards)
pgserve --sync-to "postgresql://..." --sync-databases "myapp,tenant_*"
```

> Replication is handled by PostgreSQL's WAL writer process, completely off the runtime event loop. Sync failures don't affect main server operation.

<br>

## pgvector (Vector Search)

pgvector is **built-in** — no separate installation required. Just enable it:

```bash
# Auto-enable pgvector on all new databases
pgserve --pgvector

# Combined with RAM mode for fastest vector operations
pgserve --ram --pgvector
```

When `--pgvector` is enabled, every new database automatically has the vector extension installed. No SQL setup required.

On Linux the `vector` extension files are fetched once from the pgdg apt pool
(`postgresql-<major>-pgvector_<ver>.pgdg+1_<arch>.deb`). The version is
resolved from the pool listing at install time (highest wins) because pgdg
removes superseded packages; if the listing is unreachable a short list of
known versions is tried in order. Overrides:

| Env var | Effect |
|---|---|
| `AUTOPG_PGVECTOR_VERSION=<ver>` | Pin one pool version (e.g. `0.8.6-1`) instead of resolving. |
| `AUTOPG_PGVECTOR_DEB=<file.deb>` | Install a local `.deb`; no network access. |

A failed install never stops the postmaster, but it is logged with the
versions tried and the override to use; `CREATE EXTENSION vector` fails until
it is fixed.

<details>
<summary><b>Using pgvector</b></summary>

```sql
-- Create table with vector column (1536 = OpenAI embedding size)
CREATE TABLE documents (id SERIAL, content TEXT, embedding vector(1536));

-- Insert with embedding
INSERT INTO documents (content, embedding) VALUES ('Hello', '[0.1, 0.2, ...]');

-- k-NN similarity search (L2 distance)
SELECT content FROM documents ORDER BY embedding <-> $1 LIMIT 10;
```

See [pgvector documentation](https://github.com/pgvector/pgvector) for full API reference.
</details>

<details>
<summary><b>Without --pgvector flag</b></summary>

If you don't use `--pgvector`, you can still enable pgvector manually per database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

</details>

> pgvector 0.8.1 is bundled with the PostgreSQL binaries. Supports L2 distance (`<->`), inner product (`<#>`), and cosine distance (`<=>`).

<br>

## Performance

### CRUD Benchmarks

<table>
  <tr>
    <th>Scenario</th>
    <th>SQLite</th>
    <th>PostgreSQL</th>
    <th>pgserve 1.2.0</th>
    <th>pgserve v2</th>
    <th>pgserve v2 --ram</th>
  </tr>
  <tr>
    <td><b>Concurrent Writes</b> (10 agents)</td>
    <td>91 qps</td>
    <td>204 qps</td>
    <td>1,667 qps</td>
    <td>2,273 qps</td>
    <td><b>4,167 qps</b> 🏆</td>
  </tr>
  <tr>
    <td><b>Mixed Workload</b></td>
    <td>383 qps</td>
    <td>484 qps</td>
    <td>507 qps</td>
    <td>1,133 qps</td>
    <td><b>2,109 qps</b> 🏆</td>
  </tr>
  <tr>
    <td><b>Write Lock</b> (50 writers)</td>
    <td>111 qps</td>
    <td>228 qps</td>
    <td>2,857 qps</td>
    <td>3,030 qps</td>
    <td><b>4,348 qps</b> 🏆</td>
  </tr>
</table>

### Vector Benchmarks (pgvector)

<table>
  <tr>
    <th>Metric</th>
    <th>PostgreSQL</th>
    <th>pgserve 1.2.0</th>
    <th>pgserve v2</th>
    <th>pgserve v2 --ram</th>
  </tr>
  <tr>
    <td><b>Vector INSERT</b> (1000 × 1536-dim)</td>
    <td>152/sec</td>
    <td>392/sec</td>
    <td>387/sec</td>
    <td><b>1,082/sec</b> 🏆</td>
  </tr>
  <tr>
    <td><b>k-NN Search</b> (k=10, 10k corpus)</td>
    <td>22 qps</td>
    <td>33 qps</td>
    <td>31 qps</td>
    <td>30 qps</td>
  </tr>
  <tr>
    <td><b>Recall@10</b></td>
    <td>100%</td>
    <td>100%</td>
    <td>100%</td>
    <td>100%</td>
  </tr>
</table>

> <b>Why pgserve wins on writes:</b> RAM mode uses <code>/dev/shm</code> (tmpfs), eliminating fsync latency. Vector search is CPU-bound, so RAM mode shows minimal benefit there.

### Final Score

<table>
  <tr>
    <th>Engine</th>
    <th>CRUD QPS</th>
    <th>Vec QPS</th>
    <th>Recall</th>
    <th>P50</th>
    <th>P99</th>
    <th>Score</th>
  </tr>
  <tr>
    <td>SQLite</td>
    <td>195</td>
    <td>N/A</td>
    <td>N/A</td>
    <td>6.3ms</td>
    <td>17.3ms</td>
    <td>117</td>
  </tr>
  <tr>
    <td>pgserve 1.2.0</td>
    <td>305</td>
    <td>65</td>
    <td>100%</td>
    <td>3.3ms</td>
    <td>7.0ms</td>
    <td>209</td>
  </tr>
  <tr>
    <td>PostgreSQL</td>
    <td>1,677</td>
    <td>152</td>
    <td>100%</td>
    <td>6.0ms</td>
    <td>19.0ms</td>
    <td>1,067</td>
  </tr>
  <tr>
    <td>pgserve v2</td>
    <td>2,145</td>
    <td>149</td>
    <td>100%</td>
    <td>5.3ms</td>
    <td>13.0ms</td>
    <td>1,347</td>
  </tr>
  <tr>
    <td><b>pgserve v2 --ram</b></td>
    <td><b>3,541</b></td>
    <td><b>381</b></td>
    <td><b>100%</b></td>
    <td><b>3.3ms</b></td>
    <td><b>10.7ms</b></td>
    <td><b>2,277</b> 🏆</td>
  </tr>
</table>

> <b>Methodology:</b> Recall@k measured against brute-force ground truth (industry standard). PostgreSQL baseline is Docker <code>pgvector/pgvector:pg18</code>. RAM mode available on Linux and WSL2.
>
> Run benchmarks yourself: <code>bun tests/benchmarks/runner.js --include-vector</code>

<br>

## Use Cases

<table>
  <tr>
    <td width="50%">
      <h4>Development & Testing</h4>
      <ul>
        <li><b>Local Development</b> — PostgreSQL without Docker</li>
        <li><b>Integration Testing</b> — Real PostgreSQL, not mocks</li>
        <li><b>CI/CD Pipelines</b> — Fresh databases per test run</li>
        <li><b>E2E Testing</b> — Isolated database for Playwright/Cypress</li>
      </ul>
    </td>
    <td width="50%">
      <h4>AI & Agents</h4>
      <ul>
        <li><b>AI Agent Memory</b> — Isolated, concurrent-safe database</li>
        <li><b>LLM Tool Use</b> — Give AI models a real PostgreSQL</li>
        <li><b>RAG Applications</b> — Store embeddings with pgvector</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h4>Multi-Tenant & SaaS</h4>
      <ul>
        <li><b>Tenant Isolation</b> — Auto-provision per tenant</li>
        <li><b>Demo Environments</b> — Instant sandboxed PostgreSQL</li>
        <li><b>Microservices Dev</b> — Each service gets its own DB</li>
      </ul>
    </td>
    <td width="50%">
      <h4>Edge & Embedded</h4>
      <ul>
        <li><b>IoT Devices</b> — Full PostgreSQL on Raspberry Pi</li>
        <li><b>Desktop Apps</b> — Electron with embedded PostgreSQL</li>
        <li><b>Offline-First</b> — Local DB that syncs when online</li>
      </ul>
    </td>
  </tr>
</table>

<br>

## Requirements

- **Runtime**: Node.js >= 18 (npm/npx)
- **Platform**: Linux x64, macOS ARM64/x64, Windows x64

<br>

## Development

Contributors: This project uses Bun internally for development:

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run benchmarks
bun tests/benchmarks/runner.js

# Lint
bun run lint
```

<br>

## Contributing

Contributions welcome! Fork the repo, create a feature branch, add tests, and submit a PR.

<br>

---

<div align="center">
  <p>
    <b>MIT License</b> — Copyright (c) 2025 Namastex Labs
  </p>
  <p>
    <a href="https://github.com/automagik-dev/autopg">GitHub</a> •
    <a href="https://www.npmjs.com/package/pgserve">npm</a> •
    <a href="https://github.com/automagik-dev/autopg/issues">Issues</a>
  </p>
  <p>
    Made with love by <a href="https://namastex.ai">Namastex Labs</a>
  </p>
</div>
