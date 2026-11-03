#!/usr/bin/env bash
# tag-release.sh: in a checkout of the dispatched dev commit, commits the release version (cli/package.json,
# package.json, public/manifest.json) and changelog/<version>.md (from BROWSE_RELEASE_NOTES), and pushes only the
# v<version> tag at it. Writes sha=<commit> to $GITHUB_OUTPUT. Runs git and jq only, with hooks disabled; no
# repository code.
. "$(dirname "$0")/lib.sh"

stable_version "$BROWSE_VERSION" || die "Not a stable version: $BROWSE_VERSION"
tag="v$BROWSE_VERSION"

# The top-level "version" (two-space indent) of each file, edited in place so nothing else is reformatted; a stable
# manifest has no version_name.
for file in cli/package.json package.json public/manifest.json; do
  sed -i -E "s/^  \"version\": \"[^\"]+\",$/  \"version\": \"$BROWSE_VERSION\",/; /^  \"version_name\": /d" "$file"
  [ "$(jq -r '.version' "$file")" = "$BROWSE_VERSION" ] || die "Couldn't set the version in $file"
  jq -e 'has("version_name") | not' "$file" > /dev/null || die "Couldn't remove version_name from $file"
done

changelog="changelog/$BROWSE_VERSION.md"
if [ ! -e "$changelog" ]; then
  mkdir -p changelog
  {
    echo "---"
    echo "date: $(date -u +%F)"
    echo "summary: $(notes_summary)"
    echo "---"
    notes_body
  } > "$changelog"
  git add "$changelog"
fi

if git diff --cached --name-only HEAD | grep -vxE "cli/package\.json|package\.json|public/manifest\.json|changelog/$BROWSE_VERSION\.md" ||
  git diff --name-only | grep -vxE 'cli/package\.json|package\.json|public/manifest\.json'; then
  die "The release commit may only change versions and the changelog"
fi

git -c core.hooksPath=/dev/null \
  -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --no-verify -q -am "release: $tag" -m "$(notes_summary)"

# A rerun reuses the tag when it holds the same tree.
existing=$(git ls-remote origin "refs/tags/$tag" | cut -f1)
if [ -n "$existing" ]; then
  git fetch -q --depth=1 origin "refs/tags/$tag"
  [ "$(git rev-parse "$existing^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] || die "Tag $tag already exists with different contents"
  echo "sha=$existing" >> "$GITHUB_OUTPUT"
  exit 0
fi
git push -q origin "HEAD:refs/tags/$tag"
echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
summary "Tagged $(git rev-parse HEAD) as $tag"
