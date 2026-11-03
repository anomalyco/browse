# Releasing browse

One version ships an extension zip and the npm package `@opencode/browse` (`opencode-browse-<version>.tgz`: the CLI,
relay and MCP server). The npm package carries no extension.

Work lands on `dev` (the default branch). `production` holds what was released and moves only by a fast-forward from
`dev`; nobody commits to it directly. Two channels:

| Channel | Starts from | Version | Publishes | Extension |
| --- | --- | --- | --- | --- |
| `dev` | every push to `dev` (not Markdown-only) | `<next>-dev.<run>`, e.g. `0.2.1-dev.57` | npm dist-tag `dev`, and the [release service](#the-release-service) channel `dev`; no approval | `browse-extension-<version>.zip`, loaded unpacked |
| `latest` | `bun run release [patch\|minor\|major]` on `dev`: fast-forwards `production` and runs Release from it | `cli/package.json` | npm `latest`, the public Chrome Web Store item, then the tag `v<version>` and a GitHub release; approved | `opencode-browser-<version>.zip`, the store item |

`<next>` is the patch after the version in `cli/package.json`, so dev builds sort above the last release and below the
next, and each run is newer than the last (`scripts/version.ts`; a rerun adds `.<attempt>`). The dev version is stamped
into the checkout in CI, never committed.

**Dev builds never go to the Chrome Web Store**: every upload is reviewed, which is too slow for a build per push. The
team uses the public store extension; dev builds are for anyone who wants to try `dev`.

**How a dev install gets its extension.** The dev zip keeps the manifest `key`, so it loads with the same unpacked ID as a
checkout's `dist/`, which the relay trusts. The dev CLI has the zip's sha256 baked in (`cli/build.ts`), and the release
workflow publishes the zip to the release service before the package goes to npm. `npx @opencode/browse@dev install`
downloads exactly that zip from `https://anoma.ly/release/browse/files/<sha256>/browse-extension-<version>.zip`, checks
it, unpacks it into `<data root>/extension` (`~/.local/share/opencode-browser/extension` on Linux; install prints the
path), pairs it and walks you through **Load unpacked** once (`cli/src/dev-extension.ts`). Auto-update follows npm's
`dev` tag; when the relay of a newer dev version starts, it puts that version's zip in the same folder and sends
`runtime.reload` to the connected extension, only when it's the unpacked ID and its build differs from the folder's.
Rollback works the same way in reverse. A store install is never touched.

```
bun run release ──► commit "release: v0.2.1" on dev ──► git push --atomic origin HEAD:dev HEAD:production (fast-forwards)
                ──► gh workflow run release.yml --ref production -f ref=production -f channel=stable
                                                                   │
  verify: production only, v0.2.1 not tagged yet; installs, typechecks, builds, tests, versions, changelog  ▼
  build:  extension zip + npm tarball + artifact checks + SHA256SUMS (once; every later job uses these files)
  attest: build provenance for both (Sigstore)
     ├─► publish-npm  [approve: environment npm]               gh attestation verify, npm publish --provenance --tag latest
     └─► publish-cws  [approve: environment chrome-web-store]  gh attestation verify, upload + submit for review
              └─► github-release: tag v0.2.1 on the released commit, then the release (changelog entry, zip, tarball,
                  SHA256SUMS, attestation). Last, so a failed run leaves no tag. Tags trigger nothing.

push to dev ──► verify ──► build (dev zip, CLI with its sha256) ──► attest
                   ──► publish-release [release-dev]  zip + tarball to anoma.ly/release, channel dev (OIDC, no secret)
                   ──► publish-npm     [release-dev]  npm publish --provenance --tag dev
```

Every publish job checks, with `gh attestation verify`, that its files are the ones this workflow built and attested. A
stable run fails the build when `CWS_ITEM_ID` isn't set, and refuses any branch but `production`. Run the workflow by hand
(Actions → Release → Run workflow) with channel `check` for a rehearsal that builds, checks and attests and publishes
nothing (ref `dev` builds the dev version; any other ref, the version in `cli/package.json`); `bun run release:check` does
the build and checks locally (it builds the dev zip when `cli/package.json` has a dev version).

## The release service

`https://anoma.ly/release` is Anomaly's update service (repository [anomalyco/release](https://github.com/anomalyco/release),
a Cloudflare Worker over R2). Hex, Deadbolt and Hokum publish to it the same way: a workflow job in a named environment
trades its GitHub OIDC token for a publish session with `curl https://anoma.ly/release/client.sh | bash -s -- publish …`,
uploads content-addressed files, and the service writes `<app>/<artifact>/<channel>.json` manifests. Nothing to store in
GitHub: the service checks the token against `registry/<app>.json` in that repository. Browse is app `browse`
(`scripts/release-service.sh`):

| Artifact | Target | File | Latest link |
| --- | --- | --- | --- |
| `extension` | `chromium` | `browse-extension-<version>.zip` | https://anoma.ly/release/browse/extension/dev/chromium |
| `cli` | `npm` | `opencode-browse-<version>.tgz` | https://anoma.ly/release/browse/cli/dev/npm |

Add `/info` to a link for the version, size and sha256. To try a dev build without npm, download the zip, unzip it and
load the folder unpacked; `npx @opencode/browse@dev install` does that for you and keeps it updated.

## One-time setup

### 1. Register browse with the release service

Open a PR on [anomalyco/release](https://github.com/anomalyco/release) that adds [scripts/release-registry.json](scripts/release-registry.json)
as `registry/browse.json` and lists it in `registry/index.ts` (`import browse from "./browse.json"`, add it to `apps`).
It lets `.github/workflows/release.yml` on `refs/heads/dev`, in environment `release-dev`, publish the `extension`
and `cli` artifacts on channel `dev` (repository ID `1435849068`, owner ID `66570915`). Merge it to that repository's
`dev` branch, then `git push origin dev:production` there (its docs/publishing.md). No bucket or secret is needed.

### 2. Chrome Web Store item

The API can update items but not create them, so create the stable item by hand in the
[developer dashboard](https://chrome.google.com/webstore/devconsole) with Anomaly's publisher.

1. **Check the old ID.** Earlier code pointed at item `mfnicocicmmlkpjnaffgihfjhdgjkdjg`. If it's Anomaly's item, use
   it below (its ID goes in `CWS_ITEM_ID`) instead of creating a new one.
2. **Create it.** Build a zip with `bun run release:check` and upload `release/opencode-browser-<version>.zip` with
   **New item**. Fill in **Store listing** and **Privacy** from [store/listing.md](store/listing.md), set visibility to
   **Public**, and submit it.
3. **Repository variables** (IDs, not secrets; the publisher ID is under **Account**):

   ```sh
   gh variable set CWS_PUBLISHER_ID --repo anomalyco/browse --body <publisher id>
   gh variable set CWS_ITEM_ID      --repo anomalyco/browse --body <item id>
   ```

   Every build bakes in the item ID: the relay trusts the store extension, and stable installs open its page. Delete
   `CWS_DEV_ITEM_ID`, `CWS_DEV_IF_PENDING`, `CWS_BETA_ITEM_ID` and `CWS_ITEM_LISTED` if set.

### 3. Chrome Web Store API credentials

One Google login publishes; only the approved `chrome-web-store` environment holds it.

1. In a Google Cloud project owned by Anomaly, enable the
   [Chrome Web Store API](https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com).
2. **OAuth consent screen** ([Google Auth Platform](https://console.cloud.google.com/auth/overview)): *Internal* if
   the publisher account is in Anomaly's Workspace, otherwise *External* with publishing status **In production** (in
   *Testing*, refresh tokens expire after 7 days).
3. **Credentials → Create credentials → OAuth client ID → Desktop app**, named `browse release`.
4. Store the client (create the environment first, step 4):

   ```sh
   gh secret set CWS_CLIENT_ID     --env chrome-web-store --repo anomalyco/browse
   gh secret set CWS_CLIENT_SECRET --env chrome-web-store --repo anomalyco/browse
   ```

5. Signed in as the Google account with access to the publisher, run `bun scripts/cws-auth.ts --set-secret`. It asks
   for the client ID and secret, opens Google's consent page, and pipes the refresh token into
   `gh secret set CWS_REFRESH_TOKEN --env chrome-web-store`; nothing is written to disk.
6. Check it without publishing: `CWS_CLIENT_ID=… CWS_CLIENT_SECRET=… CWS_REFRESH_TOKEN=… CWS_PUBLISHER_ID=… CWS_ITEM_ID=… bun scripts/cws.ts status`.

### 4. GitHub environments and rules

1. **Settings → Environments**, for stable: `npm` and `chrome-web-store`, each with **Required reviewers** (Ryan and at
   least one other maintainer; turn on **Prevent self-review** once two can approve) and **Deployment branches and
   tags** → *Selected* → a **branch** rule `production` only.
2. For dev: `release-dev`, with no reviewers and *Selected branches and tags* → a **branch** rule `dev` only. It holds
   no secrets (the release service and npm both use OIDC); its name is what the release service's registry and npm's
   trusted publisher check.
3. **Settings → Rules → Rulesets**: a branch ruleset on `dev` and `production` requiring pull requests and blocking
   force pushes and deletion, with maintainers allowed to bypass (`bun run release` pushes the release commit to both
   directly; the push only ever fast-forwards). Anyone who can push to `dev` publishes a dev build; only what reaches
   `production` can go stable, and only after the approvals. A tag ruleset on `v*` restricting updates and deletions
   is fine, but it must let the workflow create tags (add *GitHub Actions* as a bypass actor, or don't restrict
   creation): the run's last job creates `v<version>` with `GITHUB_TOKEN`. Add CODEOWNERS for `.github/` and
   `scripts/`.
4. **Settings → Actions → General**: turn on *Require actions to be pinned to a full-length commit SHA*.
5. Delete the old `npm-dev` and `chrome-web-store-dev` environments if they exist.

### 5. npm

1. Make sure your npm account can publish to the `@opencode` scope (`npm org ls opencode`).
2. **Until trusted publishing is set up**, a granular token (read and write for `@opencode`, 30 days):
   `gh secret set NPM_TOKEN --env npm --repo anomalyco/browse` and the same with `--env release-dev`.
3. Cut the first release (below); it creates `@opencode/browse` on npm.
4. **Trusted publishing.** On npmjs.com, `@opencode/browse` → **Settings** → **Trusted publishing**: add two *GitHub
   Actions* publishers, organization `anomalyco`, repository `browse`, workflow `release.yml`, one with environment
   `npm` and one with environment `release-dev`. Then delete both `NPM_TOKEN` secrets, revoke the token, and under
   **Publishing access** choose *Require two-factor authentication and disallow tokens*. The workflow needs no change.

## Cutting a release

**Dev** needs nothing: merge to `dev`. Try it with `npx @opencode/browse@dev install`.

**Stable**, from an up-to-date `dev`:

```sh
bun run release            # patch (or minor, major, or an exact 0.2.0); the first run drafts changelog/<version>.md and stops
$EDITOR changelog/0.2.1.md
bun run release            # bumps the versions, runs release:check, commits "release: v0.2.1" on dev, then asks,
                           # pushes it to dev and production (atomic, fast-forward only) and dispatches Release
                           # from production with channel stable, and prints the run
```

`--no-push` stops after the commit and prints the push and dispatch commands; `--yes` pushes without asking. It refuses
when `production` has commits `dev` doesn't (it can't fast-forward). In the run, check the verify, build and attest jobs,
then approve `npm` and `chrome-web-store`. Never push a release tag by hand: the run tags `v<version>` itself at the end,
and refuses a version that's already tagged. It fails while an earlier version is still in store review.

The changelog follows the Anomaly format: frontmatter `date` and `summary`, then `## Major` (a `### Title`, a sentence
or two, an optional `Icon: icons/<slug>.svg`), `## Improvements` and `## Fixes`, one line each, written for the person
using it. `bun scripts/changelog.ts check <version>` lints it.

After the run, the job summary shows the store review state (usually `PENDING_REVIEW`; review takes hours to a few
days). npm users get the new version within a day (dev installs too, with their extension): the relay checks once a day
and switches when no agent is using the browser.

**If a step fails**, fix it and rerun the failed jobs. Publishing is idempotent: a version that's already on npm,
already submitted to the store, or already current on the release service is skipped.

## Undoing a bad release

- **npm.** Auto-update only moves forward, so publish a fixed patch release. `npm deprecate @opencode/browse@<bad> "<why>"`
  warns new installs. A user can run `npx @opencode/browse rollback` to go back to the version they had (auto-update
  then skips the bad one; a dev install's extension goes back with it).
- **Chrome Web Store.** Roll back to the previous version in the dashboard
  ([how](https://developer.chrome.com/docs/webstore/rollback)), or cancel a pending review with `cancelSubmission`.
- **Release service.** `promote` an earlier dev release (anomalyco/release docs/publishing.md); this only moves the
  latest links, since a dev CLI fetches its own zip by sha256.

## Compatibility between the extension and the CLI

The store extension (store updates) and the CLI (npm auto-update) update independently, so either can be ahead for a
day or so; a dev install's extension moves with its CLI. The relay accepts extension protocols from
`minExtensionProtocolVersion` to `extensionProtocolVersion` (`cli/src/protocol.ts`, both 2 today). Bump
`extensionProtocolVersion` only for a change an older relay can't handle, and raise the minimum only when dropping
older extensions. When they don't match, the status page, `status`, `doctor` and tool errors name the side that's behind
and how to update it.
