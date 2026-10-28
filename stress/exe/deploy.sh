#!/usr/bin/env bash
# Copies this working tree (committed or not) to the box and rebuilds there, for testing fixes without pushing.
#   stress/exe/deploy.sh [host]        # default host: browse-stress.exe.xyz, reached with `wssh`
# Leaves the box's .git, node_modules, builds and pairing code alone, restarts the relay on the new build and reloads
# the extension.
set -euo pipefail
HOST="${1:-browse-stress.exe.xyz}"
SSH="${BROWSE_STRESS_SSH:-wssh}"
cd "$(dirname "$0")/../.."
rsync -az --delete -e "$SSH" \
  --exclude .git --exclude node_modules --exclude dist --exclude cli/dist --exclude cli/extension \
  --exclude release --exclude relay-pairing.json --exclude stress-results \
  ./ "$HOST:browse/"
"$SSH" "$HOST" 'set -e; export PATH=/usr/local/bin:$HOME/.bun/bin:$PATH; cd ~/browse && (cd cli && bun build.ts)
  node cli/dist/cli.mjs install >/dev/null
  node cli/dist/cli.mjs relay restart 2>&1 | tail -1 || true
  for i in $(seq 1 60); do node cli/dist/cli.mjs doctor >/tmp/browse-doctor.txt 2>&1 && grep -q "^Status: ok" /tmp/browse-doctor.txt && break; sleep 1; done
  grep -E "^(Status|Relay|Extension):" /tmp/browse-doctor.txt'
