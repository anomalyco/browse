# Releasing browse

One version ships an extension zip, the npm package `@opencode/browse` (`opencode-browse-<version>.tgz`: a Node
launcher, for `npx` and `npm install -g`) and the `browse` binaries. The npm package carries no extension.

The CLI, relay and MCP server are the Rust `browse` binary (crate `rust/crates/browse`, workspace `rust/`; the
TypeScript CLI in `cli/` is kept as the reference and isn't built or released anymore). `@opencode/browse` holds only
`dist/cli.mjs` ([rust/npm/browse.mjs](rust/npm/browse.mjs)), which runs the binary of the optional dependency npm
installed for the machine, `@opencode/browse-<target>`; `dist/cli.mjs` stays the bin path because agent configs written
by the TypeScript CLI run `node .../dist/cli.mjs mcp`. The version is baked into the binary at build time
(`BROWSE_VERSION`, with the run's `BROWSE_BUILD_ID`), and `rust/Cargo.toml`/`Cargo.lock` carry it too
(`scripts/version.ts`). Each binary is published two ways:
as an npm package `@opencode/browse-<target>` holding `bin/browse` (`bin/browse.exe` on Windows) and a package.json with
`os`, `cpu` and, on Linux, `libc`; and as one target per binary on Anomaly's release service, which the [install
script](install) downloads. The [release service](#the-release-service) file is
`opencode-browse-<target>-<version>.tgz`; it carries the same verified bytes as the npm package. Targets:
`linux-x64`, `linux-x64-baseline`, `linux-arm64`, `linux-x64-musl`, `linux-x64-baseline-musl`, `linux-arm64-musl`,
`darwin-arm64`, `darwin-x64`, `darwin-x64-baseline`, `windows-x64`, `windows-x64-baseline` (Windows on ARM64 runs x64).
The service names macOS `macos-*`. A `-baseline` target carries the same binary as its base target (Rust's x86-64
target doesn't use AVX2), and `@opencode/browse` depends only on the seven base targets. Locally:
`cd rust && BROWSE_VERSION=<version> script/release.sh linux-x64 linux-x64-musl`, then
`bun scripts/npm-package.ts platforms --binaries rust/dist --out <dir>` (with `--target <name>` for only some) and
`bun scripts/npm-package.ts main --out <dir>`.

Releases run only in GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)). Nobody has release
secrets locally, and nothing is built, tagged or published from a laptop. Work lands on `dev`, the default branch.

| Mode | Starts from | Version | Publishes |
| --- | --- | --- | --- |
| dev | every push to `dev` (not Markdown-only) | `<next patch>-dev.<run>`, e.g. `0.2.1-dev.57` | the [release service](#the-release-service) channel `dev` (`browse-extension-<version>.zip`, loaded unpacked, and every CLI binary target), then npm dist-tag `dev` (the binaries, then `@opencode/browse`) |
| stable | **Actions → Release → Run workflow** on `dev` with a bump or version and release notes | `x.y.z` | tag `v<version>`, the [release service](#the-release-service) channel `stable` (the extension zip and every CLI binary target), npm `latest`, the public Chrome Web Store item (`browse-extension-<version>.zip`), the GitHub release |
| check | the same button with bump `check` and no version, on any branch (`gh workflow run release.yml --ref <branch>`) | `cli/package.json` | nothing: builds, checks and attests the stable artifacts and runs every publish script, the release service included, as a dry run |

There's no `production` branch: browse has no website. If it gets one, the site deploys from `production`, as in
opencode and Hex; releases still come from `dev`.

## Cutting a stable release

1. Write the notes: `bun run release --draft` writes `release-notes.md` from the commits since the last tag. The format
   is a summary line, then `## Major` (a `### Title`, a sentence or two, an optional `Icon: icons/<slug>.svg`),
   `## Improvements` and `## Fixes`, one line each, written for the person using it. No `TODO` may be left.
2. Dispatch: **Actions → Release → Run workflow**, branch `dev`, bump `patch`/`minor`/`major` (or an exact version)
   and the notes. The notes field is a single line in the browser, so `bun run release patch release-notes.md` does
   the same with `gh workflow run`.
3. The run (only repository admins and maintainers may start one; `plan` checks the dispatching actor):

```
plan    version from cli/package.json + bump; actor is admin or maintain; notes well-formed; not on npm yet
tag     commits the versions (cli/package.json, package.json, public/manifest.json, rust/Cargo.toml, rust/Cargo.lock)
        and changelog/<version>.md from the notes on the dispatched commit, pushes only the tag v<version> (deploy key);
        git, sed, awk and jq only
build   from the tag: install, typecheck, extension and cargo tests, release:check (zip + npm launcher tarball +
        artifact checks), SHA256SUMS digest
build-binary    one job per Rust build (linux gnu/musl x64/arm64 with cargo-zigbuild, glibc 2.17; macOS arm64/x64 on
        macos-15; windows-x64 with a static C runtime), version and build id baked in; no secrets
build-binaries  packs and checks the @opencode/browse-<target> tarballs (every target; baseline = base binary), runs
        the linux-x64 ones: the install script against a local release service, relay + MCP, npm install of
        @opencode/browse with its platform package
sign-macos      optional (repository variable MACOS_SIGNING=true): Developer ID signs the macOS binaries; skipped now
sign-windows    optional (repository variable WINDOWS_SIGNING=true): Authenticode signs the Windows binaries (Azure
        Trusted Signing; Smart App Control blocks an unsigned browse.exe); skipped now
attest  build provenance for the zip and every tarball (Sigstore)
publish-release-service       the extension and every CLI binary target to the release service (channel dev or
        stable); a check run prints the list and publishes nothing
publish-npm  +  publish-cws   npm latest (--ignore-scripts, provenance; the platform packages first, then
        @opencode/browse) and Chrome Web Store upload + submit (none when the extension is unchanged)
publish-github-release        the release on v<version>: notes, zip, tarball, SHA256SUMS, attestation
push-release-to-dev           pushes the release commit to dev (deploy key), so dev builds count up from it
```

The store review takes hours to a few days (the job summary shows `PENDING_REVIEW`); `publish-cws` cancels an
earlier version still in review, so the newest build is the one reviewed. When the zip is the extension the store
already has, with only the manifest `version`/`version_name` changed (a CLI or packaging release), it uploads and
submits nothing, says so in the job summary, and the release goes on: the store keeps the version it has, and the
GitHub release and the release commit to dev still run. Binary installs follow the release service at launch and at
least hourly, and switch when no agent is using the browser; npm installs check once an hour and switch the same way;
the Chrome Web Store updates the extension.

**If a job fails**, fix it and rerun the failed jobs. Publishing is idempotent: a version that's already on npm,
already submitted to the store, or already current on the release service is skipped, and the tag is reused when it
holds the same tree.

A `publish-cws` 400 from `:publish` saying the submission "does not meet the requirements to be published in the
store" means a dashboard field needs fixing, not the build: correct it in the
[developer dashboard](https://chrome.google.com/webstore/devconsole) (most often a new manifest permission's
justification under **Privacy practices**, worded from [store/listing.md](store/listing.md)), click **Submit for
review** there, then rerun the failed job. The rerun sees the version in review and skips the store step, letting the
GitHub release and the release commit to dev go ahead.

## The security boundary

Every job that holds a secret, an OIDC token or a write token (tag, attest, every publish job) runs only code in
`.github/`: the workflow file and the shell scripts in [.github/release/](.github/release/), checked out with a sparse
checkout of `/.github/release/`. Those jobs treat the build artifacts as data: each artifact must match the SHA256SUMS
digest its job reported and, before publishing, its GitHub attestation from this workflow on `dev`. They never run
repository code, `bun install` or package lifecycle scripts. Only `build` runs repository code, and it has no
environment, secrets or id-token. The tag job checks out the repository but runs only `tag-release.sh` (git and jq,
hooks off).

So `.github/` is what to protect: [.github/CODEOWNERS](.github/CODEOWNERS) makes Dax and Ryan its owners, and the
rulesets below require their review. The jobs that need a secret run in the environment `release`, which admits only
`dev`, and fetch it from AWS Secrets Manager ([Secrets](#secrets)).

## How a dev install gets its extension

The dev zip keeps the manifest `key`, so it loads with the same unpacked ID as a checkout's `dist/`, which the relay
trusts, and every dev build still publishes it to the release service
(`https://anoma.ly/release/browse/extension/dev/chromium`). The Rust CLI doesn't fetch it: `browse install` points at
the Chrome Web Store item on every channel, and the store build works with dev CLIs (the relay keeps accepting older
extension protocols). To try a dev extension, download the zip, unpack it and load it unpacked, then `browse pair`;
`browse extension` prints these steps on the dev channel and the README's Updates section has them. (The TypeScript CLI baked the dev zip's sha256 in and unpacked it into
`<cache root>/extension`; that is gone with it.) Dev builds never go to the Chrome Web Store: every upload is
reviewed, too slow for a build per push.

## The release service

`https://anoma.ly/release` is Anomaly's update service ([anomalyco/release](https://github.com/anomalyco/release)).
Like Hex and OpenCode, a job in a named environment trades its GitHub OIDC token for a publish session through
`client.sh` ([.github/release/publish-release-service.sh](.github/release/publish-release-service.sh)); the service
checks the token against `registry/browse.json` there ([scripts/release-registry.json](scripts/release-registry.json)).

| Artifact | Target | File | Latest link |
| --- | --- | --- | --- |
| `extension` | `chromium` | `browse-extension-<version>.zip` (the store build on stable, unpacked on dev); `opencode-browser-<version>.zip` on releases before the rename | https://anoma.ly/release/browse/extension/stable/chromium |
| `cli` | `linux-x64`, `linux-x64-baseline`, `linux-arm64`, `linux-x64-musl`, `linux-x64-baseline-musl`, `linux-arm64-musl` | `opencode-browse-<target>-<version>.tgz` | https://anoma.ly/release/browse/cli/stable/linux-x64 |
| `cli` | `macos-arm64`, `macos-x64`, `macos-x64-baseline` (files say `darwin-*`) | `opencode-browse-darwin-<arch>-<version>.tgz` | https://anoma.ly/release/browse/cli/stable/macos-arm64 |
| `cli` | `windows-x64`, `windows-x64-baseline` | `opencode-browse-windows-<arch>-<version>.tgz` | https://anoma.ly/release/browse/cli/stable/windows-x64 |

Every target has a `.../<target>/info` with its version, size and SHA-256. `install` reads the manifest, checks the
file's size and SHA-256 and installs it; a binary install's updater polls `cli/<stable|dev>.json` at launch and at
least hourly with `If-None-Match` and User-Agent `browse/<channel>/<version>/cli`. `--version` stays on npm because the
protocol has one current release per channel and no version lookup. npm global installs keep reading npm's dist-tag.

A TypeScript binary install's updater (0.0.17 and earlier) runs the install script baked into the binary it is running,
so those releases keep reading future channel manifests with their own installer: the cli tarballs keep the layout
`package/bin/browse[.exe]`. The Rust binary's updater ([rust/crates/browse/src/update.rs](rust/crates/browse/src/update.rs))
reads the manifest itself and unpacks the same tarball. When a TypeScript relay has installed the Rust binary it runs
`browse runtime-switch <version>`, and the Rust CLI stops any TypeScript relay it finds (POST /shutdown), so the Rust
relay takes over ([rust/crates/browse/src/legacy.rs](rust/crates/browse/src/legacy.rs)). Manifest changes must stay readable by
older installers: relative `url`s, flat target objects, and `release.version` before any other `version` key.

## One-time setup

1. **Default branch** `dev` (Settings → General).
2. **Release service.** Open a PR on anomalyco/release updating [scripts/release-registry.json](scripts/release-registry.json)
   as `registry/browse.json` (listed in `registry/index.ts`): workflow `.github/workflows/release.yml` on
   `refs/heads/dev` in environment `release`, artifacts `cli` and `extension`, channels `stable`, `beta` and `dev`.
   Stable and dev share the ref because browse's stable release is a `workflow_dispatch` on `dev` (the tag job pushes
   `v<version>`, but the run's OIDC ref stays `refs/heads/dev`); `plan-release.sh` is what keeps a push to dev from
   publishing stable. Merge and deploy it there **before the next stable release**: until then the service refuses the
   stable channel, and the installer has no stable manifest to read.
3. **Chrome Web Store item.** The API can't create items, so create it in the
   [developer dashboard](https://chrome.google.com/webstore/devconsole) with Anomaly's publisher (or reuse
   `mfnicocicmmlkpjnaffgihfjhdgjkdjg` if it's Anomaly's): upload the zip from `bun run release:check`, fill in the
   listing from [store/listing.md](store/listing.md), set it **Public**. Then the repository variables (IDs, not
   secrets): `gh variable set CWS_PUBLISHER_ID --body <id>` and `gh variable set CWS_ITEM_ID --body <id>`.
4. **Chrome Web Store API.** In an Anomaly Google Cloud project enable the Chrome Web Store API, set the OAuth consent
   screen to *Internal* (or *External*, **In production**: testing refresh tokens expire in 7 days), and create an
   OAuth client of type **Desktop app**. The client ID is a repository variable
   (`gh variable set CWS_CLIENT_ID --body <id>`); the client secret goes to AWS as `browse/release/CWS_CLIENT_SECRET`
   (`read -rs VALUE && printf %s "$VALUE" | bun set browse release CWS_CLIENT_SECRET`, in
   [anomalyco/secrets](https://github.com/anomalyco/secrets)). Then run `bun scripts/cws-auth.ts` signed in as the
   publisher's Google account and pipe the refresh token it prints into
   `bun set browse release CWS_REFRESH_TOKEN`; nothing goes to disk.
5. **Environment `release`** (Settings → Environments): *Deployment branches and tags* → *Selected* → branch `dev`
   only. No required reviewers: who may release is decided by `plan`'s admin/maintain check and the rulesets. It holds
   no secrets: it is the environment claim the AWS role's trust requires ([Secrets](#secrets)). Delete the old `npm`,
   `chrome-web-store`, `release-dev`, `npm-dev` and `chrome-web-store-dev` environments.
6. **Release deploy key.** `ssh-keygen -t ed25519 -N "" -C "browse release tags" -f release-tag-key`; add
   `release-tag-key.pub` under Settings → Deploy keys with write access, store the private key as
   `browse/release/RELEASE_TAG_KEY` (`bun set browse release RELEASE_TAG_KEY < release-tag-key`), and delete both files.
7. **Rulesets** (Settings → Rules):
   - branch `dev`: require a pull request with code owner review, block force pushes and deletion; bypass:
     *Repository admin* and *Deploy keys* (the release commit comes back to dev with the deploy key).
   - tags `v*`: restrict creation, updates and deletion; bypass: *Repository admin* and *Deploy keys* (the tag job).
8. **Actions** (Settings → Actions → General): require actions pinned to a full-length commit SHA.
9. **npm.** Every package publishes with trusted publishing: `@opencode/browse` and each `@opencode/browse-<target>`
   trust GitHub Actions in `anomalyco/browse`, workflow `release.yml`. There is no npm token anywhere.

   The eleven platform packages are set up already (November 2026): trusted publishing can only be configured on a
   package that exists, so each `@opencode/browse-<target>` was published once by hand as an empty `0.0.0` on the
   `placeholder` tag, then trusted like `@opencode/browse`, with no environment restriction. A new target needs the same:

   ```sh
   npm publish --access public --tag placeholder   # in a folder with just package.json (name, version 0.0.0) and a README
   npm trust github "@opencode/browse-<target>" --file release.yml --repository anomalyco/browse --allow-publish -y
   ```

   `npm trust list @opencode/browse-<target>` checks one.
10. **macOS signing (optional).** Without it the macOS binaries carry the ad-hoc signature the Rust linker gives
    them, which runs fine from the install script and npm (neither sets quarantine). To sign with a Developer ID:
    the certificate is `shared/APPLE_SIGNING_CERTIFICATE` in AWS (a Developer ID Application certificate exported
    without a password, base64 encoded, shared with every Anomaly app); then `gh variable set MACOS_SIGNING --body true`
    and the sign-macos job runs, with publish-npm taking the macOS packages only from it.
11. **Windows signing (optional).** Without it `browse.exe` is unsigned and Windows Smart App Control blocks it, so
    install fails there. To sign with Azure Trusted Signing: a Trusted Signing account and certificate profile, and an
    Azure identity with a federated credential for this repository's `release` environment (issuer
    `https://token.actions.githubusercontent.com`, subject `repo:anomalyco/browse:environment:release`, audience
    `api://AzureADTokenExchange`). Then the six repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
    `AZURE_SUBSCRIPTION_ID`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` and
    `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`, and `gh variable set WINDOWS_SIGNING --body true`: the sign-windows
    job signs every `browse.exe` in the Windows tarballs over OIDC (no secret), checks each signature and repacks them,
    and publish-npm and the release service take the Windows packages only from it. macOS and Windows signing are
    independent; either, both or neither can be on.

## Secrets

Release secrets live in AWS Secrets Manager (account `anomaly-secrets`), managed from
[anomalyco/secrets](https://github.com/anomalyco/secrets). A job that needs one runs in the `release` environment and
assumes `role/github/browse-release` with its GitHub OIDC token, fetching only the secrets it uses; the role's trust
requires that environment, and it can read `browse/release/*` and `shared/APPLE_SIGNING_CERTIFICATE`. Set a value with
`bun set browse release <NAME>` in that repo; no release secret is stored in GitHub. npm needs none (trusted
publishing).

| Secret | Use |
| --- | --- |
| `browse/release/RELEASE_TAG_KEY` | the release deploy key: `tag` pushes `v<version>`, `push-release-to-dev` pushes the release commit |
| `browse/release/CWS_CLIENT_SECRET`, `browse/release/CWS_REFRESH_TOKEN`, var `CWS_CLIENT_ID` | the Chrome Web Store API (`publish-cws`) |
| `shared/APPLE_SIGNING_CERTIFICATE` | `sign-macos`, when the repository variable `MACOS_SIGNING` is true |

The Chrome Web Store ids are repository variables, not secrets: `CWS_CLIENT_ID`, `CWS_PUBLISHER_ID` and `CWS_ITEM_ID`, as
are the signing switches (`MACOS_SIGNING`, `WINDOWS_SIGNING`) and the Azure ids the Windows signer logs in with.

## Undoing a bad release

- **npm.** npm users move forward, so release a fixed patch. `npm deprecate @opencode/browse@<bad> "<why>"`
  warns new installs; a user can rerun the installer with `--version <good>` (which installs from npm) to go back.
- **Chrome Web Store.** Roll back in the dashboard ([how](https://developer.chrome.com/docs/webstore/rollback)), or
  cancel a pending review.
- **Release service.** Binary installs follow the channel's current release: `promote` an earlier release with
  `client.sh action ... --action promote` (anomalyco/release docs/publishing.md), or publish a fixed patch. Because
  versions are never ordered, promoting the earlier one is a rollback even though its version is lower.

## Compatibility between the extension and the CLI

The store extension and the CLI update independently, so either can be ahead for an hour or so; a dev install's
extension moves with its CLI. The relay accepts extension protocols from `minExtensionProtocolVersion` to
`extensionProtocolVersion` (`cli/src/protocol.ts`). Bump `extensionProtocolVersion` only for a change an older relay
can't handle, and raise the minimum only when dropping older extensions. When they don't match, the status page,
`status` and tool errors name the side that's behind.
