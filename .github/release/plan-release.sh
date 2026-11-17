#!/usr/bin/env bash
# plan-release.sh: decides the mode, version and npm dist-tag from the event, ref and dispatch inputs (INPUT_BUMP,
# INPUT_VERSION, INPUT_RELEASE_NOTES), and writes them to $GITHUB_OUTPUT. A version counts from the newest of
# cli/package.json at the triggering commit and the newest v* tag: the tag job runs before any publish, so a version
# whose tag exists has shipped even when a publish job failed and its release commit never reached dev. It reads both
# through the API, as data; nothing here runs repository code.
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

# The version a stable release plans from <base>: INPUT_VERSION, or the bump applied to it.
if [ -z "${INPUT_VERSION:-}" ] && [ -n "${INPUT_BUMP:-}" ]; then
  case "$INPUT_BUMP" in major | minor | patch) ;; *) die "Unknown bump $INPUT_BUMP" ;; esac
fi
next_version() {
  if [ -n "${INPUT_VERSION:-}" ]; then printf '%s\n' "$INPUT_VERSION"; return 0; fi
  local major minor patch
  IFS=. read -r major minor patch <<< "$1"
  case "$INPUT_BUMP" in
    major) printf '%s\n' "$((major + 1)).0.0" ;;
    minor) printf '%s\n' "$major.$((minor + 1)).0" ;;
    patch) printf '%s\n' "$major.$minor.$((patch + 1))" ;;
  esac
}

current=$(gh api -H "Accept: application/vnd.github.raw" "repos/$GITHUB_REPOSITORY/contents/cli/package.json?ref=$GITHUB_SHA" | jq -r .version)
stable_version "$current" || die "cli/package.json at $GITHUB_SHA has version $current, not a stable x.y.z"
# The tag job runs before any publish, so a version whose tag exists is consumed even when a publish job failed and its
# release commit never reached dev. Count from the newest of cli/package.json and the newest stable v* tag.
tag_refs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/v" --jq '.[].ref') ||
  die "Couldn't read the repository's v* tags"
stable_tags=$(while IFS= read -r ref; do
  candidate=${ref#refs/tags/v}
  if stable_version "$candidate"; then printf '%s\n' "$candidate"; fi
done <<< "$tag_refs")
newest_tag=$(printf '%s\n' "$stable_tags" | sort -V | tail -n 1)
base=$(printf '%s\n%s\n' "$current" "$newest_tag" | sort -V | tail -n 1)
# A rerun of a dispatch that already tagged its release: tag-release.sh makes its release commit on $GITHUB_SHA and
# reuses v<version> when that commit's tree matches. Leave that tag out only when this dispatch plans that same version
# without it; a fresh dispatch, or one planning past it, keeps counting it, so it never plans below a shipped version.
if [ "$mode" = stable ] && [ "${GITHUB_RUN_ATTEMPT:-1}" != 1 ] && [ -n "$newest_tag" ]; then
  tag_parent=$(gh api "repos/$GITHUB_REPOSITORY/commits/refs/tags/v$newest_tag" --jq '.parents[0].sha') ||
    die "Couldn't read the commit of tag v$newest_tag"
  if [ "$tag_parent" = "$GITHUB_SHA" ]; then
    older_tag=$(printf '%s\n' "$stable_tags" | grep -vxF "$newest_tag" | sort -V | tail -n 1 || true)
    older_base=$(printf '%s\n%s\n' "$current" "$older_tag" | sort -V | tail -n 1)
    if [ "$(next_version "$older_base")" = "$newest_tag" ]; then base=$older_base; fi
  fi
fi
IFS=. read -r major minor patch <<< "$base"

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

  version=$(next_version "$base")
  stable_version "$version" || die "Invalid release version $version (x.y.z, each part at most 65535)"
  [ "$(printf '%s\n%s\n' "$base" "$version" | sort -V | tail -n 1)" = "$version" ] && [ "$version" != "$base" ] ||
    die "$version must be newer than cli/package.json ($current) and the newest tag (${newest_tag:-none})"
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

# The build id every binary of this run reports (the relay's /version buildId): an ISO time, which clients order
# builds by (the TypeScript CLI's relay lifecycle), so a relay of this run is newer than any earlier build.
build_id=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

{
  echo "mode=$mode"
  echo "build_id=$build_id"
  echo "version=$version"
  echo "channel=$channel"
  echo "npm_tag=$npm_tag"
  echo "dry_run=$dry_run"
} | tee -a "$GITHUB_OUTPUT"
summary "Release $version ($mode, npm dist-tag $npm_tag, dry run: $dry_run) from $GITHUB_SHA"
