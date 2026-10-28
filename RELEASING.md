# Releasing browse

One version ships two artifacts: the Chrome Web Store extension (`opencode-browser-<version>.zip`) and the npm package
`@opencode/browse` (`opencode-browse-<version>.tgz`, the CLI, relay and MCP server). `bun run release <version>` cuts
it locally; pushing the tag runs [the release workflow](.github/workflows/release.yml), which publishes after a person
approves.

```
bun run release 0.2.0 ──► commit "release: v0.2.0" + tag v0.2.0 ──► git push origin main v0.2.0
                                                                          │
  verify: installs, typechecks, builds, tests, tag = versions, changelog  ▼
  build:  store zip + npm tarball + artifact checks + SHA256SUMS (once; every later job uses these files)
  attest: build provenance for both (Sigstore)
     ├─► publish-npm  [approve: environment npm]               npm publish --provenance, dist-tag latest | beta
     └─► publish-cws  [approve: environment chrome-web-store]  upload + submit for review (stable or beta item)
              └─► github-release: changelog entry, zip, tarball, SHA256SUMS, attestation
```

`v1.2.3` is stable (npm `latest`, the public store item). `v1.2.3-beta.4` is a beta (npm `beta`, the unlisted beta store
item, a GitHub prerelease). Run the workflow by hand (Actions → Release → Run workflow) with `dry_run` on for a full
rehearsal that publishes nothing; `bun run release:check` does the build and checks locally.

## One-time setup

Do these once, in order. Each step says where to click or what to run.

### 1. Chrome Web Store items

The API can update items but not create them, so create both items by hand in the
[developer dashboard](https://chrome.google.com/webstore/devconsole) (Anomaly's publisher).

1. **Check the old ID.** The code used to point at item `mfnicocicmmlkpjnaffgihfjhdgjkdjg`. Look for it in the
   dashboard. If it isn't Anomaly's item, also delete `chromeWebStoreExtensionOrigin` in `cli/src/relay-helpers.ts`, so
   the relay stops accepting connections from that origin. Pairing still protects it, but there's no reason to allow it.
2. **Stable item.** Build a zip with `bun run release:check` and use `release/opencode-browser-<version>.zip`. In the
   dashboard click **New item** and upload it. Fill in **Store listing** and **Privacy** from
   [store/listing.md](store/listing.md), set visibility to **Public**, and submit it.
3. **Beta item.** Click **New item** again, upload the same zip, name it *OpenCode Browser (Beta)*, copy the same listing
   and privacy answers, set visibility to **Unlisted**, and submit it.
   - Why a separate item: the store only accepts numeric versions, so beta `0.2.0-beta.1` ships as `0.2.0.1`
     (`version_name` shows the full name). On one shared item, that beta would rank above the stable `0.2.0` that
     follows it, and the stable release would be refused.
   - The other option is trusted testers on the stable item (Distribution → visibility → trusted testers). It only
     works if every beta's number is lower than the next stable release's, which gets in the way. Not used.
4. **Publisher ID.** Copy it from **Account** (Publisher settings) in the dashboard.
5. **Repository variables.** These are IDs, not secrets.

   ```sh
   gh variable set CWS_PUBLISHER_ID --repo anomalyco/browse --body <publisher id>
   gh variable set CWS_ITEM_ID      --repo anomalyco/browse --body <stable item id>
   gh variable set CWS_BETA_ITEM_ID --repo anomalyco/browse --body <beta item id>
   ```

   Every npm build now has the IDs baked in, so `install` recognizes the store extension and pairs it through its
   status page.
6. **Once the stable listing has passed review and is public:**
   `gh variable set CWS_ITEM_LISTED --repo anomalyco/browse --body true`. From the next release on,
   `npx @opencode/browse install` sends new users to the store listing instead of the unpacked build. Checkouts always
   keep the unpacked flow.

### 2. Chrome Web Store API credentials

1. In a Google Cloud project owned by Anomaly, enable the
   [Chrome Web Store API](https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com).
2. **OAuth consent screen** ([Google Auth Platform](https://console.cloud.google.com/auth/overview)): choose *Internal*
   if the publisher account is in Anomaly's Workspace, otherwise *External*. For *External*, set the publishing status
   to **In production**. In *Testing*, refresh tokens expire after 7 days and releases start failing.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**, named `browse release`. The script below
   receives the code on a `127.0.0.1` redirect, which Desktop clients allow without configuration.
4. Store the client in the `chrome-web-store` environment (create the environment first, step 3):

   ```sh
   gh secret set CWS_CLIENT_ID     --env chrome-web-store --repo anomalyco/browse
   gh secret set CWS_CLIENT_SECRET --env chrome-web-store --repo anomalyco/browse
   ```

5. Get the refresh token. Sign in as the Google account with access to the publisher:

   ```sh
   bun scripts/cws-auth.ts --set-secret
   ```

   The script asks for the client ID and secret (hidden), opens Google's consent page (PKCE, a one-time loopback
   redirect), and pipes the refresh token straight into `gh secret set CWS_REFRESH_TOKEN --env chrome-web-store`.
   Nothing is written to disk, and without `--set-secret` it prints the token once instead.
6. Check it without publishing: `CWS_CLIENT_ID=… CWS_CLIENT_SECRET=… CWS_REFRESH_TOKEN=… CWS_PUBLISHER_ID=… CWS_ITEM_ID=… bun scripts/cws.ts status`.

Later hardening: a service account through
[Workload Identity Federation](https://developer.chrome.com/docs/webstore/service-accounts) would replace the long-lived
refresh token with GitHub's OIDC token.

### 3. GitHub environments and tag rules

1. **Settings → Environments → New environment**, twice: `npm` and `chrome-web-store`. For each one:
   - **Required reviewers**: Ryan and at least one other maintainer. Turn on **Prevent self-review** once two people
     can approve.
   - **Deployment branches and tags** → *Selected branches and tags* → add a **tag** rule `v*`, so only release tags
     can use the environment's secrets.
2. **Settings → Rules → Rulesets → New tag ruleset**: target `v*`, restrict creations, updates and deletions to
   maintainers, so only maintainers can start a release.
3. **Settings → Actions → General**: turn on *Require actions to be pinned to a full-length commit SHA*. Every action in
   both workflows already is.

Secrets live only in these environments, and an approval gates every job that can read them. The workflow has no
`pull_request` trigger and starts with `permissions: {}`.

### 4. npm

1. Make sure your npm account can publish to the `@opencode` scope (`npm org ls opencode`).
2. **Temporary token, until trusted publishing is set up.** On npmjs.com go to Access Tokens → Generate New Token →
   **Granular**: read and write for the `@opencode` scope, expiring in 30 days. Then:

   ```sh
   gh secret set NPM_TOKEN --env npm --repo anomalyco/browse
   ```

3. Cut the first release (below). It creates `@opencode/browse` on npm.
4. **Switch to trusted publishing.** On npmjs.com open `@opencode/browse` → **Settings** → **Trusted publishing** →
   *GitHub Actions*: organization `anomalyco`, repository `browse`, workflow `release.yml`, environment `npm`. Then:

   ```sh
   gh secret delete NPM_TOKEN --env npm --repo anomalyco/browse
   ```

   Revoke the token on npmjs.com. (The workflow only writes an `.npmrc` when `NPM_TOKEN` has a value, so with the secret
   gone npm uses OIDC.) Under the package's **Settings → Publishing access**, choose *Require two-factor
   authentication and disallow tokens*. The workflow needs no change: it already has `id-token: write`, Node 24
   (npm 11.5+), and `npm publish --provenance`, and npm uses OIDC when no token is set.
   See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers).

## Cutting a release

**Beta**, from any branch:

```sh
bun run release 0.2.0-beta.1   # the first run writes a draft changelog/0.2.0-beta.1.md and stops
$EDITOR changelog/0.2.0-beta.1.md
bun run release 0.2.0-beta.1   # bumps the versions, runs release:check, commits, tags v0.2.0-beta.1
git push origin HEAD v0.2.0-beta.1
```

Open the run under **Actions → Release**, check the verify, build and attest jobs, then approve `npm` and
`chrome-web-store`. Beta users install it with `npx @opencode/browse@beta install` (auto-update keeps them on the beta
channel) and the unlisted beta item's link.

**Stable** works the same way, from `main`: `bun run release 0.2.0`, edit the changelog, run it again, then
`git push origin main v0.2.0`. The workflow refuses a stable tag that isn't on `main`.

The changelog follows the Anomaly format: frontmatter `date` and `summary`, then `## Major` (a `### Title`, a sentence
or two, an optional `Icon: icons/<slug>.svg`), `## Improvements` and `## Fixes`, one line each, written for the person
using it. `bun scripts/changelog.ts check <version>` lints it.

After the run, the job summary shows the store review state (usually `PENDING_REVIEW`; review takes hours to a few
days). npm users get the new version within a day: the relay checks once a day and switches when no agent is using the
browser.

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
