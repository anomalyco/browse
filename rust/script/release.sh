#!/bin/sh
# Builds the browse binary for every platform the install script picks from (cli/script/compile.ts), into
# rust/dist/browse-<target>/browse[.exe], and prints each file's size and SHA-256 for the release manifest.
#   BROWSE_VERSION=0.1.0 script/release.sh [target...]     e.g. linux-x64 darwin-arm64; no target: all
# Linux and macOS targets cross-compile with cargo-zigbuild, Windows with cargo-xwin; on a matching host plain cargo
# is used. Install them with `cargo install cargo-zigbuild cargo-xwin` and add the rustup targets.
set -eu
cd "$(dirname "$0")/.."

all="linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl darwin-arm64 darwin-x64 windows-x64"
[ $# -gt 0 ] && all="$*"

triple() {
    case "$1" in
        linux-x64) echo x86_64-unknown-linux-gnu ;;
        linux-arm64) echo aarch64-unknown-linux-gnu ;;
        linux-x64-musl) echo x86_64-unknown-linux-musl ;;
        linux-arm64-musl) echo aarch64-unknown-linux-musl ;;
        darwin-arm64) echo aarch64-apple-darwin ;;
        darwin-x64) echo x86_64-apple-darwin ;;
        windows-x64) echo x86_64-pc-windows-msvc ;;
        *) echo "unknown target $1" >&2; exit 1 ;;
    esac
}

host=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p dist
for name in $all; do
    target=$(triple "$name")
    if [ "$target" = "$host" ]; then build="cargo build"
    elif [ "$name" = windows-x64 ]; then build="cargo xwin build"
    else build="cargo zigbuild"; fi
    $build --release --locked -p browse --target "$target"
    exe=browse; [ "$name" = windows-x64 ] && exe=browse.exe
    mkdir -p "dist/browse-$name"
    cp "target/$target/release/$exe" "dist/browse-$name/$exe"
    file="dist/browse-$name/$exe"
    size=$(wc -c <"$file" | tr -d ' ')
    sum=$( (sha256sum "$file" 2>/dev/null || shasum -a 256 "$file") | cut -d' ' -f1)
    echo "$name $size $sum"
done
