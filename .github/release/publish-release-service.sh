#!/usr/bin/env bash
# publish-release-service.sh <build dir>: publishes a dev build to Anomaly's release service, https://anoma.ly/release
# (github.com/anomalyco/release, docs/publishing.md), through its shared client the way Hex and OpenCode do: a one-hour
# publish session from the job's GitHub OIDC token (no secrets), content-addressed uploads, retries, and a check of
# every published file. The service admits this workflow on refs/heads/dev in environment release
# (scripts/release-registry.json, registered there as registry/browse.json).
#
#   extension  chromium  browse-extension-<version>.zip, the unpacked extension dev installs load
#   cli        npm       opencode-browse-<version>.tgz, the npm package (also on npm, dist-tag dev)
#
# A dev CLI fetches its own zip by sha256 from $release/browse/files/<sha256>/<file> (cli/src/dev-extension.ts), so the
# extension goes first. Publishing the version the channel already has succeeds only when the service has exactly
# these files, so a rerun is safe.
. "$(dirname "$0")/lib.sh"

release=https://anoma.ly/release
dir=$1
[ "$BROWSE_CHANNEL" = dev ] || die "Only dev builds go to the release service, not $BROWSE_CHANNEL"
for file in "browse-extension-$BROWSE_VERSION.zip" "opencode-browse-$BROWSE_VERSION.tgz"; do
  test -s "$dir/$file" || die "Missing $dir/$file"
  verify_attestation "$dir/$file"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jq -n --arg channel "$BROWSE_CHANNEL" --arg version "$BROWSE_VERSION" --arg notes_url "$NOTES_URL" \
  '{channel: $channel, version: $version, notes_url: $notes_url, distributions: [{kind: "direct"}]}' > "$work/release.json"
if dry_run; then
  summary "### Release service (dry run)" "Would publish $BROWSE_VERSION to $release/browse (extension, cli)."
  exit 0
fi
curl -fsSL --retry 5 --retry-all-errors "$release/client.sh" -o "$work/client.sh"

publish() {
  RELEASE=$release bash "$work/client.sh" publish --app browse --artifact "$1" --release "$work/release.json" \
    --target "$2=$dir/$3" --out "$work/manifest-$1.json" --verify-downloads
}
publish extension chromium "browse-extension-$BROWSE_VERSION.zip"
publish cli npm "opencode-browse-$BROWSE_VERSION.tgz"

summary "### Release service (dev)" "" "- Extension: $release/browse/extension/dev/chromium" "- npm tarball: $release/browse/cli/dev/npm"
for manifest in "$work"/manifest-*.json; do
  summary "" "#### $(basename "$manifest")" '```json' "$(cat "$manifest")" '```'
done
