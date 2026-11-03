#!/usr/bin/env bash
# publish-version-pr.sh <sha>: opens the pull request that brings the release commit (versions and changelog) back to
# dev, so dev builds count up from the new version. Pushing to dev is blocked by rulesets, so this never merges.
. "$(dirname "$0")/lib.sh"

branch="release-v$BROWSE_VERSION"
gh api "repos/$GH_REPO/git/refs" -f "ref=refs/heads/$branch" -f "sha=$1" > /dev/null ||
  gh api "repos/$GH_REPO/git/refs/heads/$branch" > /dev/null
body="Brings the versions and changelog of the published \`v$BROWSE_VERSION\` release back to \`dev\`. The \`v$BROWSE_VERSION\` tag points at this commit."
gh pr create --base dev --head "$branch" --title "release: v$BROWSE_VERSION" --body "$body" ||
  echo "::warning::Could not open the release PR. Open it by hand: gh pr create --base dev --head $branch"
