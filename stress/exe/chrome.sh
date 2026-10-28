#!/usr/bin/env bash
# Starts Chrome for Testing headed on $DISPLAY with the browse extension (run by browse-chrome.service).
# Flags:
#   --load-extension                      Chrome for Testing still honours it (branded Chrome 137+ doesn't).
#   --no-first-run, --no-default-browser-check, --password-store=basic
#                                         no first-run UI or keyring prompt on a headless box.
#   --disable-dev-shm-usage               harmless here, avoids /dev/shm exhaustion under heavy load.
#   --remote-debugging-port=9222 (127.0.0.1)
#                                         HARNESS ONLY: the stress runners use it to click like a person (handoffs),
#                                         stop the extension's service worker and count debugger attachments. browse
#                                         itself never uses it. It is loopback-only; exe.dev only proxies 3000-9999 on
#                                         the VM's network address, never 127.0.0.1.
# The sandbox stays on (unprivileged user namespaces work on this kernel) and GPU flags are left at defaults (Chrome
# falls back to SwiftShader on Xvfb).
set -euo pipefail
PROFILE="${BROWSE_STRESS_PROFILE:-$HOME/stress-profile}"
EXT="${BROWSE_STRESS_EXTENSION:-$HOME/browse/dist}"
CHROME="${BROWSE_STRESS_CHROME:-$HOME/chrome-for-testing/current}"
mkdir -p "$PROFILE"
# A killed Chrome leaves a "restore pages?" bubble and a stale singleton lock; neither should block the restart.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
# Developer mode stays on: browse's `update`/`install` reload the extension (chrome.runtime.reload), which re-adds a
# --load-extension extension as an ordinary unpacked one, and Chrome disables unpacked extensions while developer mode
# is off (disable reason 1<<24). Real installs are loaded with developer mode on, so this matches them.
mkdir -p "$PROFILE/Default"
python3 - "$PROFILE/Default/Preferences" <<'PY'
import json, os, sys
path = sys.argv[1]
try:
    prefs = json.load(open(path))
except Exception:
    prefs = {}
prefs.setdefault("extensions", {}).setdefault("ui", {})["developer_mode"] = True
ext = prefs["extensions"].get("settings", {}).get("afeafocngkodbmaipcngoamamfmekgfo")
if ext:
    ext.pop("disable_reasons", None)
    ext["state"] = 1
profile = prefs.setdefault("profile", {})
profile["exit_type"] = "Normal"
profile["exited_cleanly"] = True
json.dump(prefs, open(path + ".tmp", "w"))
os.replace(path + ".tmp", path)
PY
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --load-extension="$EXT" \
  --no-first-run --no-default-browser-check --password-store=basic \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --window-size=1880,1040 --window-position=0,0 \
  about:blank
