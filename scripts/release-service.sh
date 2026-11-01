#!/bin/sh
# Publishes a dev build to Anomaly's release service, https://anoma.ly/release (github.com/anomalyco/release,
# docs/publishing.md), through its shared client the way Hex and Deadbolt do: a one-hour publish session from the job's
# GitHub OIDC token (no secrets), parallel content-addressed uploads, retries, and a check of every published file.
# Runs only in the Release workflow's publish-release job (environment release-dev, `id-token: write`).
#
#   release-service.sh publish <dist>
#
# Artifacts of the app `browse` (registered in anomalyco/release as registry/browse.json; scripts/release-registry.json
# here is the entry), each with a manifest at $RELEASE/browse/<artifact>/<channel>.json:
#
#   extension  chromium  browse-extension-<version>.zip, the unpacked extension dev installs load
#   cli        npm       opencode-browse-<version>.tgz, the npm package (also on npm, dist-tag dev)
#
# Stable links: $RELEASE/browse/<artifact>/dev/<target> (302 to the current file) and …/<target>/info. A dev CLI fetches
# its own zip by sha256 from $RELEASE/browse/files/<sha256>/<file> (cli/src/dev-extension.ts).
# BROWSE_VERSION is the version the files were built as; BROWSE_RELEASE_CHANNEL the channel (dev); NOTES_URL the commit.
# Writes <dist>/manifest-<artifact>.json. Publishing the version the channel already has succeeds only when the service
# has exactly these files, so a rerun is safe.
set -eu

: "${RELEASE:?Set RELEASE to the release service origin}"
: "${BROWSE_VERSION:?Set BROWSE_VERSION}"
: "${NOTES_URL:?Set NOTES_URL}"
channel=${BROWSE_RELEASE_CHANNEL:-dev}
case "$RELEASE" in
  https://anoma.ly/release) ;;
  *) echo "RELEASE must be https://anoma.ly/release." >&2; exit 1 ;;
esac
[ "${1:-}" = publish ] && [ $# -eq 2 ] || { echo "Usage: $0 publish <dist>" >&2; exit 1; }
dist=$2

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl -fsSL --retry 5 --retry-all-errors "$RELEASE/client.sh" -o "$temporary/client.sh"

publish() {
  artifact=$1
  target=$2
  file=$3
  [ -f "$dist/$file" ] || { echo "Missing $dist/$file." >&2; exit 1; }
  jq -n --arg channel "$channel" --arg version "$BROWSE_VERSION" --arg notes_url "$NOTES_URL" \
    '{channel: $channel, version: $version, notes_url: $notes_url, distributions: [{kind: "direct"}]}' > "$temporary/release.json"
  RELEASE=$RELEASE bash "$temporary/client.sh" publish --app browse --artifact "$artifact" --release "$temporary/release.json" \
    --target "$target=$dist/$file" --out "$dist/manifest-$artifact.json" --verify-downloads
}

# The extension first: a dev CLI on npm fetches it, so it must be there before the package is.
publish extension chromium "browse-extension-$BROWSE_VERSION.zip"
publish cli npm "opencode-browse-$BROWSE_VERSION.tgz"
