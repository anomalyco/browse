#!/usr/bin/env bash
# verify-artifacts.sh <dir>: checks every artifact downloaded into <dir>/<name> against its SHA256SUMS, that it holds
# exactly the listed files, and that its SHA256SUMS has the digest the job that made it reported
# (BROWSE_DIGESTS="name=digest ..."), so an artifact replaced after that job finished is rejected.
. "$(dirname "$0")/lib.sh"

found=false
for dir in "$1"/*/; do
  found=true
  name=$(basename "$dir")
  digest=""
  for pair in ${BROWSE_DIGESTS:-}; do
    if [ "${pair%%=*}" = "$name" ]; then digest=${pair#*=}; fi
  done
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "Missing digest for $name"
  (
    cd "$dir" || exit
    [ "$(sha256 SHA256SUMS | cut -c1-64)" = "$digest" ] || die "SHA256SUMS digest mismatch in $name"
    sha256 -c --quiet SHA256SUMS || die "Checksum mismatch in $name"
    diff <(find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort) <(cut -c67- SHA256SUMS | LC_ALL=C sort) ||
      die "Unexpected files in $name"
  )
  echo "verified $name ($digest)"
done
[ "$found" = true ] || die "No artifacts in $1"
