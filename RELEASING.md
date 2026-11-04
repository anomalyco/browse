# Releasing browse

One version ships an extension zip, the npm package `@opencode/browse` (`opencode-browse-<version>.tgz`: the CLI,
relay and MCP server, for `npx`) and the `browse` binaries. The npm package carries no extension.

The binaries are `bun build --compile` executables of the same CLI (`cli/script/compile.ts`), each published like
opencode's `@opencode/cli-<target>` as an npm package `@opencode/browse-<target>` holding `bin/browse` (`bin/browse.exe`
on Windows) and a package.json with `os`, `cpu` and, on Linux, `libc`. The [install script](install) picks the target and
downloads `https://registry.npmjs.org/@opencode/browse-<target>/-/browse-<target>-<version>.tgz`, the version from the
dist-tag (`latest` or `dev`). Targets: `linux-x64`, `linux-x64-baseline`, `linux-arm64`, `linux-x64-musl`,
`linux-x64-baseline-musl`, `linux-arm64-musl`, `darwin-arm64`, `darwin-x64`, `darwin-x64-baseline`, `windows-x64`,
`windows-x64-baseline` (Windows on ARM64 runs x64). Locally: `cd cli && bun script/compile.ts linux-x64 && bun
script/pack.ts` (no target: all of them; `BUN_COMPILE_RELEASE=bun-v<version>` cross-compiles against verified Bun
runtimes, as the release does).

Releases run only in GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)). Nobody has release
secrets locally, and nothing is built, tagged or published from a laptop. Work lands on `dev`, the default branch.

| Mode | Starts from | Version | Publishes |
| --- | --- | --- | --- |
| dev | every push to `dev` (not Markdown-only) | `<next patch>-dev.<run>`, e.g. `0.2.1-dev.57` | the [release service](#the-release-service) channel `dev` (`browse-extension-<version>.zip`, loaded unpacked), then npm dist-tag `dev` (the binaries, then `@opencode/browse`) |
| stable | **Actions → Release → Run workflow** on `dev` with a bump or version and release notes | `x.y.z` | tag `v<version>`, npm `latest`, the public Chrome Web Store item (`opencode-browser-<version>.zip`), the GitHub release |
| check | the same button with bump `check` and no version, on any branch | `cli/package.json` | nothing: builds, checks and attests the stable artifacts and runs every publish script as a dry run |

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
tag     commits the versions (cli/package.json, package.json, public/manifest.json) and changelog/<version>.md from the
        notes on the dispatched commit, pushes only the tag v<version> (deploy key); git and jq only
build   from the tag: install, typecheck, test, release:check (zip + tarball + artifact checks), SHA256SUMS digest
build-binaries  from the tag: compile every target against the pinned Bun release, pack and check the
        @opencode/browse-<target> tarballs, run the linux-x64 one; no secrets
sign-macos      optional (repository variable MACOS_SIGNING=true): Developer ID signs the macOS binaries; skipped now
attest  build provenance for the zip and every tarball (Sigstore)
publish-npm  +  publish-cws   npm latest (--ignore-scripts, provenance; the platform packages first, then
        @opencode/browse) and Chrome Web Store upload + submit
publish-github-release        the release on v<version>: notes, zip, tarball, SHA256SUMS, attestation
push-release-to-dev           pushes the release commit to dev (deploy key), so dev builds count up from it
```

The store review takes hours to a few days (the job summary shows `PENDING_REVIEW`); `publish-cws` cancels an
earlier version still in review, so the newest build is the one reviewed. npm users get the new version within a day:
the relay checks once a day and switches when no agent is using the browser.

**If a job fails**, fix it and rerun the failed jobs. Publishing is idempotent: a version that's already on npm,
already submitted to the store, or already current on the release service is skipped, and the tag is reused when it
holds the same tree.

## The security boundary

Every job that holds a secret, an OIDC token or a write token (tag, attest, every publish job) runs only code in
`.github/`: the workflow file and the shell scripts in [.github/release/](.github/release/), checked out with a sparse
checkout of `/.github/release/`. Those jobs treat the build artifacts as data: each artifact must match the SHA256SUMS
digest its job reported and, before publishing, its GitHub attestation from this workflow on `dev`. They never run
repository code, `bun install` or package lifecycle scripts. Only `build` runs repository code, and it has no
environment, secrets or id-token. The tag job checks out the repository but runs only `tag-release.sh` (git and jq,
hooks off).

So `.github/` is what to protect: [.github/CODEOWNERS](.github/CODEOWNERS) makes Dax and Ryan its owners, and the
rulesets below require their review. The jobs that hold secrets run in the environment `release`, which admits only
`dev`.

## How a dev install gets its extension

The dev zip keeps the manifest `key`, so it loads with the same unpacked ID as a checkout's `dist/`, which the relay
trusts. The dev CLI has the zip's sha256 baked in (`cli/build.ts`), and the zip reaches the release service before the
package reaches npm. `npx @opencode/browse@dev install` downloads exactly that zip from
`https://anoma.ly/release/browse/files/<sha256>/browse-extension-<version>.zip`, checks it, unpacks it into
`<data root>/extension` and pairs it (`cli/src/dev-extension.ts`). Install points at the Chrome Web Store build and
says nothing about that folder; `browse extension` shows it to a developer loading it unpacked. When the
relay of a newer dev version starts, it puts that version's zip in the same folder and reloads the extension. Dev
builds never go to the Chrome Web Store: every upload is reviewed, too slow for a build per push.

## The release service

`https://anoma.ly/release` is Anomaly's update service ([anomalyco/release](https://github.com/anomalyco/release)).
Like Hex and OpenCode, a job in a named environment trades its GitHub OIDC token for a publish session through
`client.sh` ([.github/release/publish-release-service.sh](.github/release/publish-release-service.sh)); the service
checks the token against `registry/browse.json` there ([scripts/release-registry.json](scripts/release-registry.json)).

| Artifact | Target | File | Latest link |
| --- | --- | --- | --- |
| `extension` | `chromium` | `browse-extension-<version>.zip` | https://anoma.ly/release/browse/extension/dev/chromium |
| `cli` | `npm` | `opencode-browse-<version>.tgz` | https://anoma.ly/release/browse/cli/dev/npm |

## One-time setup

1. **Default branch** `dev` (Settings → General).
2. **Release service.** Open a PR on anomalyco/release adding [scripts/release-registry.json](scripts/release-registry.json)
   as `registry/browse.json` (listed in `registry/index.ts`): workflow `.github/workflows/release.yml` on
   `refs/heads/dev` in environment `release`. Merge it there and deploy it (its docs/publishing.md).
3. **Chrome Web Store item.** The API can't create items, so create it in the
   [developer dashboard](https://chrome.google.com/webstore/devconsole) with Anomaly's publisher (or reuse
   `mfnicocicmmlkpjnaffgihfjhdgjkdjg` if it's Anomaly's): upload the zip from `bun run release:check`, fill in the
   listing from [store/listing.md](store/listing.md), set it **Public**. Then the repository variables (IDs, not
   secrets): `gh variable set CWS_PUBLISHER_ID --body <id>` and `gh variable set CWS_ITEM_ID --body <id>`.
4. **Chrome Web Store API.** In an Anomaly Google Cloud project enable the Chrome Web Store API, set the OAuth consent
   screen to *Internal* (or *External*, **In production**: testing refresh tokens expire in 7 days), and create an
   OAuth client of type **Desktop app**. Store `CWS_CLIENT_ID` and `CWS_CLIENT_SECRET` with
   `gh secret set <name> --env release`, then run `bun scripts/cws-auth.ts --set-secret` signed in as the publisher's
   Google account; it pipes the refresh token into `CWS_REFRESH_TOKEN` of `release`, never to disk.
5. **Environment `release`** (Settings → Environments): *Deployment branches and tags* → *Selected* → branch `dev`
   only. No required reviewers: who may release is decided by `plan`'s admin/maintain check and the rulesets. Secrets:
   `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` and `RELEASE_TAG_KEY`; npm needs none (trusted
   publishing). Delete the old `npm`, `chrome-web-store`, `release-dev`, `npm-dev` and `chrome-web-store-dev`
   environments.
6. **Release deploy key.** `ssh-keygen -t ed25519 -N "" -C "browse release tags" -f release-tag-key`; add
   `release-tag-key.pub` under Settings → Deploy keys with write access, store the private key with
   `gh secret set RELEASE_TAG_KEY --env release < release-tag-key`, and delete both files.
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
10. **macOS signing (optional).** Without it the macOS binaries carry the ad-hoc signature `bun build --compile` gives
    them, which runs fine from the install script and npm (neither sets quarantine). To sign with a Developer ID:
    `base64 -i cert.p12 | gh secret set APPLE_SIGNING_CERTIFICATE --env release` (a Developer ID Application
    certificate exported without a password), then `gh variable set MACOS_SIGNING --body true`; the sign-macos job
    then runs and publish-npm takes the macOS packages only from it.

## Undoing a bad release

- **npm.** Auto-update only moves forward, so release a fixed patch. `npm deprecate @opencode/browse@<bad> "<why>"`
  warns new installs; `npx @opencode/browse rollback` takes a user back to the version they had.
- **Chrome Web Store.** Roll back in the dashboard ([how](https://developer.chrome.com/docs/webstore/rollback)), or
  cancel a pending review.
- **Release service.** `promote` an earlier dev release (anomalyco/release docs/publishing.md).

## Compatibility between the extension and the CLI

The store extension and the CLI update independently, so either can be ahead for a day or so; a dev install's
extension moves with its CLI. The relay accepts extension protocols from `minExtensionProtocolVersion` to
`extensionProtocolVersion` (`cli/src/protocol.ts`). Bump `extensionProtocolVersion` only for a change an older relay
can't handle, and raise the minimum only when dropping older extensions. When they don't match, the status page,
`status`, `doctor` and tool errors name the side that's behind.
