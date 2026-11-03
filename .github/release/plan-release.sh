#!/usr/bin/env bash
# plan-release.sh: decides the mode, version and npm dist-tag from the event, ref and dispatch inputs (INPUT_BUMP,
# INPUT_VERSION, INPUT_RELEASE_NOTES), and writes them to $GITHUB_OUTPUT. It reads cli/package.json of the triggering
# commit through the API, as data; nothing here runs repository code.
#
#   push to dev                          dev     <next patch>-dev.<run>[.<attempt>]  npm tag dev, release service
#   dispatch on dev with bump/version    stable  x.y.z                               npm latest, Chrome Web Store,
#                                                                                    tag and GitHub release; admins and
#                                                                                    maintainers only
#   dispatch with bump check, no version check   the version in cli/package.json     builds, checks and attests the
#                                                                                    stable artifacts; publishes nothing
. "$(dirname "$0")/lib.sh"

if [ "${INPUT_BUMP:-}" = check ]; then INPUT_BUMP=""; fi
versioned=false
if [ -n "${INPUT_BUMP:-}" ] || [ -n "${INPUT_VERSION:-}" ]; then versioned=true; fi
case "$GITHUB_EVENT_NAME:$GITHUB_REF:$versioned" in
  push:refs/heads/dev:false) mode=dev ;;
  workflow_dispatch:refs/heads/dev:true) mode=stable ;;
  workflow_dispatch:*:false) mode=check ;;
  *) die "$GITHUB_EVENT_NAME on $GITHUB_REF cannot release (bump or version given: $versioned); stable releases are dispatched on dev" ;;
esac

current=$(gh api -H "Accept: application/vnd.github.raw" "repos/$GITHUB_REPOSITORY/contents/cli/package.json?ref=$GITHUB_SHA" | jq -r .version)
stable_version "$current" || die "cli/package.json at $GITHUB_SHA has version $current, not a stable x.y.z"
IFS=. read -r major minor patch <<< "$current"

if [ "$mode" = stable ]; then
  actor=${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-}}
  [ -n "$actor" ] || die "Stable releases can only be started by repository admins or maintainers; the triggering actor is unknown"
  role=$(gh api "repos/$GITHUB_REPOSITORY/collaborators/$actor/permission" --jq .role_name 2> /dev/null) || role=""
  case "$role" in
    admin | maintain) ;;
    *) die "Stable releases can only be started by repository admins or maintainers; $actor has ${role:-no readable role}" ;;
  esac

  # The changelog/<version>.md that tag-release.sh writes: a summary line, then ## Major, ## Improvements, ## Fixes.
  notes=${INPUT_RELEASE_NOTES:-}
  [ -n "${notes//[[:space:]]/}" ] || die "Stable releases need release_notes: a summary line, then ## Major / ## Improvements / ## Fixes sections"
  export BROWSE_RELEASE_NOTES=$notes
  summary_line=$(notes_summary)
  [[ "$summary_line" != "#"* ]] || die "The first line of release_notes is the summary, not a heading: $summary_line"
  headings=$(notes_body | grep -E '^## ' || true)
  [ -n "$headings" ] || die "release_notes have no ## Major, ## Improvements or ## Fixes section"
  if printf '%s\n' "$headings" | grep -vxE '## (Major|Improvements|Fixes)[[:space:]]*'; then
    die "release_notes may only have ## Major, ## Improvements and ## Fixes sections"
  fi
  if printf '%s\n' "$notes" | grep -qF TODO; then die "release_notes still have TODO placeholders"; fi

  if [ -n "${INPUT_VERSION:-}" ]; then
    version=$INPUT_VERSION
  else
    case "$INPUT_BUMP" in
      major) version="$((major + 1)).0.0" ;;
      minor) version="$major.$((minor + 1)).0" ;;
      patch) version="$major.$minor.$((patch + 1))" ;;
      *) die "Unknown bump $INPUT_BUMP" ;;
    esac
  fi
  stable_version "$version" || die "Invalid release version $version (x.y.z, each part at most 65535)"
  [ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | head -n 1)" = "$current" ] ||
    die "$version is older than the version in cli/package.json ($current)"
  status=$(curl -sS -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/@opencode%2fbrowse/$version")
  [ "$status" != 200 ] || die "@opencode/browse@$version is already published"
  channel=latest npm_tag=latest dry_run=false
elif [ "$mode" = dev ]; then
  [ "$GITHUB_RUN_NUMBER" -le 65535 ] || die "Run $GITHUB_RUN_NUMBER doesn't fit a Chrome manifest version"
  version="$major.$minor.$((patch + 1))-dev.$GITHUB_RUN_NUMBER"
  if [ "$GITHUB_RUN_ATTEMPT" != 1 ]; then version="$version.$GITHUB_RUN_ATTEMPT"; fi
  channel=dev npm_tag=dev dry_run=false
else
  version=$current channel=latest npm_tag=latest dry_run=true
fi

{
  echo "mode=$mode"
  echo "version=$version"
  echo "channel=$channel"
  echo "npm_tag=$npm_tag"
  echo "dry_run=$dry_run"
} | tee -a "$GITHUB_OUTPUT"
summary "Release $version ($mode, npm dist-tag $npm_tag, dry run: $dry_run) from $GITHUB_SHA"
