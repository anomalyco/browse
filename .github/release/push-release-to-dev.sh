#!/usr/bin/env bash
# push-release-to-dev.sh <sha>: brings the release commit (versions and changelog/<version>.md, tagged v<version>)
# back to dev with the release deploy key, the one actor besides admins the dev ruleset lets push. When dev hasn't
# moved since the dispatch, dev fast-forwards to the tagged commit; when it has, the release commit is replayed on the
# newest dev (it only touches the version files and the changelog). Runs git only, with hooks disabled; no repository
# code.
. "$(dirname "$0")/lib.sh"

release=$1
git_bot() {
  git -c core.hooksPath=/dev/null \
    -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" "$@"
}

git fetch -q origin "$release"
for attempt in 1 2 3; do
  git fetch -q origin dev
  if git merge-base --is-ancestor origin/dev "$release"; then
    target=$release
  else
    git checkout -q --detach origin/dev
    git_bot cherry-pick --allow-empty --keep-redundant-commits "$release" > /dev/null ||
      die "The release commit doesn't apply to dev; bring v$BROWSE_VERSION's versions and changelog back by hand"
    target=$(git rev-parse HEAD)
  fi
  if git push -q origin "$target:refs/heads/dev"; then
    summary "Pushed the v$BROWSE_VERSION release commit to dev ($target)"
    exit 0
  fi
  echo "dev moved during the push (attempt $attempt); trying again"
done
die "Couldn't push the release commit to dev; bring v$BROWSE_VERSION's versions and changelog back by hand"
