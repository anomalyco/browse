#!/usr/bin/env bash
# publish-release-service.sh <build dir> <binaries dir> [<signed dir>]: publishes this run to Anomaly's release service,
# https://anoma.ly/release (github.com/anomalyco/release, docs/publishing.md), through its shared client: a one-hour
# publish session from the job's GitHub OIDC token (no secrets), content-addressed uploads, retries, and a check of
# every published file. The service admits this workflow on refs/heads/dev in environment release
# (scripts/release-registry.json, registered there as registry/browse.json).
#
# Every channel publishes both artifacts:
#
#   extension  chromium   the unpacked extension zip: browse-extension-<version>.zip on dev, the store zip
#                         opencode-browser-<version>.zip on stable
#   cli        one target per binary (the same eleven targets as @opencode/browse-<target>), npm's darwin is the
#              service's macos: opencode-browse-<target>-<version>.tgz
#
# A signed macOS tarball (sign-macos.sh) replaces the unsigned one of the same name. Publishing the version the channel
# already has succeeds only when the service has exactly these files, so a rerun is safe. A dry run prints the
# artifact/channel/target/file list and publishes nothing.
. "$(dirname "$0")/lib.sh"

release=${BROWSE_RELEASE_SERVICE:-https://anoma.ly/release}
release=${release%/}
build_dir=$1
binaries_dir=$2
signed_dir=${3:-}
: "${NOTES_URL:?Set NOTES_URL}"
case "$BROWSE_CHANNEL" in
  dev) channel=dev extension="browse-extension-$BROWSE_VERSION.zip" ;;
  latest) channel=stable extension="opencode-browser-$BROWSE_VERSION.zip" ;;
  *) die "Unknown channel $BROWSE_CHANNEL" ;;
esac
[[ "$BROWSE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "Not a release version: $BROWSE_VERSION"
if [ "$channel" = stable ]; then stable_version "$BROWSE_VERSION" || die "Not a stable version: $BROWSE_VERSION"; fi

# The install script's targets (install); keep in step with cli/script/compile.ts and publish-npm.sh.
targets="linux-x64 linux-x64-baseline linux-arm64 linux-x64-musl linux-x64-baseline-musl linux-arm64-musl darwin-arm64 darwin-x64 darwin-x64-baseline windows-x64 windows-x64-baseline"

service_target() {
  case "$1" in
    darwin-*) printf '%s' "macos-${1#darwin-}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# target_file <npm target>: the tarball this run would publish, preferring the signed one.
target_file() {
  local name="opencode-browse-$1-$BROWSE_VERSION.tgz"
  if [ -n "$signed_dir" ] && [ -f "$signed_dir/$name" ]; then
    printf '%s' "$signed_dir/$name"
  else
    printf '%s' "$binaries_dir/$name"
  fi
}

files=""
for target in $targets; do
  file=$(target_file "$target")
  test -s "$file" || die "Missing $file"
  files="$files $file"
done
test -s "$build_dir/$extension" || die "Missing $build_dir/$extension"
files="$build_dir/$extension$files"

if dry_run; then
  summary "### Release service (dry run)" "" "Would publish $BROWSE_VERSION to $release/browse ($channel):"
  summary "- extension $channel chromium $(basename "$build_dir/$extension")"
  for target in $targets; do
    summary "- cli $channel $(service_target "$target") $(basename "$(target_file "$target")")"
  done
  exit 0
fi
for file in $files; do verify_attestation "$file"; done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 5 --retry-all-errors "$release/client.sh" -o "$work/client.sh"
client() { RELEASE=$release bash "$work/client.sh" "$@"; }

jq -n --arg channel "$channel" --arg version "$BROWSE_VERSION" --arg notes_url "$NOTES_URL" \
  '{channel: $channel, version: $version, notes_url: $notes_url, distributions: [{kind: "direct"}]}' > "$work/release.json"

publish() { # <artifact> <target=file>...
  artifact=$1
  shift
  set -- "$@" --app browse --artifact "$artifact" --release "$work/release.json" \
    --out "$work/manifest-$artifact.json" --verify-downloads
  client publish "$@"
}
publish extension --target "chromium=$build_dir/$extension"
set --
for target in $targets; do
  set -- "$@" --target "$(service_target "$target")=$(target_file "$target")"
done
publish cli "$@"

summary "### Release service ($channel)" "" \
  "- Extension: $release/browse/extension/$channel/chromium" \
  "- CLI: $release/browse/cli/$channel/<target>"
for manifest in "$work"/manifest-*.json; do
  summary "" "#### $(basename "$manifest")" '```json' "$(cat "$manifest")" '```'
done
