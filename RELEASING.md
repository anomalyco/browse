# Releasing browse

One version ships two artifacts: the Chrome Web Store extension (`opencode-browser-<version>.zip`) and the npm package
`@opencode/browse` (`opencode-browse-<version>.tgz`, the CLI, relay and MCP server). The package carries no extension:
an npm install gets it from its channel's store item, and only a checkout loads `dist/` unpacked. Two channels, as
Deadbolt has (dev and stable; its beta channel isn't used):

| Channel | Starts from | Version | Publishes |
| --- | --- | --- | --- |
| `dev` | every push to `main` (not Markdown-only) | `<next>-dev.<run>`, e.g. `0.2.1-dev.57` (store `0.2.1.57`) | npm `dev`, the private dev store item *Browse Dev*; no approval, no GitHub release |
| `latest` | `bun run release [patch\|minor\|major]` on `main` (tag `v0.2.1`) | as tagged | npm `latest`, the public store item, a GitHub release; approved |

`<next>` is the patch after the version in `cli/package.json`, so dev builds sort above the last release and below the
next, and each run is newer than the last, on npm and in the store (`scripts/version.ts`; a rerun adds `.<attempt>` on
npm and keeps the store version). The dev version is stamped into the checkout in CI, never committed. Installs follow
their channel: `npx @opencode/browse@dev install` stays on `dev` (`cli/src/auto-update.ts`) and opens the dev item, whose
ID dev builds have baked in (`cli/src/paths.ts`).

Dev replaces the old beta channel (unlisted item, `-beta.N` tags): the team gets every `main` build through a private
item Chrome keeps updated, which is what the beta was for, with one less channel and item to run.

**The dev item and review.** A store item holds one submission at a time, and private items are reviewed too. When a
dev build arrives while an earlier one is still in review, `publish-cws` skips the upload (the npm package still
publishes); the first push after the review ends uploads the newest build. Cancelling the pending review instead
(`cancelSubmission`) would restart review on every push, and a busy `main` would never get a build through. To replace
pending builds anyway, set `CWS_DEV_IF_PENDING=cancel`. A stable release fails when an earlier stable version is still
in review (`scripts/cws.ts --if-pending`).

```
bun run release ──► commit "release: v0.2.1" + tag v0.2.1 ──► git push --atomic origin main v0.2.1
                                                                   │
  verify: installs, typechecks, builds, tests, tag = versions, changelog  ▼
  build:  store zip + npm tarball + artifact checks + SHA256SUMS (once; every later job uses these files)
  attest: build provenance for both (Sigstore)
     ├─► publish-npm  [approve: environment npm]               gh attestation verify, npm publish --provenance --tag latest
     └─► publish-cws  [approve: environment chrome-web-store]  gh attestation verify, upload + submit for review
              └─► github-release: changelog entry, zip, tarball, SHA256SUMS, attestation
```

A push to `main` runs the same jobs with the dev version, in the `npm-dev` and `chrome-web-store-dev` environments (no
reviewers, `main` only), with dist-tag `dev` and the dev item, and no GitHub release. Both publish jobs check, with
`gh attestation verify`, that the files they publish are the ones this workflow built and attested. A stable tag fails
the build when `CWS_ITEM_ID` isn't set; a dev build only warns about `CWS_DEV_ITEM_ID`, but its `publish-cws` fails
until it's set. Run the workflow by hand (Actions → Release → Run workflow) with `dry_run` on for a rehearsal that
publishes nothing; `bun run release:check` does the build and checks locally.

## One-time setup

Do these once, in order. Each step says where to click or what to run.

### 1. Chrome Web Store items

The API can update items but not create them, so create both items by hand in the
[developer dashboard](https://chrome.google.com/webstore/devconsole) (Anomaly's publisher, which must belong to the
anoma.ly Google Workspace for the dev item's domain visibility).

1. **Check the old ID.** Earlier code pointed at item `mfnicocicmmlkpjnaffgihfjhdgjkdjg`; the relay no longer trusts
   it unless a release configures it. Look for it in the dashboard. If it's Anomaly's item, use it as the stable item
   below (its ID goes in `CWS_ITEM_ID`) instead of creating a new one.
2. **Stable item.** Build a zip with `bun run release:check` and use `release/opencode-browser-<version>.zip`. In the
   dashboard click **New item** and upload it. Fill in **Store listing** and **Privacy** from
   [store/listing.md](store/listing.md), set visibility to **Public**, and submit it.
3. **Dev item.** Build a dev zip: `bun scripts/version.ts dev --run 1 && bun run release:check`, then
   `git checkout -- cli/package.json package.json public/manifest.json`. Upload `release/opencode-browser-0.0.3-dev.1.zip`
   (named *Browse Dev*) with **New item**, copy the listing and privacy answers, and under **Distribution → Visibility**
   choose **Private** → *Everyone at anoma.ly* (the Workspace domain), then submit it. Team members install it once from
   its store page (or `npx @opencode/browse@dev install` opens it), and Chrome keeps it updated.
   - Why a separate item: dev builds ship as `0.2.1.57`, which on the stable item would rank above the stable `0.2.1`
     that follows, and the stable release would be refused. A private item also keeps every `main` build off the public
     listing.
4. **Publisher ID.** Copy it from **Account** (Publisher settings) in the dashboard.
5. **Repository variables.** These are IDs, not secrets.

   ```sh
   gh variable set CWS_PUBLISHER_ID --repo anomalyco/browse --body <publisher id>
   gh variable set CWS_ITEM_ID      --repo anomalyco/browse --body <stable item id>
   gh variable set CWS_DEV_ITEM_ID  --repo anomalyco/browse --body <dev item id>
   ```

   Every npm build has both IDs baked in: the relay trusts both store extensions, and `install` opens its channel's
   item and pairs it through its status page. Delete the old `CWS_BETA_ITEM_ID` and `CWS_ITEM_LISTED` variables if set.

### 2. Chrome Web Store API credentials

1. In a Google Cloud project owned by Anomaly, enable the
   [Chrome Web Store API](https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com).
2. **OAuth consent screen** ([Google Auth Platform](https://console.cloud.google.com/auth/overview)): choose *Internal*
   if the publisher account is in Anomaly's Workspace, otherwise *External*. For *External*, set the publishing status
   to **In production**. In *Testing*, refresh tokens expire after 7 days and releases start failing.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**, named `browse release`. The script below
   receives the code on a `127.0.0.1` redirect, which Desktop clients allow without configuration.
4. Store the client in both store environments (create them first, step 3):

   ```sh
   for env in chrome-web-store chrome-web-store-dev; do
     gh secret set CWS_CLIENT_ID     --env $env --repo anomalyco/browse
     gh secret set CWS_CLIENT_SECRET --env $env --repo anomalyco/browse
   done
   ```

5. Get the refresh token. Sign in as the Google account with access to the publisher:

   ```sh
   bun scripts/cws-auth.ts --set-secret
   ```

   The script asks for the client ID and secret (hidden), opens Google's consent page (PKCE, a one-time loopback
   redirect), and pipes the refresh token straight into `gh secret set CWS_REFRESH_TOKEN --env chrome-web-store`.
   Nothing is written to disk, and without `--set-secret` it prints the token once instead. Run it without
   `--set-secret` and set the printed token in `chrome-web-store-dev` too
   (`gh secret set CWS_REFRESH_TOKEN --env chrome-web-store-dev --repo anomalyco/browse`).

   The token can publish every item of the publisher, so whoever can push to `main` could, by changing the workflow,
   publish to the stable item without approval. To close that, publish the dev item from a separate Google account
   (its own refresh token in `chrome-web-store-dev`) that only has access to the dev item.
6. Check it without publishing: `CWS_CLIENT_ID=… CWS_CLIENT_SECRET=… CWS_REFRESH_TOKEN=… CWS_PUBLISHER_ID=… CWS_ITEM_ID=… bun scripts/cws.ts status`.

Later hardening: a service account through
[Workload Identity Federation](https://developer.chrome.com/docs/webstore/service-accounts) would replace the long-lived
refresh token with GitHub's OIDC token.

### 3. GitHub environments and tag rules

1. **Settings → Environments → New environment**, twice for stable: `npm` and `chrome-web-store`. For each one:
   - **Required reviewers**: Ryan and at least one other maintainer. Turn on **Prevent self-review** once two people
     can approve.
   - **Deployment branches and tags** → *Selected branches and tags* → add a **tag** rule `v*`, so only release tags
     can use the environment's secrets.
2. **Two more for dev builds, `npm-dev` and `chrome-web-store-dev`**: no required reviewers (every push to `main`
   publishes, as in Deadbolt), and *Selected branches and tags* → a **branch** rule `main` only. `npm-dev` holds no
   secret once npm trusted publishing is set up.
3. **Settings → Rules → Rulesets → New tag ruleset**: target `v*`, restrict creations, updates and deletions to
   maintainers, so only maintainers can start a release.
4. **Main.** Anyone who can push to `main` publishes a dev build, so protect it: **Settings → Rules → Rulesets → New
   branch ruleset** on `main`, requiring pull requests and blocking force pushes, with maintainers allowed to bypass
   (`bun run release` pushes the release commit to `main` directly). Add CODEOWNERS for `.github/` and `scripts/`.
5. **Settings → Actions → General**: turn on *Require actions to be pinned to a full-length commit SHA*. Every action in
   both workflows already is.

Secrets live only in these environments. An approval gates every stable publish; dev builds trade that for a build per
push, guarded by `main`'s ruleset and the dev environments admitting only `main`. The workflow has no
`pull_request` trigger and starts with `permissions: {}`.

### 4. npm

1. Make sure your npm account can publish to the `@opencode` scope (`npm org ls opencode`).
2. **Temporary token, until trusted publishing is set up.** On npmjs.com go to Access Tokens → Generate New Token →
   **Granular**: read and write for the `@opencode` scope, expiring in 30 days. Then:

   ```sh
   gh secret set NPM_TOKEN --env npm     --repo anomalyco/browse
   gh secret set NPM_TOKEN --env npm-dev --repo anomalyco/browse
   ```

3. Cut the first release (below). It creates `@opencode/browse` on npm.
4. **Switch to trusted publishing.** On npmjs.com open `@opencode/browse` → **Settings** → **Trusted publishing** and
   add two *GitHub Actions* publishers (a package can have several), each allowed to `npm publish`: organization
   `anomalyco`, repository `browse`, workflow `release.yml`, one with environment `npm` and one with environment
   `npm-dev`. Pinning both to an environment means a workflow on any other branch can't publish. Then:

   ```sh
   gh secret delete NPM_TOKEN --env npm     --repo anomalyco/browse
   gh secret delete NPM_TOKEN --env npm-dev --repo anomalyco/browse
   ```

   Revoke the token on npmjs.com. (The workflow only writes an `.npmrc` when `NPM_TOKEN` has a value, so with the secret
   gone npm uses OIDC.) Under the package's **Settings → Publishing access**, choose *Require two-factor
   authentication and disallow tokens*. The workflow needs no change: it already has `id-token: write`, Node 24
   (npm 11.5+), and `npm publish --provenance`, and npm uses OIDC when no token is set.
   See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers).

## Cutting a release

**Dev** needs nothing: merge to `main`. Try it with `npx @opencode/browse@dev install`; it opens *Browse Dev* in the store.

**Stable**, from an up-to-date `main`:

```sh
bun run release            # patch (or minor, major, or an exact 0.2.0); the first run drafts changelog/<version>.md and stops
$EDITOR changelog/0.2.1.md
bun run release            # bumps the versions, runs release:check, commits "release: v0.2.1", tags v0.2.1,
                           # then asks and runs git push --atomic origin main v0.2.1
```

`--no-push` stops after the tag and prints the push command; `--yes` pushes without asking. Open the run under
**Actions → Release**, check the verify, build and attest jobs, then approve `npm` and `chrome-web-store`. The workflow
refuses a stable tag that isn't on `main`.

The changelog follows the Anomaly format: frontmatter `date` and `summary`, then `## Major` (a `### Title`, a sentence
or two, an optional `Icon: icons/<slug>.svg`), `## Improvements` and `## Fixes`, one line each, written for the person
using it. `bun scripts/changelog.ts check <version>` lints it.

After the run, the job summary shows the store review state (usually `PENDING_REVIEW`; review takes hours to a few
days). npm users get the new version within a day (dev installs too, for each dev build): the relay checks once a day
and switches when no agent is using the browser.

**If a step fails**, fix it and rerun the failed jobs. Publishing is idempotent: a version that's already on npm or
already submitted to the store is skipped.

## Undoing a bad release

- **npm.** Auto-update only moves forward, so publish a fixed patch release. `npm deprecate @opencode/browse@<bad> "<why>"`
  warns new installs. A user can run `npx @opencode/browse rollback` to go back to the version they had (auto-update
  then skips the bad one).
- **Chrome Web Store.** Roll back to the previous version in the dashboard
  ([how](https://developer.chrome.com/docs/webstore/rollback)), or cancel a pending review with `cancelSubmission`.

## Compatibility between the extension and the CLI

The extension (store updates) and the CLI (npm auto-update) update independently, so either can be ahead for a day or
so. The relay accepts extension protocols from `minExtensionProtocolVersion` to `extensionProtocolVersion`
(`cli/src/protocol.ts`, both 2 today). Bump `extensionProtocolVersion` only for a change an older relay can't handle, and
raise the minimum only when dropping older extensions. When they don't match, the status page, `status`, `doctor` and
tool errors name the side that's behind and how to update it.
