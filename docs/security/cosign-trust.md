# pgserve cosign trust anchor reference

This is the operator-facing reference for how pgserve binaries are signed, how
to verify them locally, and how the trust roots are anchored in code. It
complements the cohort docs:

- [`docs/migrations/v2.6-from-v2.5.md`](../migrations/v2.6-from-v2.5.md) — upgrade guide
- [`docs/pgserve-meta.md`](../pgserve-meta.md) — `pgserve_meta` + `autopg_meta` schema reference
- [`docs/trust-store.md`](../trust-store.md) — `~/.pgserve/trust/identities.json` reference + `autopg trust` CLI

## TL;DR

```bash
# Download a release tarball + signing siblings
gh release download v2.6.4 --repo automagik-dev/autopg

# Verify via autopg verify (recommended — handles trust list automatically)
autopg verify autopg-2.6.4-linux-x64-glibc.tar.gz

# OR raw cosign keyless verification
cosign verify-blob \
    --certificate-identity-regexp '^https://github.com/automagik-dev/autopg/.github/workflows/sign-attest.yml@refs/tags/v.*$' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --signature autopg-2.6.4-linux-x64-glibc.tar.gz.sig \
    --certificate autopg-2.6.4-linux-x64-glibc.tar.gz.cert \
    autopg-2.6.4-linux-x64-glibc.tar.gz
```

## Trust model

pgserve uses cosign **keyless OIDC** signing (Sigstore-conventional). The
signing identity is encoded into the Fulcio certificate subject as a URI:

```
https://github.com/<owner>/<repo>/.github/workflows/<workflow>.yml@<ref>
```

Verifying a signature means verifying that the cert subject matches an entry
in the trust list. There is **no long-lived private key** held by the project;
each release tag mints a short-lived Fulcio cert via the GitHub Actions OIDC
token.

## Trust roots

Trust is layered in three tiers:

| Tier | Source | Mutability |
|------|--------|------------|
| 0 (binary build-time) | `src/cosign/trust-list.js` — `TRUSTED_IDENTITIES` | Frozen at build time; updated only by shipping a new pgserve binary |
| 1 (operator-extensible) | `~/.pgserve/trust/identities.json` | Mutated via `autopg trust add` / `remove` |
| 2 (per-consumer locked) | `autopg_meta.locked_roots` per `autopg create-app <slug>` | Snapshot of Tiers 0+1 frozen at create-app time; only that consumer reads it |

A binary verifies if **any** layer's regex matches its cert subject.

## Built-in `TRUSTED_IDENTITIES`

As of pgserve 2.6.x, three identities ship hardcoded (source:
`src/cosign/trust-list.js`):

| `id` | `publisher` | Cert subject regex |
|------|-------------|---------------------|
| `automagik-genie-release` | `@automagik/genie` | `^https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v.*$` |
| `automagik-omni-release` | `@automagik/omni` | `^https://github.com/automagik-dev/omni/.github/workflows/release.yml@refs/tags/v.*$` |
| `automagik-pgserve-release` | `pgserve` | `^https://github.com/automagik-dev/autopg/.github/workflows/sign-attest.yml@refs/tags/v.*$` |

All three pin the Sigstore GitHub Actions OIDC issuer
(`https://token.actions.githubusercontent.com`) and require the signing
workflow to have run at a `refs/tags/v*` ref.

**Why pgserve anchors on `sign-attest.yml`, not `release.yml`**: pgserve has
TWO release-related workflows. `release.yml` is the npm-publish pipeline
(modeled on khal-os/desktop) with zero cosign content. `sign-attest.yml` is
the cosign signing pipeline (Group 8 of the autopg-distribution-cutover
cohort). Renaming `sign-attest.yml` → `release.yml` would clobber the npm
workflow, so the trust regex anchors on the actual signing workflow file
(Wave A PR-A1 fix, mirror of `automagik-dev/genie` PR #1725).

## What the release pipeline ships

For each released version `v<version>`, GitHub Releases attaches one set per
platform plus an aggregate `manifest.json`:

```
autopg-<version>-linux-x64-glibc.tar.gz             # the tarball itself
autopg-<version>-linux-x64-glibc.tar.gz.sha256      # outer SHA256 receipt
autopg-<version>-linux-x64-glibc.tar.gz.sig         # cosign keyless signature
autopg-<version>-linux-x64-glibc.tar.gz.cert        # Fulcio cert (sigstore short-lived)
autopg-<version>-linux-x64-glibc.tar.gz.intoto.jsonl # SLSA L3 build provenance
# ...repeated for darwin-arm64, darwin-x64, linux-arm64, linux-x64-musl...
manifest.json                                       # aggregate metadata
```

Per-platform pipeline (see `.github/workflows/`):

```
release.yml (bump job) tags v<version>, or: git push origin v<version>
   └── build-tarballs.yml @ tag     → assembles autopg-<v>-<plat>.tar.gz + .sha256
         uploads as artifact: autopg-<v>-<plat>
         │
         └── kick-sign-attest dispatches sign-attest.yml @ tag
         ├── cosign sign-blob (keyless) → .sig + .cert
         ├── attest-build-provenance (SLSA L3) → .intoto.jsonl
         ├── cosign verify-blob (self-check) — gate-fails the run if the cert
         │     doesn't match the workflow's own identity regex
         ├── per-platform Upload signed bundle artifact
         └── aggregate job → autopg-signed-bundle-<v> (all platforms + manifest.json)
               │
               └── kick-release-publish dispatches release-publish.yml @ tag
                     ├── downloads autopg-signed-bundle-<v> (cross-run fetch)
                     ├── sanity-checks every tarball has sig+cert+intoto+sha256 siblings
                     ├── gh release create v<version> + uploads all assets
                     └── updates .well-known/latest.json (stable channel only)
```

The chain is strictly serial: each workflow dispatches the next one
(`gh workflow run --ref v<version>`) from a final job that only runs when
everything before it succeeded, so release-publish never runs unless
sign-attest verified. Closes the race window that previously shipped releases
with no signing artifacts (v2.6.0 + v2.6.1 baseline per engineer T25 audit).

The hops are explicit dispatches, not `workflow_run` triggers, for two reasons.
GitHub raises no follow-on events for a run started with `GITHUB_TOKEN`, which
is how `release.yml` starts the build, so a `workflow_run` hop never fired. And
a `workflow_run` run executes at the default branch: its certificate would read
`sign-attest.yml@refs/heads/main`, which the regex above rejects.

Rebuilding or re-signing an existing tag by hand does **not** continue the
chain. Pass `-f release=true` to build-tarballs (or `-f publish=true` to
sign-attest) to opt in.

## Verification recipes

### Verify a downloaded release tarball

```bash
gh release download v2.6.4 --repo automagik-dev/autopg
autopg verify autopg-2.6.4-linux-x64-glibc.tar.gz
```

`autopg verify` reads `TRUSTED_IDENTITIES` automatically + falls through to
`~/.pgserve/trust/identities.json`. Exit codes:
- `0` — verified
- `2` — verification rejected (cert doesn't match any trusted identity)
- `3` — invocation error (no signing material found, malformed CLI args, etc.)

### Verify against a specific consumer's locked trust roots

```bash
# Earlier: autopg create-app @my-org/my-app  (snapshots trust at that moment)
autopg verify --slug my_org_my_app autopg-2.6.4-linux-x64-glibc.tar.gz
```

This consults `autopg_meta.locked_roots` for the named slug instead of the
live trust list. Useful when operators want to pin trust at create-app time
and resist trust-list rotation.

### Raw cosign verification (no pgserve CLI)

```bash
cosign verify-blob \
    --certificate-identity-regexp '^https://github.com/automagik-dev/autopg/.github/workflows/sign-attest.yml@refs/tags/v.*$' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --signature autopg-2.6.4-linux-x64-glibc.tar.gz.sig \
    --certificate autopg-2.6.4-linux-x64-glibc.tar.gz.cert \
    autopg-2.6.4-linux-x64-glibc.tar.gz
```

Expected: `Verified OK`.

### SLSA L3 provenance verification

```bash
gh attestation verify autopg-2.6.4-linux-x64-glibc.tar.gz --owner namastexlabs
```

Checks the inline `.intoto.jsonl` provenance bundle against Sigstore Rekor.
Asserts: this exact tarball was produced by this exact build job run.

## Adding a custom trust root (operator)

If your organization signs pgserve consumers (e.g. internal apps that should
trust pgserve as a base layer), add a trust entry locally:

```bash
autopg trust add my-org-release \
    --issuer https://token.actions.githubusercontent.com \
    --identity-regexp '^https://github.com/my-org/my-app/.github/workflows/release.yml@refs/tags/v.*$' \
    --publisher '@my-org/my-app' \
    --description 'My organization release pipeline'
```

See [`docs/trust-store.md`](../trust-store.md) for the full CLI reference,
file format, and precedence rules.

## Versioning the trust list

Trust roots are baked into the pgserve binary. Adding/removing a hardcoded
entry requires:

1. Edit `src/cosign/trust-list.js` — add/modify the `Object.freeze({...})`
   entry inside `TRUSTED_IDENTITIES`
2. Update `tests/cosign/trust-list.test.js` regression coverage
3. Add a CHANGELOG entry under the next release
4. Ship a new pgserve binary

Operators DO NOT modify hardcoded trust at runtime. `autopg trust remove`
refuses to remove hardcoded entries (`autopg trust remove
automagik-pgserve-release` exits with code 1).

## Single-file `pgserve-*` binaries vs `autopg-*.tar.gz` tarballs

Two artifact shapes historically existed on the release page:

| Artifact | Shape | Purpose | Signed? |
|----------|-------|---------|---------|
| `pgserve-<plat>` / `pgserve-<plat>.exe` | Single-file Bun-compiled executable | development convenience, single-file download | No (dropped from release page in Wave A PR-A2) |
| `autopg-<v>-<plat>.tar.gz` | Tarball (binary + postgres bundle + scripts) | Production distribution | Yes (cosign keyless + SLSA L3) |

Per Wave A PR-A2 (Mismatch 7 Option 1), the single-file binaries are no
longer attached to the release page. Operators who need them can build
locally via `bun run build:binary`. Production distribution flows
exclusively through the signed tarball path.

## Legacy keyed cosign (pre-Wave A)

pgserve releases through **v2.6.1** used **keyed** cosign (with
`keys/cosign.pub` checked into the repo + `COSIGN_PRIVATE_KEY` /
`COSIGN_PASSWORD` GitHub Actions secrets). Wave A (v2.6.x+) switches to
**keyless OIDC**. Operators verifying releases:

- **v2.6.2+**: use the keyless flags above (`--certificate-identity-regexp`
  + `--certificate-oidc-issuer` + `--certificate <tarball>.cert`).
- **v2.6.0 + v2.6.1**: shipped no signing artifacts at all (the wiring gap
  between `sign-attest.yml` and `release-publish.yml` meant signatures
  never reached the release page). `autopg verify` against those releases
  returns FAIL — there's nothing to verify against. v2.6.0 + v2.6.1 are
  effectively unsigned releases; operators relying on supply-chain
  verification should upgrade to v2.6.2 or later.
- **≤v2.5.x**: predates the cosign signing pipeline entirely.

The `keys/cosign.pub` file is no longer present on `main` (it never made
it past the abandoned `wip: autopg-distribution-cutover#8` commit). The
two utility scripts that previously had stale references
(`scripts/verify-published-artifacts.sh` +
`scripts/aggregate-manifest.sh`) have been rewritten to use keyless
verification flags (`--certificate-identity-regexp` +
`--certificate-oidc-issuer` + `--certificate <tarball>.cert`). Custom
trust regexes can be threaded via `AUTOPG_TRUST_REGEX` env var or
`--trust-regex` CLI flag respectively.

## Where to file issues

Signing-pipeline bugs / trust-anchor questions:
- https://github.com/automagik-dev/autopg/issues

Sigstore / cosign upstream issues:
- https://github.com/sigstore/cosign/issues

GitHub Actions OIDC binding questions:
- https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect

## See also

- [`src/cosign/trust-list.js`](../../src/cosign/trust-list.js) — `TRUSTED_IDENTITIES` source
- [`src/cosign/trust-store.js`](../../src/cosign/trust-store.js) — user-extensible store reader/writer
- [`src/commands/trust.js`](../../src/commands/trust.js) — `autopg trust` CLI
- [`src/commands/verify.js`](../../src/commands/verify.js) — `autopg verify` CLI
- [`.github/workflows/sign-attest.yml`](../../.github/workflows/sign-attest.yml) — keyless signing pipeline
- [`.github/workflows/release-publish.yml`](../../.github/workflows/release-publish.yml) — release-page assembly
