#!/usr/bin/env bash
# sign-macos.sh <binaries dir> <out dir>: signs the macOS browse binaries inside their npm tarballs with the Developer ID
# in build.keychain (hardened runtime, entitlements/cli.plist: Bun's JIT needs allow-jit and unsigned executable
# memory), and writes the re-packed tarballs to <out dir>. Dry runs sign ad-hoc. Optional: the release workflow runs it
# only when the repository variable MACOS_SIGNING is true; without it the packages ship with the ad-hoc signature
# `bun build --compile` gives them.
. "$(dirname "$0")/lib.sh"

in=$1 out=$2
entitlements="$(cd "$(dirname "$0")" && pwd)/entitlements/cli.plist"
mkdir -p "$out"
identity=- timestamp=--timestamp=none
if ! dry_run; then
  identity=$(security find-identity -v -p codesigning build.keychain | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -n 1)
  [ -n "$identity" ] || die "Developer ID Application identity not found"
  timestamp=--timestamp
fi

export COPYFILE_DISABLE=1
for target in darwin-arm64 darwin-x64 darwin-x64-baseline; do
  file="opencode-browse-$target-$BROWSE_VERSION.tgz"
  test -s "$in/$file" || die "Missing $in/$file"
  work=$(mktemp -d)
  tar -xzf "$in/$file" -C "$work" package/package.json package/LICENSE package/bin/browse
  bin="$work/package/bin/browse"
  file -b "$bin" | grep -q '^Mach-O' || die "$target is not a Mach-O binary"
  codesign --force "$timestamp" --options runtime --entitlements "$entitlements" --sign "$identity" "$bin"
  codesign --verify --strict --verbose=2 "$bin"
  chmod 755 "$bin"
  chmod 644 "$work/package/package.json" "$work/package/LICENSE"
  touch -t 198510260415 "$bin" "$work/package/package.json" "$work/package/LICENSE"
  # Files only (no directory entries), owned by root, as npm pack writes them; publish-npm.sh checks the listing.
  tar --no-mac-metadata --uid 0 --gid 0 -czf "$out/$file" -C "$work" package/package.json package/LICENSE package/bin/browse
  rm -rf "$work"
done
