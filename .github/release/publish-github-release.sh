#!/usr/bin/env bash
# publish-github-release.sh <build dir> <attestation dir>: creates the v<version> GitHub release with the extension zip,
# the npm tarball, their SHA256SUMS and the provenance bundle, and BROWSE_RELEASE_NOTES (a summary line, then the
# changelog sections). The tag must exist (tag-release.sh). Immutable releases lock assets once published, so they go
# to a draft first.
. "$(dirname "$0")/lib.sh"

tag="v$BROWSE_VERSION"
assets=$(mktemp -d)
zip="browse-extension-$BROWSE_VERSION.zip" tarball="opencode-browse-$BROWSE_VERSION.tgz"
for file in "$1/$zip" "$1/$tarball"; do
  test -s "$file" || die "Missing $file"
  verify_attestation "$file"
  cp "$file" "$assets/"
done
cp "$2/attestation.sigstore.json" "$assets/"
(cd "$assets" && sha256 -- "$zip" "$tarball" > SHA256SUMS && cat SHA256SUMS)

{
  notes_summary
  echo
  notes_body | grep -vE '^(Icon|Media):' || true
  echo
  echo "## Install"
  echo
  echo '`npx @opencode/browse install`'
  echo
  echo "## Verify"
  echo
  echo '```sh'
  echo "sha256sum -c SHA256SUMS"
  echo "gh attestation verify $zip --repo $GITHUB_REPOSITORY"
  echo "gh attestation verify $tarball --repo $GITHUB_REPOSITORY"
  echo '```'
} > "$assets.md"
cat "$assets.md"
if dry_run; then exit 0; fi

gh release view "$tag" > /dev/null 2>&1 ||
  gh release create "$tag" --draft --verify-tag --title "$tag" --notes-file "$assets.md"
gh release upload "$tag" "$assets"/* --clobber
gh release edit "$tag" --draft=false --latest
summary "GitHub release: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/releases/tag/$tag"
