#!/bin/sh
# Builds the browse binary for every platform the install script picks from, into rust/dist/<target>/browse[.exe]
# (the layout `bun scripts/npm-package.ts platforms --binaries rust/dist` packs), and prints each file's size and SHA-256.
#   BROWSE_VERSION=0.1.0 script/release.sh [target...]     e.g. linux-x64 darwin-arm64; no target: all
# Linux targets build with cargo-zigbuild (the gnu ones against glibc 2.17, as the release does), macOS ones too unless
# this is a Mac, and Windows with cargo-xwin unless this is Windows. Install them with
# `cargo install cargo-zigbuild cargo-xwin` and add the rustup targets. The release workflow builds the same way.
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
    build_target=$target
    case "$target" in
        *-linux-gnu) build="cargo zigbuild" build_target="$target.2.17" ;;
        *-linux-musl) build="cargo zigbuild" ;;
        *-pc-windows-msvc)
            if [ "$target" = "$host" ]; then build="cargo build"; else build="cargo xwin build"; fi
            export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-C target-feature=+crt-static" ;;
        *) if [ "$target" = "$host" ] || [ "$(uname -s)" = Darwin ]; then build="cargo build"; else build="cargo zigbuild"; fi ;;
    esac
    $build --release --locked -p browse --target "$build_target"
    exe=browse; [ "$name" = windows-x64 ] && exe=browse.exe
    mkdir -p "dist/$name"
    cp "target/$target/release/$exe" "dist/$name/$exe"
    file="dist/$name/$exe"
    size=$(wc -c <"$file" | tr -d ' ')
    sum=$( (sha256sum "$file" 2>/dev/null || shasum -a 256 "$file") | cut -d' ' -f1)
    echo "$name $size $sum"
done
