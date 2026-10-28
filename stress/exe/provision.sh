#!/usr/bin/env bash
# Provisions an Ubuntu 24.04 box (exe.dev browse-stress) for stress-testing browse. Idempotent: re-run it any time.
#   bash stress/exe/provision.sh            # from a clone, or
#   curl -fsSL .../provision.sh | bash      # before the clone exists
# Installs Node 24, Bun (the packageManager version), Xvfb + fluxbox, fonts, ffmpeg, x11vnc + noVNC and Chrome for
# Testing; clones browse into ~/browse (unless BROWSE_SKIP_CLONE=1, e.g. after an rsync), runs `bun run setup`, and
# installs the systemd units that keep Xvfb :99, Chrome (headed, with the extension) and noVNC running.
set -euo pipefail

USER_NAME="$(id -un)"
HOME_DIR="$HOME"
REPO="${BROWSE_REPO:-$HOME_DIR/browse}"
NODE_MAJOR=24
CFT_DIR="$HOME_DIR/chrome-for-testing"
NOVNC_PORT="${BROWSE_NOVNC_PORT:-8000}"
log() { printf '\n== %s\n' "$*"; }
# exe.dev's SSH PATH lists /usr/local/bin last, so nothing may install another node in /usr/bin (Ubuntu's novnc
# package pulls in nodejs 18; noVNC comes from its release tarball instead). Node 24 lives in /usr/local.
export PATH="/usr/local/bin:$HOME/.bun/bin:$PATH"

log "apt packages"
export DEBIAN_FRONTEND=noninteractive
PKGS=(xvfb fluxbox x11vnc websockify xdotool x11-utils tmux curl unzip jq rsync ffmpeg iptables iproute2
  fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fonts-dejavu-core sqlite3 procps lsof)
missing=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if ((${#missing[@]})); then
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends "${missing[@]}"
fi

if dpkg -s nodejs >/dev/null 2>&1; then sudo apt-get remove -y -qq novnc nodejs >/dev/null; sudo apt-get autoremove -y -qq >/dev/null; fi
NOVNC_VERSION=1.6.0
if [[ ! -f /opt/novnc/.version-$NOVNC_VERSION ]]; then
  sudo rm -rf /opt/novnc && sudo mkdir -p /opt/novnc
  curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v$NOVNC_VERSION.tar.gz" | sudo tar -xz -C /opt/novnc --strip-components=1
  sudo touch "/opt/novnc/.version-$NOVNC_VERSION"
fi

log "Node $NODE_MAJOR"
if [[ ! -x /usr/local/bin/node || "$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]]; then
  version="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r "[.[] | select(.version | startswith(\"v$NODE_MAJOR.\"))][0].version")"
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" | sudo tar -xJ -C /usr/local --strip-components=1
fi
node --version

log "Bun"
if [[ -f "$REPO/package.json" ]]; then
  BUN_VERSION="$(jq -r '.packageManager' "$REPO/package.json" | sed 's/^bun@//')"
else
  BUN_VERSION="$(curl -fsSL https://raw.githubusercontent.com/anomalyco/browse/main/package.json | jq -r '.packageManager' | sed 's/^bun@//')"
fi
if ! command -v bun >/dev/null || [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
  sudo ln -sf "$HOME_DIR/.bun/bin/bun" /usr/local/bin/bun
fi
bun --version

log "browse checkout"
if [[ ! -d "$REPO/.git" && "${BROWSE_SKIP_CLONE:-0}" != 1 ]]; then
  git clone https://github.com/anomalyco/browse.git "$REPO"
fi
cd "$REPO"
# `setup` builds the extension and CLI, writes the pairing file into dist/, and adds the MCP server to the box's own
# opencode config. Over SSH it doesn't wait for a browser.
OPENCODE_BROWSER_UPDATE_CHECK=0 bun run setup </dev/null

log "Chrome for Testing (stable)"
mkdir -p "$CFT_DIR"
installed="$(cd "$CFT_DIR" && npx -y @puppeteer/browsers@2 install chrome@stable --path "$CFT_DIR" --format '{{path}}' 2>/dev/null | tail -1)"
[[ -x "$installed" ]] || { echo "Chrome for Testing install failed: $installed" >&2; exit 1; }
ln -sfn "$installed" "$CFT_DIR/current"
"$CFT_DIR/current" --version
log "Chrome system libraries"
sudo env "PATH=$PATH" node "$REPO/cli/node_modules/patchright-core/cli.js" install-deps chromium >/dev/null

log "systemd units"
UNITS_SRC="$REPO/stress/exe/units"
for unit in "$UNITS_SRC"/*.service; do
  name="$(basename "$unit")"
  sed -e "s#@USER@#$USER_NAME#g" -e "s#@HOME@#$HOME_DIR#g" -e "s#@REPO@#$REPO#g" -e "s#@NOVNC_PORT@#$NOVNC_PORT#g" \
    "$unit" | sudo tee "/etc/systemd/system/$name" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now browse-xvfb browse-wm browse-chrome browse-vnc browse-novnc >/dev/null
sudo systemctl restart browse-chrome browse-novnc

log "relay + extension"
# Any relay-backed command starts the relay; the extension connects once it's up.
OPENCODE_BROWSER_UPDATE_CHECK=0 node cli/dist/cli.mjs session list --json >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  if node cli/dist/cli.mjs status --json 2>/dev/null | jq -e '.extension.connected == true' >/dev/null 2>&1; then break; fi
  sleep 1
done
node cli/dist/cli.mjs status || true
node cli/dist/cli.mjs doctor || true
sleep 1; curl -fsS -o /dev/null -w "noVNC on :$NOVNC_PORT -> HTTP %{http_code}\n" "http://127.0.0.1:$NOVNC_PORT/vnc.html" || true
