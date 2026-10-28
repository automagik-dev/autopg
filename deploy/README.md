# autopg — container + Helm chart

Containerizes [autopg](https://github.com/automagik-dev/autopg) (embedded
PostgreSQL 18) as a self-contained, **offline-boot** Kubernetes StatefulSet with
a reusable Helm chart. Built and verified on OrbStack arm64 k8s.

## Layout

```
deploy/
  Dockerfile            arm64, glibc (debian:12-slim), pre-seeded binary cache
  .dockerignore
  helm/autopg/          the chart (Chart.yaml, values.yaml, templates/)
```

## Image

The compiled `autopg` binary resolves its postgres/initdb binaries from a
per-platform cache under `$AUTOPG_CONFIG_DIR/bin/<platformKey>/`; when absent it
**downloads `@embedded-postgres` from npm on first boot**. That is unacceptable
for a pod, so the Dockerfile **pre-seeds the cache** from the release tarball's
`postgres/` tree plus a `.version` marker (`18.3.0-beta.17`, matching
`src/postgres.js` `PINNED_PG_VERSION`). First boot is fully offline — proven with
`docker run --network none`.

Key facts baked in:
- Base is **glibc** (bundled PG18 links `libssl.so.1.1` + `libicu*.so.60`).
- `HOME=/var/lib/autopg`, `AUTOPG_CONFIG_DIR=/var/lib/autopg`.
- Non-root user `autopg` (uid/gid 1000) owns the state tree.
- `postgresql-client` (apt) supplies `pg_isready` (probes) + `psql` (provisioning).
- ENTRYPOINT is the postmaster (PID 1); it handles SIGTERM for graceful shutdown.

Build:

```bash
docker build --platform linux/arm64 -f deploy/Dockerfile -t autopg:dev deploy/
```

Override the autopg release with `--build-arg AUTOPG_VERSION=3.0.7` (and bump
`--build-arg PG_VERSION_MARKER=...` if the pinned PG changes).

## Chart

```bash
helm install autopg deploy/helm/autopg -n <ns> --create-namespace \
  --set image.pullPolicy=Never    # OrbStack shares its image store with k8s
```

Resources created: **StatefulSet** (replicas=1, PVC at `/var/lib/autopg/data`),
a **headless Service** + a **ClusterIP Service** on 5432, a **ConfigMap**
(`settings.json`), a **Secret** (passwords), and a post-install/post-upgrade
**provisioning Job**.

### settings.json / GUC placement (important)

autopg ships **curated GUC defaults** (e.g. `max_connections=1000`,
`shared_buffers=128MB`) that WIN over anything under `postgres._extra`. The chart
therefore renders operator tuning (`settings.gucs`) as **curated top-level**
`postgres.*` keys and puts `listen_addresses` (no curated default) under
`postgres._extra`. `listen_addresses='*'` is required so in-cluster peers can
reach the pod over TCP.

### Persistence & permissions

PGDATA is `/var/lib/autopg/data/pgdata` — a **subdirectory** of the PVC mount.
The PVC root is owned `root:fsGroup`, which a non-root process cannot `chmod`
(initdb needs 0700); autopg creates and owns the `pgdata` subdir (uid 1000), so
initdb's chmod succeeds. No root initContainer required.

### Provisioning (scoped roles)

For each `provisionedApps` entry the Job idempotently creates a `LOGIN` role, a
database `OWNER`ed by that role, and makes the role **own `schema public`** in
that db (so it can run migrations — `CREATE`/`ALTER`/`DROP` its own tables). The
Job also rotates the superuser (`postgres`) password to the managed Secret value
(the postmaster always initdb's with the built-in `postgres`/`postgres`; there is
no boot-time flag to set it).

## Chart interface (for consumers)

| Item | Value |
|------|-------|
| Connection endpoint | `<release>-autopg.<ns>.svc.cluster.local:5432` (ClusterIP Service `<release>-autopg`) |
| Headless Service | `<release>-autopg-headless` (StatefulSet DNS) |
| Superuser | `postgres`, password in Secret `<release>-autopg-auth` key `superuser-password` |
| Provisioned db (default) | `omni`, owned by role `omni` |
| Provisioned role password | Secret `<release>-autopg-auth` key `omni-password` (`<role>-password` per app) |

Key values.yaml knobs: `image.{repository,tag,pullPolicy}`, `port`, `logLevel`,
`auth.{superuserPassword,existingSecret}`, `provisionedApps[]`,
`settings.{listenAddresses,gucs,extraGucs}`,
`persistence.{enabled,size,storageClass}`, `resources`, `probes.*`,
`terminationGracePeriodSeconds`, `provisionJob.{enabled,readyTimeoutSeconds}`.
