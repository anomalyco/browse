#!/usr/bin/env bash
# publish-npm.sh <build dir>: publishes opencode-browse-<version>.tgz to npm with BROWSE_NPM_TAG. The name and version
# come from this script and the environment, never from the tarball: its package.json is read as data and must match.
# Lifecycle scripts never run (--ignore-scripts). NPM_TOKEN is used only while trusted publishing isn't set up.
. "$(dirname "$0")/lib.sh"

name=@opencode/browse
file="$1/opencode-browse-$BROWSE_VERSION.tgz"
test -s "$file" || die "Missing $file"
verify_attestation "$file"

IFS=$'\t' read -r packed_name packed_version config < <(tar -xzOf "$file" package/package.json |
  jq -r '[.name, .version, ((.publishConfig // {}) | keys - ["access"] | length > 0)] | @tsv')
[ "$packed_name" = "$name" ] || die "$file is $packed_name, expected $name"
[ "$packed_version" = "$BROWSE_VERSION" ] || die "$file has version $packed_version, expected $BROWSE_VERSION"
[ "$config" = false ] || die "$file sets publishConfig beyond access"

# A clean directory and config, so nothing from an artifact can redirect the registry.
printf 'registry=https://registry.npmjs.org/\n' > "$RUNNER_TEMP/npmrc"
if [ -n "${NPM_TOKEN:-}" ]; then printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" >> "$RUNNER_TEMP/npmrc"; fi
unset NPM_TOKEN
export NPM_CONFIG_USERCONFIG="$RUNNER_TEMP/npmrc"
cd "$(mktemp -d)" || exit

flags=(--tag "$BROWSE_NPM_TAG" --access public --ignore-scripts)
if dry_run; then
  flags+=(--dry-run)
elif [ "$(npm view "$name@$BROWSE_VERSION" version 2> /dev/null)" = "$BROWSE_VERSION" ]; then
  summary "$name@$BROWSE_VERSION is already on npm; nothing to publish."
  exit 0
else
  flags+=(--provenance)
fi
npm publish "$file" "${flags[@]}"
summary "$(dry_run && echo "Would publish" || echo "Published") $name@$BROWSE_VERSION with dist-tag $BROWSE_NPM_TAG."
