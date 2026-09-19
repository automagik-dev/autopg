#!/usr/bin/env bash
#
# tarball-smoke.sh — Group 7 of autopg-distribution-cutover.
#
# Validates the *shape* of an assembled tarball without depending on
# real postgres binaries. Use this in CI to gate every job in the
# build matrix.
#
# Modes:
#   --fixture     Stage synthetic stub binaries, run the full
#                 build → fetch (stub) → assemble → smoke pipeline.
#                 Does NOT require bun or @embedded-postgres on the
#                 runner; safe for any host.
#   --real        Smoke the real dist/ output produced by the build
#                 matrix. Requires that scripts/build-binary.sh and
#                 scripts/fetch-postgres-bins.sh have already run
#                 against the requested --platform. Also boots the
#                 shipped console (`autopg ui`) and curls it.
#
# Exit codes:
#   0  pass
#   1  fail (assertion missed)
#   2  invalid args / missing inputs

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST_DIR="${AUTOPG_DIST_DIR:-${REPO_ROOT}/dist}"
PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)

PASS=0
FAIL=0

ok()   { echo "    ✓ $*";              PASS=$((PASS + 1)); }
fail() { echo "    ✗ $*" >&2;          FAIL=$((FAIL + 1)); }

usage() {
  cat <<EOF
Usage: $0 [--fixture | --real] [--platform <p>] [--version <v>]

  --fixture    Stage synthetic stubs; runs without bun + postgres pkgs.
  --real       Smoke real dist/ output from build matrix.
  --platform   One of: ${PLATFORMS[*]}; default: detect host.
  --version    Default reads package.json.
EOF
}

detect_host_platform() {
  local kernel arch
  kernel=$(uname -s)
  arch=$(uname -m)
  case "${kernel}-${arch}" in
    Linux-x86_64)  echo "linux-x64-glibc" ;;
    Linux-aarch64) echo "linux-arm64" ;;
    Darwin-x86_64) echo "darwin-x64" ;;
    Darwin-arm64)  echo "darwin-arm64" ;;
    *) echo "linux-x64-glibc" ;;
  esac
}

parse_args() {
  MODE="fixture"
  PLATFORM=""
  VERSION="${AUTOPG_VERSION:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --fixture) MODE="fixture"; shift ;;
      --real)    MODE="real";    shift ;;
      --platform) PLATFORM="$2"; shift 2 ;;
      --version)  VERSION="$2";  shift 2 ;;
      -h|--help)  usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  [[ -z "$PLATFORM" ]] && PLATFORM="$(detect_host_platform)"
  if [[ -z "$VERSION" ]]; then
    VERSION=$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "0.0.0")
  fi
}

stage_fixture() {
  echo "==> staging fixture for ${PLATFORM}"
  local stage="${DIST_DIR:?}/${PLATFORM:?}/autopg"
  rm -rf "${DIST_DIR:?}/${PLATFORM:?}"
  mkdir -p "${stage}/postgres/bin" "${stage}/postgres/share"

  cat > "${stage}/autopg" <<EOF
#!/usr/bin/env sh
case "\$1" in
  --version) echo "autopg ${VERSION}" ;;
  *) echo "autopg ${VERSION} (fixture stub)" ;;
esac
EOF
  chmod +x "${stage}/autopg"

  cat > "${stage}/postgres/bin/postgres" <<'EOF'
#!/usr/bin/env sh
echo "postgres (PostgreSQL) 16.10 (fixture stub)"
EOF
  chmod +x "${stage}/postgres/bin/postgres"

  cat > "${stage}/postgres/bin/initdb" <<'EOF'
#!/usr/bin/env sh
echo "initdb (PostgreSQL) 16.10 (fixture stub)"
EOF
  chmod +x "${stage}/postgres/bin/initdb"

  echo 'fixture-timezone-data' > "${stage}/postgres/share/timezone.txt"

  # Console stub: assemble-tarball.sh ships $AUTOPG_CONSOLE_DIST as
  # autopg/console/dist/ and would otherwise `bun run console:build`, which
  # this mode must not need (no bun / node_modules on the fixture runner).
  local console_stub="${DIST_DIR:?}/${PLATFORM:?}/console-fixture"
  mkdir -p "$console_stub"
  echo '<!doctype html><title>autopg console (fixture stub)</title>' > "${console_stub}/index.html"
  echo '/* fixture stub */' > "${console_stub}/app.js"
  export AUTOPG_CONSOLE_DIST="$console_stub"
}

run_assemble() {
  bash "${REPO_ROOT}/scripts/assemble-tarball.sh" \
    --platform "$PLATFORM" --version "$VERSION"
}

# Pick a free loopback TCP port (node is already a dependency of this script).
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}

# --real only: boot the console out of the extracted tree and prove it
# serves — this is the operator-visible symptom of issue #161 (the v3.2.0
# tarball had no console/dist/, so `autopg ui` died on "console assets not
# found" and `autopg install` skipped the autopg-ui pm2 process).
assert_console_serves() {
  local root="$1" scratch="$2"
  if ! command -v curl >/dev/null 2>&1; then
    echo "    - curl not found; skipping console serve check"
    return 0
  fi

  local cfg="${scratch}/config" log="${scratch}/ui.log" port
  mkdir -p "$cfg"
  port=$(free_port)

  AUTOPG_CONFIG_DIR="$cfg" "${root}/autopg" ui --no-open --port "$port" >"$log" 2>&1 &
  local pid=$!

  # Bounded wait (~10s) for the listener; the binary boots in well under 1s.
  local code="" attempts=50
  while (( attempts-- > 0 )); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/" 2>/dev/null || true)
    [[ "$code" == "200" || "$code" == "401" ]] && break
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  # 401 = Basic Auth challenge in front of the console (no admin.json in the
  # scratch config dir); 200 would mean auth is disabled. Anything else means
  # the console never came up — dump the log for the CI transcript.
  if [[ "$code" == "401" || "$code" == "200" ]]; then
    ok "autopg ui serves the console from the tarball (HTTP ${code})"
  else
    fail "autopg ui did not serve the console (last HTTP code: '${code}')"
    sed 's/^/      | /' "$log" >&2
  fi
  if grep -q 'console assets not found' "$log"; then
    fail "autopg ui printed 'console assets not found'"
  else
    ok "autopg ui found the console assets"
  fi
}

assert_outputs() {
  local tarball="${DIST_DIR}/autopg-${VERSION}-${PLATFORM}.tar.gz"
  local outer_sha="${tarball}.sha256"

  [[ -f "$tarball" ]]   && ok "tarball exists: $(basename "$tarball")" || fail "tarball missing"
  [[ -f "$outer_sha" ]] && ok "outer .sha256 exists" || fail "outer .sha256 missing"

  # outer-sha matches actual content
  local computed
  if command -v sha256sum >/dev/null 2>&1; then
    computed=$(sha256sum "$tarball" | awk '{print $1}')
  else
    computed=$(shasum -a 256 "$tarball" | awk '{print $1}')
  fi
  local recorded
  recorded=$(awk '{print $1}' "$outer_sha")
  [[ "$computed" == "$recorded" ]] && ok "outer SHA256 matches tarball bytes" \
                                   || fail "outer SHA256 drift: $computed vs $recorded"

  # extract + inspect contents
  local scratch
  scratch=$(mktemp -d)
  # shellcheck disable=SC2064  # expand $scratch now, not when trap fires
  trap "rm -rf \"$scratch\"" EXIT

  tar -xzf "$tarball" -C "$scratch"

  for required in \
      autopg/autopg \
      autopg/postgres/bin/postgres \
      autopg/console/dist/index.html \
      autopg/console/dist/app.js \
      autopg/manifest.json; do
    [[ -e "${scratch}/${required}" ]] && ok "tarball contains: ${required}" \
                                       || fail "tarball missing: ${required}"
  done

  # exec — autopg --version reports the right line
  local version_line
  if version_line=$("${scratch}/autopg/autopg" --version 2>/dev/null); then
    if echo "$version_line" | grep -qE "autopg ${VERSION//./\\.}"; then
      ok "autopg --version → ${version_line}"
    else
      fail "autopg --version unexpected: ${version_line}"
    fi
  else
    fail "autopg binary not executable"
  fi

  # exec — postgres --version reports something postgres-shaped
  if version_line=$("${scratch}/autopg/postgres/bin/postgres" --version 2>/dev/null); then
    if echo "$version_line" | grep -qiE "postgres.*\(PostgreSQL\)"; then
      ok "postgres --version → ${version_line}"
    else
      fail "postgres --version unexpected: ${version_line}"
    fi
  else
    fail "postgres binary not executable"
  fi

  # --real: the compiled binary must resolve the console next to itself
  # (a non-serving probe: `ui --help` prints usage + the resolved root),
  # then actually serve it. The fixture's `autopg` is a shell stub that
  # knows only --version, so both checks are real-mode only.
  if [[ "$MODE" == "real" ]]; then
    # process.execPath is symlink-resolved (macOS: /var → /private/var), so
    # compare against the physical scratch path.
    local scratch_real help_out
    scratch_real=$(cd "$scratch" && pwd -P)
    help_out=$("${scratch}/autopg/autopg" ui --help 2>&1 || true)
    if echo "$help_out" | grep -q "console root: ${scratch_real}/autopg/console/dist"; then
      ok "autopg ui --help resolves console root next to the binary"
    else
      fail "autopg ui --help did not resolve the shipped console root"
      echo "$help_out" | sed 's/^/      | /' >&2
    fi
    assert_console_serves "${scratch}/autopg" "$scratch"
  fi

  # manifest.json sanity
  local manifest="${scratch}/autopg/manifest.json"
  if [[ -f "$manifest" ]]; then
    local pf ver
    pf=$(node -p "require('${manifest}').platform" 2>/dev/null || echo "")
    ver=$(node -p "require('${manifest}').version"  2>/dev/null || echo "")
    [[ "$pf"  == "$PLATFORM" ]] && ok "manifest.platform == ${PLATFORM}" \
                                || fail "manifest.platform drift: ${pf}"
    [[ "$ver" == "$VERSION" ]]  && ok "manifest.version == ${VERSION}" \
                                || fail "manifest.version drift: ${ver}"

    # the console must be covered by the per-file hashes (it is served to
    # a browser; an unlisted file would escape cosign's attestation)
    local console_listed
    console_listed=$(node -p "require('${manifest}').files.some((f) => f.path === 'autopg/console/dist/index.html')" 2>/dev/null || echo "false")
    [[ "$console_listed" == "true" ]] && ok "manifest lists autopg/console/dist/index.html" \
                                      || fail "manifest does not list autopg/console/dist/index.html"

    # spot-check one per-file SHA from the manifest
    local first_path first_sha
    first_path=$(node -p "require('${manifest}').files[0].path"   2>/dev/null || echo "")
    first_sha=$( node -p "require('${manifest}').files[0].sha256" 2>/dev/null || echo "")
    if [[ -n "$first_path" && -f "${scratch}/${first_path}" ]]; then
      local recomputed
      if command -v sha256sum >/dev/null 2>&1; then
        recomputed=$(sha256sum "${scratch}/${first_path}" | awk '{print $1}')
      else
        recomputed=$(shasum -a 256 "${scratch}/${first_path}" | awk '{print $1}')
      fi
      [[ "$recomputed" == "$first_sha" ]] && ok "manifest sha matches: ${first_path}" \
                                          || fail "manifest sha drift: ${first_path}"
    else
      fail "manifest.files[0].path not found in tarball"
    fi
  fi
}

main() {
  parse_args "$@"
  mkdir -p "$DIST_DIR"

  echo "==> mode=${MODE} platform=${PLATFORM} version=${VERSION}"

  case "$MODE" in
    fixture)
      stage_fixture
      run_assemble
      ;;
    real)
      if [[ ! -f "${DIST_DIR}/autopg-${VERSION}-${PLATFORM}.tar.gz" ]]; then
        echo "==> --real: tarball missing; running assemble step now"
        run_assemble
      fi
      ;;
    *) echo "error: unknown mode" >&2; exit 2 ;;
  esac

  assert_outputs

  echo
  echo "==> ${PASS} passed, ${FAIL} failed"
  [[ $FAIL -eq 0 ]] || exit 1
}

main "$@"
