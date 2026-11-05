#!/usr/bin/env bash
set -euo pipefail
case $1 in
  chrome) export BROWSE_STRESS_CHROME=/opt/browse-canary/chrome-for-testing/chrome BROWSE_CANARY_SHORTCUT=1 ;;
  brave) export BROWSE_STRESS_CHROME=/usr/bin/brave-browser BROWSE_STRESS_CHROME_PORT=19773 ;;
  *) exit 2 ;;
esac
export BROWSE_STRESS_PROFILE="$HOME/$1-profile" BROWSE_STRESS_EXTENSION="$OPENCODE_BROWSER_HOME/extension"
for _ in {1..50}; do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
exec /opt/browse-canary/stress/exe/chrome.sh
