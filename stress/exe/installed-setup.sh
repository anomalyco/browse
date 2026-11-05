#!/usr/bin/env bash
# Installs browse the way users do, each into a throwaway $HOME under ~/u, for stress/installed.ts:
#   installed-setup.sh curl [version]   # curl -fsSL https://opencode.ai/browse/install | bash  (optionally --version X)
#   installed-setup.sh npm              # npx @opencode/browse@latest install
#   installed-setup.sh extensions       # the release zips with the store's manifest key (so their id is the store id)
# Each install runs non-interactively (as an agent would run it) with --no-wait: pairing is the harness's job.
# The relay it starts listens on OPENCODE_BROWSER_PORT (default 19988): stop the other user's relay first, or set a port.
set -euo pipefail
export PATH=/usr/local/bin:$PATH
kind="${1:?curl|npm|extensions}"
root="$HOME/u"
mkdir -p "$root"

case "$kind" in
  curl)
    home="$root/home-curl${3:+-$3}"
    mkdir -p "$home"
    version="${2:-}"
    export HOME="$home"
    cd "$home"
    if [ -n "$version" ]; then
      curl -fsSL https://opencode.ai/browse/install | bash -s -- --version "$version" --no-wait
    else
      curl -fsSL https://opencode.ai/browse/install | bash -s -- --no-wait
    fi
    "$home/.browse/bin/browse" --version
    ;;
  npm)
    home="$root/home-npm"
    mkdir -p "$home"
    export HOME="$home"
    cd "$home"
    npx -y @opencode/browse@latest install --no-wait
    ls "$home/.local/share/opencode-browser"
    ;;
  extensions)
    # From a Mac: fetch the release zips, add the store key (from the store's CRX header) and rsync ~/u/ext-* here.
    # See stress/README.md ("Installed artifacts").
    ls -d "$root"/ext-*
    ;;
  *)
    echo "unknown kind $kind" >&2
    exit 1
    ;;
esac
