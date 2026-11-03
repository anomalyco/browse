#!/usr/bin/env bash
# publish-cws.sh <build dir>: uploads opencode-browser-<BROWSE_VERSION>.zip to the Chrome Web Store item and submits it
# for review, with the Chrome Web Store API v2 and curl.
#
# Environment: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (secrets of the release environment), CWS_PUBLISHER_ID
# and CWS_ITEM_ID (repository variables).
# Idempotent: when the item already has this version (published or in review), nothing is uploaded again; it reports
# the state. Publishing uses the item's visibility in the dashboard and submits for review; it doesn't wait for review.
# An item holds one submission at a time, so it fails while another version is still pending review.
# A dry run checks the zip, and with credentials also reads the item's status, but uploads nothing.
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
api=$(endpoint "${CWS_API_BASE:-}" https://chromewebstore.googleapis.com)
token_url=$(endpoint "${CWS_TOKEN_URL:-}" https://oauth2.googleapis.com/token)
poll=${CWS_POLL_SECONDS:-5}

stable_version "$BROWSE_VERSION" || die "Not a stable version: $BROWSE_VERSION"
zip="$1/opencode-browser-$BROWSE_VERSION.zip"
test -s "$zip" || die "Missing $zip"
verify_attestation "$zip"
# Never upload a zip whose manifest isn't the version being released.
packaged=$(unzip -p "$zip" manifest.json | jq -r .version)
[ "$packaged" = "$BROWSE_VERSION" ] || die "$zip has manifest version $packaged, not $BROWSE_VERSION"
if unzip -p "$zip" manifest.json | jq -e 'has("key")' > /dev/null; then die "$zip has a manifest key; the store rejects it"; fi

if dry_run && [ -z "${CWS_REFRESH_TOKEN:-}" ]; then
  summary "### Chrome Web Store (dry run)" "Would upload $(basename "$zip") ($BROWSE_VERSION) to item ${CWS_ITEM_ID:-<CWS_ITEM_ID>} and submit it for review."
  exit 0
fi
for name in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID CWS_ITEM_ID; do
  [ -n "${!name:-}" ] || die "$name is not set (RELEASING.md, one-time setup)"
done
item="publishers/$(jq -rn --arg v "$CWS_PUBLISHER_ID" '$v | @uri')/items/$(jq -rn --arg v "$CWS_ITEM_ID" '$v | @uri')"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Credentials go to curl through files, never on its command line.
jq -rn --arg id "$CWS_CLIENT_ID" --arg secret "$CWS_CLIENT_SECRET" --arg refresh "$CWS_REFRESH_TOKEN" \
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
# The version waiting in review (or approved and about to publish) blocks another upload.
pending=$(jq -r '.submittedItemRevisionStatus | select(.state == "PENDING_REVIEW" or .state == "STAGED") | "\(.distributionChannels[0].crxVersion // "unknown") is still \(.state)"' <<< "$before")
[ -z "$pending" ] || die "$pending on $item; wait for it, or cancel it in the developer dashboard, then rerun this job."

if dry_run; then
  summary "### Chrome Web Store (dry run)" "Would upload $(basename "$zip") ($BROWSE_VERSION) to $item and submit it; the store has $(jq -r '.publishedItemRevisionStatus.distributionChannels[0].crxVersion // "no published version"' <<< "$before")."
  exit 0
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
