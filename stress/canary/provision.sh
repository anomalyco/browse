#!/usr/bin/env bash
# Called by exe/provision.sh (including --canary-only). No canary process reads the checkout or exedev's home.
set -euo pipefail
src=$(cd "$(dirname "$0")/.." && pwd)
cft=$(readlink -f "$1")
if [[ ! -x $cft ]] || ! /usr/local/bin/node -e 'if (+process.versions.node.split(".")[0]<24) process.exit(1)'; then echo 'Provision the base box (Node 24 + CfT) first' >&2; exit 1; fi
opt=/opt/browse-canary
sudo apt-get install --no-install-recommends -y nftables xauth xvfb xdotool fluxbox
if ! id canary >/dev/null 2>&1; then sudo useradd --create-home --home-dir /home/canary --shell /usr/sbin/nologin canary; fi
[[ $(getent passwd canary | cut -d: -f6,7) == /home/canary:/usr/sbin/nologin ]] || { echo 'canary account exists with unexpected home/shell' >&2; exit 1; }
sudo chmod 700 /home/canary
if sudo systemctl is-active --quiet browse-canary; then sudo systemctl stop browse-canary; fi
sudo install -d -m 755 "$opt/stress/exe" "$opt/stress/lib" "$opt/stress/canary" "$opt/chrome-for-testing"
# Copy harness sources only; not the repo CLI, build, or any pairing files. ws is the fixture/fuzzer dependency.
sudo install -m 644 "$src"/*.ts "$opt/stress/"
sudo install -m 644 "$src/lib/"*.ts "$opt/stress/lib/"
sudo install -m 644 "$src/canary/"*.ts "$src/canary/"*.sh "$opt/stress/canary/"
sudo install -m 755 "$src/exe/chrome.sh" "$opt/stress/exe/chrome.sh"
sudo cp -a --no-preserve=ownership "$(dirname "$cft")/." "$opt/chrome-for-testing/"
sudo env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/npm install --prefix "$opt" --ignore-scripts --no-audit --no-fund ws@8.22.0

if [[ ! -x /usr/bin/brave-browser ]]; then
  install_brave() {
    curl -fsSL https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg | sudo tee /usr/share/keyrings/brave-browser-archive-keyring.gpg >/dev/null &&
      curl -fsSL https://brave-browser-apt-release.s3.brave.com/brave-browser.sources | sudo tee /etc/apt/sources.list.d/brave-browser-release.sources >/dev/null &&
      sudo apt-get update -qq &&
      sudo apt-get install -y --no-install-recommends brave-browser
  }
  install_brave || echo 'Brave stable not available: nightly will record the matrix check as skipped' >&2
fi
for unit in "$src/canary/units/"*.service; do sudo install -m 644 "$unit" /etc/systemd/system/; done
sudo install -m 644 "$src/canary/units/env" /etc/browse-canary.env
sudo visudo -c -f "$src/canary/units/sudoers"
sudo install -m 440 "$src/canary/units/sudoers" /etc/sudoers.d/browse-canary
sudo systemctl daemon-reload
sudo systemctl restart browse-canary-network.service
sudo systemctl enable --now browse-canary.service
