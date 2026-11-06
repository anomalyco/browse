#!/usr/bin/env bash
set -euo pipefail
if [[ ! -x $BROWSE_STRESS_BINARY || ! -f ${XDG_CACHE_HOME:-$HOME/.cache}/browse/extension.json ]]; then
  # The published installer uses Bash arrays; Ubuntu /bin/sh is dash. Do not print the pairing code to journald.
  mkdir -p "$HOME/canary"
  curl -fsSL https://opencode.ai/browse/install | bash -s -- --channel dev --agent none --no-open --no-wait >"$HOME/canary/install.log" 2>&1
fi
"$BROWSE_STRESS_BINARY" session list --json >/dev/null
