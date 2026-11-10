#!/usr/bin/env bash
# publish-cws.sh <build dir>: uploads browse-extension-<BROWSE_VERSION>.zip to the Chrome Web Store item and submits it
# for review, with the Chrome Web Store API v2 and curl.
#
# Environment: CWS_CLIENT_ID, CWS_PUBLISHER_ID and CWS_ITEM_ID (repository variables), CWS_CLIENT_SECRET and
# CWS_REFRESH_TOKEN (read from AWS Secrets Manager by the release workflow), GH_TOKEN and GITHUB_REPOSITORY (to read the
# previous release's zip).
# Idempotent: when the item already has this version (published or in review), nothing is uploaded again; it reports
# the state. It also uploads nothing when the zip is the extension the store already has, unchanged apart from the
# manifest version (and version_name): the store keeps that version and the release goes on without another review.
# Publishing uses the item's visibility in the dashboard and submits for review; it doesn't wait for review.
# An item holds one submission at a time, so an older version still pending review is cancelled first and this build is
# the one that gets reviewed.
# A dry run checks the zip, and with credentials also reads the item's status, but uploads and cancels nothing.
# CWS_API_BASE and CWS_TOKEN_URL point it at a local fake for testing; they only accept loopback http URLs, so a changed
# variable can't send the credentials anywhere else.
. "$(dirname "$0")/lib.sh"

endpoint() {
  local value=$1 fallback=$2
  if [ -z "$value" ]; then
    printf '%s' "$fallback"
    return
  fi
  [[ "$value" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$ ]] ||
    die "CWS_API_BASE and CWS_TOKEN_URL may only point at a loopback http server (a local fake); got $value"
  printf '%s' "${value%/}"
}
# True when stable version $1 is older than stable version $2. Short versions ("1.0") are padded so the loop always
# has three parts.
older_version() {
  local IFS=. i
  local -a a b
  read -r -a a <<< "$1.0.0"
  read -r -a b <<< "$2.0.0"
  for i in 0 1 2; do
    if [ "${a[i]}" -ne "${b[i]}" ]; then
      [ "${a[i]}" -lt "${b[i]}" ]
      return
    fi
  done
  return 1
}
# Prints the version of the newest stable release other than this one (no "v"), fails with 1 when there is none and
# 2 when the releases can't be read. release.yml creates a GitHub release only after this job succeeded, and every
# release carries browse-extension-<version>.zip (opencode-browser-<version>.zip before the zip was renamed, which
# download_extension still reads), so that asset is the extension the store last received. A rerun of
# this version skips its own release and compares with the one before.
previous_release() {
  local tags tag
  tags=$(gh release list --repo "$GITHUB_REPOSITORY" --exclude-drafts --limit 30 --json tagName --jq '.[].tagName') || return 2
  while IFS= read -r tag; do
    [ "$tag" = "v$BROWSE_VERSION" ] && continue
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    printf '%s' "${tag#v}"
    return 0
  done <<< "$tags"
  return 1
}
# same_extension <dir> <other dir>: true when both unpacked zips hold the same files byte for byte, once the
# manifest's version fields (the only ones a release changes) are dropped. Archive metadata, order and timestamps
# don't matter to the store; file contents do.
same_extension() {
  local dir file
  for dir in "$1" "$2"; do
    file="$dir/manifest.json"
    jq 'del(.version, .version_name)' "$file" > "$file.normalized" && mv "$file.normalized" "$file"
  done
  diff <(cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    <(cd "$2" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > /dev/null
}
# download_extension <version> <dir>: downloads that release's extension zip into <dir> and prints its file name. The
# current name is browse-extension-<version>.zip; releases up to the rename carry opencode-browser-<version>.zip, and a
# skip check against one of those still compares with the extension the store has.
download_extension() {
  local version=$1 dir=$2 name
  for name in "browse-extension-$version.zip" "opencode-browser-$version.zip"; do
    if gh release download "v$version" --repo "$GITHUB_REPOSITORY" --pattern "$name" --dir "$dir" --clobber 2> "$work/download.err"; then
      printf '%s' "$name"
      return 0
    fi
  done
  return 1
}
# compare_with <version>: downloads that release's extension zip and compares it with this build. True when the
# extension is the same; when the asset can't be read, note says why and it's false, so the upload happens as before.
compare_with() {
  local version=$1 dir="$work/release-$1" file
  note=""
  mkdir -p "$dir/zip" "$dir/unpacked" "$work/current"
  if ! file=$(download_extension "$version" "$dir/zip"); then
    note="Couldn't download browse-extension-$version.zip or opencode-browser-$version.zip from v$version ($(head -n 1 "$work/download.err")), so there's nothing to compare with."
    return 1
  fi
  if [ ! -f "$work/current/manifest.json" ]; then unzip -q "$zip" -d "$work/current"; fi
  unzip -q "$dir/zip/$file" -d "$dir/unpacked"
  same_extension "$work/current" "$dir/unpacked"
}
api=$(endpoint "${CWS_API_BASE:-}" https://chromewebstore.googleapis.com)
token_url=$(endpoint "${CWS_TOKEN_URL:-}" https://oauth2.googleapis.com/token)
poll=${CWS_POLL_SECONDS:-5}

stable_version "$BROWSE_VERSION" || die "Not a stable version: $BROWSE_VERSION"
zip="$1/browse-extension-$BROWSE_VERSION.zip"
test -s "$zip" || die "Missing $zip"
verify_attestation "$zip"
# Never upload a zip whose manifest isn't the version being released.
packaged=$(unzip -p "$zip" manifest.json | jq -r .version)
[ "$packaged" = "$BROWSE_VERSION" ] || die "$zip has manifest version $packaged, not $BROWSE_VERSION"
if unzip -p "$zip" manifest.json | jq -e 'has("key")' > /dev/null; then die "$zip has a manifest key; the store rejects it"; fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Compare with the previous release's zip. Nothing else in the zip may change for a skip: a build with only the
# version bumped is the extension the store reviewed last time. When there is nothing to compare with (no earlier
# release, or its asset can't be read), note says why and the upload happens as before.
previous="" same_version="" unchanged=false note=""
if previous=$(previous_release 2> "$work/release-list.err"); then
  if compare_with "$previous"; then
    same_version=$previous
    unchanged=true
  fi
else
  case $? in
    2) note="Couldn't read the earlier releases ($(head -n 1 "$work/release-list.err")), so there's nothing to compare with." ;;
    *) note="This is the first release, so there's nothing to compare with." ;;
  esac
fi

if dry_run && [ -z "${CWS_REFRESH_TOKEN:-}" ]; then
  if [ "$unchanged" = true ]; then
    summary "### Chrome Web Store (dry run)" "Would skip the upload: the extension is identical to v$same_version apart from the manifest version, so the store would keep that version; nothing submitted."
  else
    summary "### Chrome Web Store (dry run)" "Would upload $(basename "$zip") ($BROWSE_VERSION) to item ${CWS_ITEM_ID:-<CWS_ITEM_ID>} and submit it for review."
    [ -z "$note" ] || summary "$note"
  fi
  exit 0
fi
for name in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID CWS_ITEM_ID; do
  [ -n "${!name:-}" ] || die "$name is not set (RELEASING.md, one-time setup)"
done
item="publishers/$(jq -rn --arg v "$CWS_PUBLISHER_ID" '$v | @uri')/items/$(jq -rn --arg v "$CWS_ITEM_ID" '$v | @uri')"

# Credentials go to curl through files, never on its command line. -j: no trailing newline, or Google reads the last
# field as "refresh_token\n" and answers unsupported_grant_type.
jq -jn --arg id "$CWS_CLIENT_ID" --arg secret "$CWS_CLIENT_SECRET" --arg refresh "$CWS_REFRESH_TOKEN" \
  '"client_id=\($id | @uri)&client_secret=\($secret | @uri)&refresh_token=\($refresh | @uri)&grant_type=refresh_token"' > "$work/form"
status=$(curl -sS -o "$work/token.json" -w '%{http_code}' -X POST "$token_url" \
  -H "Content-Type: application/x-www-form-urlencoded" --data-binary "@$work/form")
token=$(jq -r '.access_token // empty' "$work/token.json" 2> /dev/null || true)
if [ "$status" -ge 300 ] || [ -z "$token" ]; then
  die "Couldn't get an access token ($status $(jq -r '[.error, .error_description] | map(select(.)) | join(": ")' "$work/token.json" 2> /dev/null || true)). Check the CWS_* secrets; RELEASING.md says how to make a new refresh token."
fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$token"; fi
printf 'Authorization: Bearer %s\n' "$token" > "$work/auth"

# call <method> <url> [curl args...]: prints the JSON response, dies on an error status.
call() {
  local method=$1 url=$2 code
  shift 2
  code=$(curl -sS -o "$work/response" -w '%{http_code}' -X "$method" "$url" -H "@$work/auth" "$@")
  if [ "$code" -ge 300 ]; then
    die "$method ${url#"$api"} failed: $code $(jq -r '.error | "\(.status // "") \(.message // "")"' "$work/response" 2> /dev/null || head -c 500 "$work/response")"
  fi
  cat "$work/response"
}
fetch_status() { call GET "$api/v2/$item:fetchStatus"; }

before=$(fetch_status)
if [ "$(jq -r '.takenDown // false' <<< "$before")" = true ]; then
  die "Item $item is taken down for a policy violation; resolve it in the developer dashboard first."
fi
published=$(jq -r --arg v "$BROWSE_VERSION" '.publishedItemRevisionStatus | select(.) | select(any(.distributionChannels[]?; .crxVersion == $v)) | .state // "PUBLISHED"' <<< "$before")
submitted=$(jq -r --arg v "$BROWSE_VERSION" '.submittedItemRevisionStatus | select(.) | select(any(.distributionChannels[]?; .crxVersion == $v)) | .state // "PENDING_REVIEW"' <<< "$before")
if [ -n "$published" ] || [ -n "$submitted" ]; then
  summary "### Chrome Web Store" "$BROWSE_VERSION is already $([ -n "$published" ] && echo "published" || echo "submitted") on $item: ${published:-$submitted}. Nothing uploaded."
  exit 0
fi
# The revision waiting in review (or approved and about to publish), if any.
pending_state=$(jq -r '.submittedItemRevisionStatus | select(.state == "PENDING_REVIEW" or .state == "STAGED") | .state' <<< "$before")
pending=$(jq -r --arg state "$pending_state" '.submittedItemRevisionStatus | select(.state == $state) | .distributionChannels[0].crxVersion // empty' <<< "$before")
# What the store has of the extension: a pending submission (older, so it's cancelled below unless this build is the
# same extension) or else the published version. When that isn't the newest release, compare with the store's own
# release instead: a chain of releases that changed nothing but the version leaves the store a few versions behind,
# and those still skip, while a store version with no release asset (an upload whose release then failed) or no
# version at all never skips by mistake.
store=${pending:-$(jq -r '.publishedItemRevisionStatus.distributionChannels[0].crxVersion // empty' <<< "$before")}
if [ "$store" != "$previous" ]; then
  unchanged=false
  if [ -z "$store" ]; then
    [ -n "$note" ] || note="The store has no published version, so there's nothing to compare with."
  elif compare_with "$store"; then
    same_version=$store
    unchanged=true
  fi
fi
if [ "$unchanged" = true ]; then
  if dry_run; then
    summary "### Chrome Web Store (dry run)" "Would skip the upload: the extension is unchanged since $same_version and the store has that version; nothing submitted."
  else
    summary "The extension is unchanged since $same_version, so the store keeps that version; nothing submitted"
  fi
  exit 0
fi
# A pending submission blocks another upload. One of this release's version returned above, so this is a different
# build: an older one is cancelled below, so the newest build is the one reviewed. A newer one belongs to a later
# release, so this job stops instead of replacing it.
if [ -n "$pending_state" ] && { [ -z "$pending" ] || ! older_version "$pending" "$BROWSE_VERSION"; }; then
  die "${pending:-A submission} is still $pending_state on $item, so $BROWSE_VERSION can't be submitted; finish that release, or cancel it in the developer dashboard and rerun this job."
fi

if dry_run; then
  summary "### Chrome Web Store (dry run)"
  [ -z "$pending" ] || summary "Would cancel the pending review of $pending so $BROWSE_VERSION gets reviewed instead"
  summary "Would upload $(basename "$zip") ($BROWSE_VERSION) to $item and submit it; the store has $(jq -r '.publishedItemRevisionStatus.distributionChannels[0].crxVersion // "no published version"' <<< "$before")."
  [ -z "$note" ] || summary "$note"
  exit 0
fi
[ -z "$note" ] || summary "$note Uploading $BROWSE_VERSION as usual."
if [ -n "$pending" ]; then
  call POST "$api/v2/$item:cancelSubmission" > /dev/null
  summary "Cancelled the pending review of $pending so $BROWSE_VERSION gets reviewed instead"
fi

uploaded=$(call POST "$api/upload/v2/$item:upload" -H "Content-Type: application/zip" --data-binary "@$zip")
state=$(jq -r '.uploadState // empty' <<< "$uploaded")
version=$(jq -r '.crxVersion // empty' <<< "$uploaded")
# Large packages finish processing asynchronously; poll for up to five minutes.
for _ in $(seq 60); do
  [ "$state" = IN_PROGRESS ] || break
  sleep "$poll"
  current=$(fetch_status)
  state=$(jq -r '.lastAsyncUploadState // empty' <<< "$current")
  version=$(jq -r --arg v "$version" '.submittedItemRevisionStatus.distributionChannels[0].crxVersion // $v' <<< "$current")
done
[ "$state" = SUCCEEDED ] || die "Upload ended in state ${state:-unknown}; see the developer dashboard for the reason."
[ -z "$version" ] || [ "$version" = "$BROWSE_VERSION" ] || die "The store read version $version from the upload, expected $BROWSE_VERSION."
echo "Uploaded $BROWSE_VERSION"

result=$(call POST "$api/v2/$item:publish" -H "Content-Type: application/json" --data '{"publishType":"DEFAULT_PUBLISH"}')
jq -r '.warningInfo.warnings[]? | "::warning::\(.reason // "warning"): \(.description // "")"' <<< "$result"
state=$(jq -r '.state // "unknown"' <<< "$result")
summary "### Chrome Web Store" "Submitted $BROWSE_VERSION on $item: $state."
if [ "$state" = PENDING_REVIEW ]; then
  summary "It goes live when review passes (usually within a few days); follow it in the developer dashboard."
fi
