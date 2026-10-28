# syntax=docker/dockerfile:1
#
# autopg — embedded PostgreSQL 18 as a self-contained, offline-boot container.
#
# The compiled `autopg` binary resolves its postgres/initdb binaries from a
# per-platform cache under $AUTOPG_CONFIG_DIR/bin/<platformKey>/ (see
# src/postgres.js getBinaryPaths / isCachedValid). When that cache is absent
# it DOWNLOADS @embedded-postgres from npm on first boot. That network fetch is
# unacceptable for a k8s pod, so this image PRE-SEEDS the cache from the release
# tarball's postgres/ tree plus a `.version` marker — the first postmaster boot
# is fully offline.
#
# Base MUST be glibc (not alpine/musl): the bundled PG18 links libssl.so.1.1 +
# libicu*.so.60 with RUNPATH $ORIGIN/../lib.

ARG AUTOPG_VERSION=3.0.7
# Must match src/postgres.js PINNED_PG_VERSION — the value isCachedValid()
# compares the `.version` marker against. Bump both together.
ARG PG_VERSION_MARKER=18.3.0-beta.17

# ---------------------------------------------------------------------------
# Stage 1: fetch + extract the release tarball for the target arch.
# ---------------------------------------------------------------------------
FROM debian:12-slim AS fetch
ARG AUTOPG_VERSION
# TARGETARCH is provided by buildkit (arm64 / amd64).
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /stage
RUN set -eux; \
    case "${TARGETARCH:-arm64}" in \
      arm64) ASSET="autopg-${AUTOPG_VERSION}-linux-arm64.tar.gz" ;; \
      amd64) ASSET="autopg-${AUTOPG_VERSION}-linux-x64-glibc.tar.gz" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o autopg.tar.gz \
      "https://github.com/automagik-dev/autopg/releases/download/v${AUTOPG_VERSION}/${ASSET}"; \
    tar xzf autopg.tar.gz; \
    test -f autopg/autopg; \
    test -x autopg/postgres/bin/initdb; \
    test -x autopg/postgres/bin/postgres

# ---------------------------------------------------------------------------
# Stage 2: minimal glibc runtime with the pre-seeded binary cache.
# ---------------------------------------------------------------------------
FROM debian:12-slim AS runtime
ARG PG_VERSION_MARKER

# postgresql-client supplies pg_isready (health probes) + psql (the
# provisioning Job). The embedded PG18 *server* binaries come from the tarball,
# NOT apt — these clients are only used out-of-band and are wire-compatible.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# HOME + AUTOPG_CONFIG_DIR both point at /var/lib/autopg so getAutopgRoot() and
# getConfigDir() resolve the binary cache and settings.json under one tree.
ENV HOME=/var/lib/autopg \
    AUTOPG_CONFIG_DIR=/var/lib/autopg

# Non-root runtime user owning the state tree.
RUN groupadd -g 1000 autopg \
    && useradd -u 1000 -g 1000 -d /var/lib/autopg -s /usr/sbin/nologin autopg

# 1) the compiled autopg binary (dispatches `postmaster`, provisioning, etc.)
COPY --from=fetch /stage/autopg/autopg /usr/local/bin/autopg

# 2) THE GOTCHA: pre-seed the binary cache at
#    $AUTOPG_CONFIG_DIR/bin/linux-arm64/{bin,lib,share} and drop the `.version`
#    marker so isCachedValid() short-circuits before any npm fetch.
COPY --from=fetch /stage/autopg/postgres/ /var/lib/autopg/bin/linux-arm64/

RUN set -eux; \
    printf '%s\n' "${PG_VERSION_MARKER}" > /var/lib/autopg/bin/linux-arm64/.version; \
    chmod +x /usr/local/bin/autopg; \
    mkdir -p /var/lib/autopg/data /var/run/autopg; \
    chown -R autopg:autopg /var/lib/autopg /var/run/autopg; \
    # sanity: binaries present + marker correct
    test -x /var/lib/autopg/bin/linux-arm64/bin/postgres; \
    test -x /var/lib/autopg/bin/linux-arm64/bin/initdb; \
    grep -qx "${PG_VERSION_MARKER}" /var/lib/autopg/bin/linux-arm64/.version

USER autopg
WORKDIR /var/lib/autopg
EXPOSE 5432

# The postmaster is PID 1. It installs SIGTERM/SIGINT handlers for a graceful
# postgres shutdown (bin/postgres-server.js) — pair with a generous
# terminationGracePeriodSeconds. Data dir + socket dir are overridable via the
# chart's `command`/`args`; these defaults make `docker run autopg:dev` work.
# PGDATA is a subdir of the data mount so the non-root user (uid 1000) owns it
# under a k8s PVC (whose root is owned root:fsGroup) and initdb's chmod 0700
# succeeds. The chart overrides these args; these defaults keep `docker run`
# working standalone.
ENTRYPOINT ["autopg", "postmaster"]
CMD ["--port", "5432", "--data", "/var/lib/autopg/data/pgdata", "--socket-dir", "/var/run/autopg", "--log", "info"]
