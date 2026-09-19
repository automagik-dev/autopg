#!/usr/bin/env bash
#
# assemble-tarball.sh — Group 7 of autopg-distribution-cutover.
#
# Assembles a single platform tarball with the locked shape:
#
#   autopg/
#     autopg                  # static binary (from build-binary.sh)
#     postgres/
#       bin/*                 # postgres + initdb + libpq + ...
#       share/*               # timezone data, locale, etc.
#     console/
#       dist/*                # built console SPA (`bun run console:build`)
#     manifest.json           # per-file SHA256 + size
#
# The tarball lives at:
#   dist/autopg-<version>-<platform>.tar.gz
# and a sibling .sha256 file holds the outer hash for Group 8 (cosign sign)
# and Group 9 (CDN publish) to consume.
#
# Inputs come from dist/<platform>/autopg/{autopg, postgres/}, populated by
# build-binary.sh + fetch-postgres-bins.sh. The console is platform
# independent: it is built once from console/src/ (when console/dist/ is
# missing) and copied into every platform's stage — `autopg ui` looks for
# it next to the executable in a release install (issue #161: v3.2.0
# shipped without it, so no release ever had the console).
#
# Usage:
#   scripts/assemble-tarball.sh --platform linux-x64-glibc
#   scripts/assemble-tarball.sh --all --version 2.260503.1
#
# Environment:
#   AUTOPG_DIST_DIR       Override output root (default: $REPO/dist)
#   AUTOPG_CONSOLE_DIST   Prebuilt console dir to ship instead of
#                         $REPO/console/dist (the fixture smoke stages a
#                         stub here so it never needs bun)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${AUTOPG_DIST_DIR:-${REPO_ROOT}/dist}"
CONSOLE_DIST="${AUTOPG_CONSOLE_DIST:-${REPO_ROOT}/console/dist}"

PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)

usage() {
  cat <<EOF
Usage: $0 (--platform <p> | --all) [--version <v>]

Platforms: ${PLATFORMS[*]}

Inputs (must already exist):
  dist/<platform>/autopg/autopg               (build-binary.sh)
  dist/<platform>/autopg/postgres/bin/*       (fetch-postgres-bins.sh)
  dist/<platform>/autopg/postgres/share/*     (fetch-postgres-bins.sh)
  console/dist/*                              (built here via bun when missing)

Outputs:
  dist/autopg-<version>-<platform>.tar.gz
  dist/autopg-<version>-<platform>.tar.gz.sha256
EOF
}

parse_args() {
  TARGET_PLATFORM=""
  ASSEMBLE_ALL=0
  VERSION="${AUTOPG_VERSION:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --platform) TARGET_PLATFORM="$2"; shift 2 ;;
      --all)      ASSEMBLE_ALL=1; shift ;;
      --version)  VERSION="$2"; shift 2 ;;
      -h|--help)  usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  if [[ "$ASSEMBLE_ALL" -eq 0 && -z "$TARGET_PLATFORM" ]]; then
    echo "error: pass --platform <p> or --all" >&2; usage; exit 2
  fi

  if [[ -z "$VERSION" ]]; then
    VERSION=$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "0.0.0")
  fi
}

# Portable SHA256 — use sha256sum on linux, shasum -a 256 on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Emit manifest.json for the given platform's staged tree.
# Walks autopg/ relative to <root>/, skipping manifest.json itself.
emit_manifest() {
  local root="$1" platform="$2" out="$3"

  pushd "$root" >/dev/null
  {
    printf '{\n'
    printf '  "name": "autopg",\n'
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "platform": "%s",\n' "$platform"
    printf '  "schemaVersion": 1,\n'
    printf '  "files": [\n'

    local first=1
    while IFS= read -r f; do
      [[ "$f" == "autopg/manifest.json" ]] && continue
      local h sz
      h=$(sha256_of "$f")
      sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")
      if [[ $first -eq 1 ]]; then
        first=0
      else
        printf ',\n'
      fi
      printf '    { "path": "%s", "sha256": "%s", "size": %d }' "$f" "$h" "$sz"
    done < <(find autopg -type f | LC_ALL=C sort)

    printf '\n  ]\n'
    printf '}\n'
  } > "$out"
  popd >/dev/null
}

console_dist_is_built() {
  [[ -f "${CONSOLE_DIST}/index.html" && -f "${CONSOLE_DIST}/app.js" ]]
}

# Make sure a built console exists at $CONSOLE_DIST. console/dist/ is
# gitignored and produced by `bun run console:build`; the CI build job
# compiles the binary without ever running `bun install`, so the SPA's deps
# (react, react-dom) are installed here first when absent.
ensure_console_dist() {
  console_dist_is_built && return 0

  if [[ "$CONSOLE_DIST" != "${REPO_ROOT}/console/dist" ]]; then
    echo "error: AUTOPG_CONSOLE_DIST=${CONSOLE_DIST} has no index.html + app.js" >&2
    return 1
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "error: console/dist/ is missing and bun is not installed (run \`bun run console:build\` first)" >&2
    return 1
  fi

  if [[ ! -f "${REPO_ROOT}/node_modules/react/package.json" \
     || ! -f "${REPO_ROOT}/node_modules/react-dom/package.json" ]]; then
    echo "==> console deps missing: bun install"
    # The committed bun.lock lags package.json (optionalDependencies), so a
    # frozen install — which `--production` and `--no-save` both imply —
    # refuses to run. Do a plain install and put the lockfile back: this
    # script builds artifacts, it does not rewrite repo state. Swap for
    # `bun install --production --frozen-lockfile` once the lock is in sync.
    local lock="${REPO_ROOT}/bun.lock" lock_bak=""
    if [[ -f "$lock" ]]; then
      lock_bak=$(mktemp) && cp "$lock" "$lock_bak"
    fi
    local rc=0
    (cd "$REPO_ROOT" && bun install --ignore-scripts) || rc=$?
    if [[ -n "$lock_bak" ]]; then
      cp "$lock_bak" "$lock" && rm -f "$lock_bak"
    fi
    [[ $rc -eq 0 ]] || return 1
  fi

  # package.json depends on the npm `bun` package, whose postinstall is what
  # fetches the real binary. With --ignore-scripts that leaves a stub at
  # node_modules/.bin/bun, and `bun run` puts node_modules/.bin ahead of PATH,
  # so the `bun build …` inside console:build exec'd the stub: "Exec format
  # error" on every release runner (v3.2.1 build). The console build only
  # needs the bun on PATH; drop the stub.
  if [[ -e "${REPO_ROOT}/node_modules/.bin/bun" ]]; then
    rm -f "${REPO_ROOT}/node_modules/.bin/bun"
  fi

  echo "==> bun run console:build"
  (cd "$REPO_ROOT" && bun run console:build) || return 1
  console_dist_is_built || {
    echo "error: console:build finished but ${CONSOLE_DIST} lacks index.html + app.js" >&2
    return 1
  }
}

# Copy the built console into the stage as autopg/console/dist/. Always
# re-synced so a rebuilt SPA never ships stale next to a fresh binary.
stage_console() {
  local stage="$1"
  rm -rf "${stage}/autopg/console"
  mkdir -p "${stage}/autopg/console/dist" || return 1
  cp -R "${CONSOLE_DIST}/." "${stage}/autopg/console/dist/" || return 1
}

# Verify staged inputs are present + executable.
verify_inputs() {
  local stage="$1" platform="$2"
  local missing=0
  for required in autopg/autopg autopg/postgres/bin/postgres autopg/console/dist/index.html; do
    if [[ ! -f "${stage}/${required}" ]]; then
      echo "error: ${platform}: missing ${required}" >&2
      missing=1
    fi
  done
  return $missing
}

assemble_one() {
  local platform="$1"
  local stage="${DIST_DIR}/${platform}"
  local tarball="${DIST_DIR}/autopg-${VERSION}-${platform}.tar.gz"
  local outer_sha="${tarball}.sha256"

  if [[ ! -d "${stage}/autopg" ]]; then
    echo "error: ${stage}/autopg/ does not exist (run build-binary.sh + fetch-postgres-bins.sh first)" >&2
    return 1
  fi

  echo "==> [${platform}] assemble tarball"
  # `assemble_one` is invoked from main as `assemble_one ... || rc=$?` which
  # disables `set -e` for the duration of this function. Each potentially-
  # failing command needs explicit `|| return 1` to halt early instead of
  # silently producing a corrupt tarball (gemini bot review HIGH on PR #84).
  stage_console "$stage" || return 1
  verify_inputs "$stage" "$platform" || return 1

  # 1) emit per-file manifest BEFORE the tarball is rolled — manifest is
  #    bundled inside.
  emit_manifest "$stage" "$platform" "${stage}/autopg/manifest.json" || return 1

  # 2) ensure binaries are executable inside the tar.
  chmod +x "${stage}/autopg/autopg" || true
  find "${stage}/autopg/postgres/bin" -type f -exec chmod +x {} +

  # 3) build deterministic tarball: sorted entries, locked mtime.
  local tar_flags=()
  if tar --help 2>&1 | grep -q -- '--sort=name'; then
    tar_flags+=(--sort=name)
  fi
  if tar --help 2>&1 | grep -q -- '--mtime='; then
    tar_flags+=(--mtime=2026-01-01)
  fi
  if tar --help 2>&1 | grep -q -- '--owner='; then
    tar_flags+=(--owner=0 --group=0 --numeric-owner)
  fi

  # macOS ships bash 3.2, where `"${arr[@]}"` on an EMPTY array trips
  # `set -u` ("unbound variable"). On macOS BSD-tar none of the GNU-only
  # flags above match, so tar_flags is empty and every darwin-* assemble
  # died here (pre-existing; only surfaced once builds reached this step).
  # `${arr[@]+"${arr[@]}"}` expands to nothing when unset, the flags when set.
  tar -C "$stage" -czf "$tarball" ${tar_flags[@]+"${tar_flags[@]}"} autopg/ || return 1
  echo "    ✓ tarball: $tarball ($(du -h "$tarball" | cut -f1))"

  # 4) outer SHA256 — Group 8 cosign-signs this; Group 9 publishes both.
  sha256_of "$tarball" > "$outer_sha" || return 1
  echo "    ✓ sha256:  $(cat "$outer_sha")  $(basename "$tarball")"
}

main() {
  parse_args "$@"
  mkdir -p "$DIST_DIR"
  ensure_console_dist || exit 1

  local rc=0
  if [[ "$ASSEMBLE_ALL" -eq 1 ]]; then
    for p in "${PLATFORMS[@]}"; do
      assemble_one "$p" || rc=$?
    done
  else
    assemble_one "$TARGET_PLATFORM" || rc=$?
  fi
  exit $rc
}

main "$@"
