#!/usr/bin/env bash
# unpack-windows.sh <binaries dir> <work dir>: unpacks the Windows platform tarballs into <work dir>/<target>
# (package/package.json, package/LICENSE, package/bin/browse.exe), where the signing action signs the .exe files;
# repack-windows.sh puts them back. Optional: the release workflow runs this only when the repository variable
# WINDOWS_SIGNING is true.
. "$(dirname "$0")/lib.sh"

in=$1 work=$2
mkdir -p "$work"
for target in windows-x64 windows-x64-baseline; do
  file="opencode-browse-$target-$BROWSE_VERSION.tgz"
  test -s "$in/$file" || die "Missing $in/$file"
  mkdir -p "$work/$target"
  tar -xzf "$in/$file" -C "$work/$target" package/package.json package/LICENSE package/bin/browse.exe
  test -s "$work/$target/package/bin/browse.exe" || die "Missing browse.exe in $file"
done
