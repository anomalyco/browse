#!/usr/bin/env bash
# Copies this working tree (committed or not) to the box and rebuilds there, for testing fixes without pushing.
#   stress/exe/deploy.sh [host]        # default host: browse-stress.exe.xyz, reached with `wssh`
# Leaves the box's .git, node_modules, builds and pairing code alone, restarts the relay on the new build and reloads
# the extension. The extension is built with the harness's test hooks (OPENCODE_BROWSER_TEST_HOOKS=1).
set -euo pipefail
HOST="${1:-browse-stress.exe.xyz}"
SSH="${BROWSE_STRESS_SSH:-wssh}"
cd "$(dirname "$0")/../.."
rsync -az --delete -e "$SSH" \
  --exclude .git --exclude node_modules --exclude dist --exclude cli/dist --exclude cli/extension \
  --exclude release --exclude relay-pairing.json --exclude stress-results \
  ./ "$HOST:browse/"
"$SSH" "$HOST" 'bash -se' <<'REMOTE'
set -uo pipefail
export PATH=/usr/local/bin:$HOME/.bun/bin:$PATH OPENCODE_BROWSER_UPDATE_CHECK=0
cd ~/browse
(cd cli && OPENCODE_BROWSER_TEST_HOOKS=1 bun build.ts)
# Restart first: `pair` runs `session list`, which refuses a relay of another build (lifecycle.ts relayBuildProblem).
node cli/dist/cli.mjs relay restart --force   # a stress box: nothing a fuzz run left (flight recorders) is worth keeping
# Feed the unpacked extension a real one-time code without running install (which edits the user's MCP config).
umask 077
(node cli/dist/cli.mjs pair --wait-seconds 1 || true) | jq -Rse '{code: capture("Pairing code: (?<code>[0-9A-Z]{4}-[0-9A-Z]{4})").code}' > dist/relay-pairing.json
sudo -n systemctl restart browse-chrome
# Restarting Chrome alone can restore the previous unpacked service worker from the profile's cache.
node --input-type=module <<'JS'
import { BrowserCdp } from './stress/lib/cdp.ts'
import { sleep } from './stress/lib/env.ts'
for (let i = 0; i < 30; i++) {
  const cdp = await BrowserCdp.connect().catch(() => undefined)
  try {
    const scheduled = await cdp?.evalInExtension('typeof setTimeout === "function" && typeof chrome?.runtime?.reload === "function" && !!setTimeout(() => chrome.runtime.reload(), 100)').catch(() => false)
    if (scheduled) break
  } finally { cdp?.close() }
  await sleep(1000)
}
JS
for _ in $(seq 1 60); do
  if node cli/dist/cli.mjs status --json | jq -e --slurpfile expected dist/build.json '
    select(.relay.running and (.relay.stale == false) and .extension.connected and .extension.build == $expected[0].build)
    | {relay: .relay, extension: (.extension | {connected, version, build, protocolVersion})}'; then exit 0; fi
  sleep 1
done
echo 'Timed out waiting for the new extension build to connect' >&2
exit 1
REMOTE
