#!/usr/bin/env bash
# repack-windows.sh <work dir> <out dir>: fails unless <work dir> holds exactly the two browse.exe files, each with a
# valid Authenticode signature (Get-AuthenticodeSignature), then writes them back into their npm tarballs in <out dir>
# with the layout and modes publish-npm.sh expects and npm pack's timestamps, as sign-macos.sh repacks the macOS ones.
# Dry runs verify nothing and repack unsigned: the workflow skips the Azure steps then.
. "$(dirname "$0")/lib.sh"

work=$(posix "$1") out=$(posix "$2")
windows_path() {
  if command -v cygpath > /dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

if dry_run; then
  echo "dry-run: not verifying signatures in $work"
else
  powershell -NoProfile -Command "
    \$ErrorActionPreference = 'Stop'
    \$files = @(Get-ChildItem '$(windows_path "$work")' -Recurse -Include *.exe)
    if (\$files.Count -ne 2) { throw \"Expected the 2 Windows binaries, found \$(\$files.Count) .exe files\" }
    foreach (\$file in \$files) {
      \$sig = Get-AuthenticodeSignature \$file.FullName
      if (\$sig.Status -ne 'Valid') { throw \"Invalid signature for \$(\$file.FullName): \$(\$sig.Status)\" }
    }
    Write-Output \"verified \$(\$files.Count) signatures\"
  "
fi

mkdir -p "$out"
for target in windows-x64 windows-x64-baseline; do
  dir="$work/$target"
  bin="$dir/package/bin/browse.exe"
  file="$out/opencode-browse-$target-$BROWSE_VERSION.tgz"
  test -s "$bin" || die "Missing $bin"
  # Git Bash runs noacl: chmod only moves the read-only bit, and stat's execute bits come from the .exe extension, so
  # the modes below are what the emulation reports. The listing check is what guarantees the tarball publish-npm.sh
  # accepts; a mismatch fails this job instead of shipping it.
  chmod 755 "$bin"
  chmod 644 "$dir/package/package.json" "$dir/package/LICENSE"
  touch -t 198510260415 "$bin" "$dir/package/package.json" "$dir/package/LICENSE"
  # Files only (no directory entries), owned by root, as npm pack writes them.
  tar --owner=0 --group=0 --numeric-owner -czf "$file" -C "$dir" package/package.json package/LICENSE package/bin/browse.exe
  listing=$(tar -tvzf "$file" | awk '{print $1, $NF}' | LC_ALL=C sort)
  expected=$(printf '%s\n' "-rw-r--r-- package/LICENSE" "-rw-r--r-- package/package.json" "-rwxr-xr-x package/bin/browse.exe" | LC_ALL=C sort)
  [ "$listing" = "$expected" ] || die "$file holds $listing"
done
