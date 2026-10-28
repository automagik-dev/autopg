# autopg settings schema

Reference for every key in `~/.autopg/settings.json` (schema **version 1**).

This document is generated from `src/settings-schema.cjs` — the single
source of truth shared by the loader, validator, writer, CLI, daemon,
and the Settings screen in `console/`. If a key is documented here but
is not in the schema, the schema wins; please open an issue.

## File location

`~/.autopg/settings.json` by default.

| Resolution order | Source |
|------------------|--------|
| 1 (highest) | `AUTOPG_CONFIG_DIR` environment variable |
| 2 | `PGSERVE_CONFIG_DIR` environment variable (legacy; falls back to `~/.pgserve/`) |
| 3 (default) | `~/.autopg/` |

The directory is created with mode `0700` and the file with mode `0600`
on POSIX platforms (Windows degrades gracefully — NTFS ACLs are out of
scope for v1). On first run, if `~/.pgserve/` exists and `~/.autopg/`
does not, settings are migrated automatically (idempotent — second run
is a no-op once `MIGRATED-FROM-PGSERVE.md` is present in the old dir).

## Precedence

Effective values are merged from three layers, lowest to highest:

```
default  <  file (~/.autopg/settings.json)  <  env (AUTOPG_*  >  PGSERVE_*)
```

`AUTOPG_*` env vars beat `PGSERVE_*` for the same leaf. When only
`PGSERVE_*` is set, the daemon emits a one-time deprecation log per
process. The console shows a yellow `OVERRIDDEN BY ENV` chip on rows
whose env var is currently set.

## CLI

```bash
autopg config init              # write defaults
autopg config list              # KEY VALUE SOURCE table
autopg config get <key>         # machine-friendly value
autopg config set <key> <value> # validates + atomic write + chmod 0600
autopg config edit              # opens $EDITOR on settings.json
autopg config path              # absolute path to settings.json
```

`autopg config …` is a forever alias of the same command.

## Validation error codes

`autopg config set` exits 2 with `error: <field> — <CODE>: <detail>` on
any of:

| Code | Meaning |
|------|---------|
| `INVALID_KEY` | Key path doesn't exist in the schema (e.g. typo) |
| `INVALID_TYPE` | Value's runtime type doesn't match the schema (`int` vs `string`) |
| `OUT_OF_RANGE` | Numeric value outside the schema's `range` |
| `INVALID_GUC_NAME` | `_extra` GUC name fails `^[a-z][a-z0-9_]*$` |
| `INVALID_GUC_VALUE` | GUC value contains forbidden chars (`\n`, `\r`, `\0`, leading `-`) or is not a scalar |
| `READONLY` | Write attempted on a leaf marked `readonly` (reserved for future use) |
| `ETAG_MISMATCH` | UI helper PUT received a stale `If-Match` |

The same codes flow back through the UI helper as JSON
(`{ error: { code, field, message } }`) — the Settings screen renders
inline next to the offending control.

---

## Schema reference

### `server` — router + backend connection surface

| Key | Type | Default | Range / Enum | Env |
|-----|------|---------|--------------|-----|
| `server.port` | `int` | `8432` | `1–65535` | `AUTOPG_PORT`, `PGSERVE_PORT` |
| `server.host` | `string` | `"127.0.0.1"` | — | `AUTOPG_HOST`, `PGSERVE_HOST` |
| `server.pgPort` | `int` | `6432` | `1–65535` | `AUTOPG_PG_PORT`, `PGSERVE_PG_PORT` |
| `server.pgSocketPath` | `string` (nullable) | `""` | — | `AUTOPG_PG_SOCKET`, `PGSERVE_PG_SOCKET` |
| `server.pgUser` | `string` | `"postgres"` | — | `AUTOPG_PG_USER`, `PGSERVE_PG_USER` |
| `server.pgPassword` | `string` (secret) | `"postgres"` | — | `AUTOPG_PG_PASSWORD`, `PGSERVE_PG_PASSWORD` |

- `server.port` — Router TCP port. Clients connect here.
- `server.host` — Bind address for the router.
- `server.pgPort` — Internal PostgreSQL backend port.
- `server.pgSocketPath` — Unix socket path for the backend; empty
  string disables the socket and runs TCP-only.
- `server.pgUser` — Backend superuser.
- `server.pgPassword` — Backend superuser password. The file is
  written with mode `0600`; do not commit `~/.autopg/settings.json`
  to source control. A supervisor that must keep the password out of
  env and argv passes `postmaster --password-file <path>` instead (an
  absolute path to a `0600` file holding one line; it cannot be
  combined with the env vars). initdb reads that file by path and the
  admin pool reads it at every start. That cluster's `pg_hba.conf` is
  rewritten at every start to the single line
  `host all all 127.0.0.1/32 scram-sha-256`, postgres listens on
  `127.0.0.1` only, and `log_statement` is pinned to `none` (no pgaudit,
  no `log_statement=all` fallback). Unix-socket logins are refused.

### `runtime` — logging + provisioning + data dir

| Key | Type | Default | Range / Enum | Env |
|-----|------|---------|--------------|-----|
| `runtime.logLevel` | `enum` | `"info"` | `debug \| info \| warn \| error` | `AUTOPG_LOG_LEVEL`, `PGSERVE_LOG_LEVEL`, `LOG_LEVEL` |
| `runtime.autoProvision` | `bool` | `false` | — | `AUTOPG_AUTO_PROVISION`, `PGSERVE_AUTO_PROVISION` |
| `runtime.enablePgvector` | `bool` | `false` | — | `AUTOPG_ENABLE_PGVECTOR`, `PGSERVE_ENABLE_PGVECTOR` |
| `runtime.dataDir` | `string` (nullable) | `""` | — | `AUTOPG_DATA_DIR`, `PGSERVE_DATA_DIR` |

- `runtime.logLevel` — Log verbosity. `LOG_LEVEL` (no prefix) is
  honored as a third-party convention.
- `runtime.autoProvision` — Auto-create missing databases on first
  connect.
- `runtime.enablePgvector` — Load pgvector extension on database
  create.
- `runtime.dataDir` — PG cluster data directory; empty falls back
  to `<configDir>/data`.

### `sync` — replication

| Key | Type | Default | Env |
|-----|------|---------|-----|
| `sync.enabled` | `bool` | `false` | `AUTOPG_SYNC_ENABLED`, `PGSERVE_SYNC_ENABLED` |

- `sync.enabled` — Enable WAL-based logical replication. When `true`,
  the WAL GUCs in `postgres.*` (`wal_level`, `max_replication_slots`,
  `max_wal_senders`, `wal_keep_size`) are honored as defaults.

### `supervision` — pm2 hardening

| Key | Type | Default | Range | Env |
|-----|------|---------|-------|-----|
| `supervision.maxMemory` | `string` | `"4G"` | — | `AUTOPG_MAX_MEMORY`, `PGSERVE_MAX_MEMORY` |
| `supervision.maxRestarts` | `int` | `50` | `1–1000` | `AUTOPG_MAX_RESTARTS`, `PGSERVE_MAX_RESTARTS` |
| `supervision.minUptimeMs` | `int` | `10000` | `0–600000` | `AUTOPG_MIN_UPTIME_MS`, `PGSERVE_MIN_UPTIME_MS` |
| `supervision.killTimeoutMs` | `int` | `60000` | `1000–600000` | `AUTOPG_KILL_TIMEOUT_MS`, `PGSERVE_KILL_TIMEOUT_MS` |

These map onto `pm2`'s `--max-memory-restart`, `--max-restarts`,
`--min-uptime`, and `--kill-timeout` flags. Documented in detail in
the README's [Daemon mode](../README.md#supervised-by-pm2--pgserve-install-recommended)
section.

### `postgres` — curated GUCs (15) + `_extra` raw passthrough

Curated GUCs apply as `-c key=value` flags at backend boot. Names
use lowercase ASCII identifiers (`^[a-z][a-z0-9_]*$`); values must
be scalar primitives (`string | number | boolean`) and may not
contain `\n`, `\r`, `\0`, or a leading `-`.

| Key | Type | Default | Range / Enum |
|-----|------|---------|--------------|
| `postgres.max_connections` | `int` | `1000` | `1–262143` |
| `postgres.shared_buffers` | `string` | `"128MB"` | — |
| `postgres.work_mem` | `string` | `"4MB"` | — |
| `postgres.maintenance_work_mem` | `string` | `"64MB"` | — |
| `postgres.effective_cache_size` | `string` | `"4GB"` | — |
| `postgres.wal_level` | `enum` | `"logical"` | `minimal \| replica \| logical` |
| `postgres.max_replication_slots` | `int` | `10` | `0–1000` |
| `postgres.max_wal_senders` | `int` | `10` | `0–1000` |
| `postgres.wal_keep_size` | `string` | `"512MB"` | — |
| `postgres.log_statement` | `enum` | `"none"` | `none \| ddl \| mod \| all` |
| `postgres.log_min_duration_statement` | `int` | `-1` | `-1–2147483647` (ms; `-1` = off) |
| `postgres.statement_timeout` | `int` | `0` | `0–2147483647` (ms; `0` = none) |
| `postgres.idle_in_transaction_session_timeout` | `int` | `0` | `0–2147483647` (ms; `0` = none) |
| `postgres.autovacuum` | `bool` | `true` | — |
| `postgres._extra` | `guc_map` | `{}` | name regex `^[a-z][a-z0-9_]*$`, scalar values |

**Raw passthrough.** `postgres._extra` is the escape hatch for any
PostgreSQL GUC outside the curated 15. Set with the dotted form:

```bash
autopg config set postgres._extra.log_lock_waits on
autopg config set postgres._extra.work_mem 16MB
```

Curated keys win on conflict — if both `postgres.work_mem` and
`postgres._extra.work_mem` are set, the curated value is emitted last
and wins. Invalid GUC names / values logged and dropped at boot
(`logger.warn`); postgres still starts.

### `ui` — console theme + CRT toggles

| Key | Type | Default | Enum |
|-----|------|---------|------|
| `ui.theme` | `enum` | `"mdr"` | `mdr \| lumon` |
| `ui.phosphor` | `enum` | `"amber"` | `amber \| green \| white` |
| `ui.density` | `enum` | `"comfortable"` | `compact \| comfortable \| spacious` |
| `ui.crt` | `bool` | `true` | — |

These persist in `~/.autopg/settings.json` and survive a full reload
of the console.

---

## Examples

```bash
# Tune shared_buffers and restart
autopg config set postgres.shared_buffers 256MB
autopg restart
psql -c "SHOW shared_buffers;"   # → 256MB

# Add a non-curated GUC via the raw passthrough
autopg config set postgres._extra.log_statement all
autopg config set postgres._extra.log_min_messages warning
autopg restart

# Inspect every key with its source
autopg config list
# KEY                              VALUE              SOURCE
# server.port                      8432               default
# postgres.shared_buffers          256MB              file
# postgres._extra.log_statement    all                file
# runtime.logLevel                 debug              env:AUTOPG_LOG_LEVEL
# …

# Read a single value (machine-friendly: no quotes, no padding)
autopg config get postgres.shared_buffers   # → 256MB
```
