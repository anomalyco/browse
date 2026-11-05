#!/usr/bin/env bash
# Snapshot each public latest tag before publishing. Only restore a tag still pointing to this failed release.
. "$(dirname "$0")/lib.sh"

names=(@opencode/browse)
for target in $browse_targets; do names+=("@opencode/browse-$target"); done
stable_version "$BROWSE_VERSION" || die "Invalid candidate version"
latest() {
  curl --fail --silent --show-error --retry 2 "https://registry.npmjs.org/-/package/${1/\//%2f}/dist-tags" | jq -er .latest
}
case "$1" in
  snapshot)
    tags='{}'
    for name in "${names[@]}"; do
      old=$(latest "$name")
      if ! stable_version "$old" || [[ "$old" == "$BROWSE_VERSION" ]]; then die "No prior stable latest on $name ($old)"; fi
      tags=$(jq -c --arg n "$name" --arg v "$old" '. + {($n): $v}' <<< "$tags")
    done
    echo "tags=$tags" >> "$GITHUB_OUTPUT"
    ;;
  restore)
    summary '### Failed published verification: restore npm latest' \
      'If automatic recovery fails, verify latest still points at the failed release and run these commands as a maintainer:' '```sh'
    for name in "${names[@]}"; do
      old=$(jq -er --arg n "$name" '.[$n]' <<< "$PREVIOUS_LATEST")
      if ! stable_version "$old" || [[ "$old" == "$BROWSE_VERSION" ]]; then die "Invalid snapshot for $name"; fi
      summary "npm dist-tag add $name@$old latest"
    done
    summary '```'
    # Node 24 bundles an npm too old for OIDC dist-tag. Pin the official CLI (including its bundled dependencies),
    # verify the bytes before execution and run outside the checkout. No npm install, lifecycle hooks or write token.
    cd "$(mktemp -d)"
    curl -fsS https://registry.npmjs.org/npm/-/npm-11.21.0.tgz -o npm.tgz
    hash=$(openssl dgst -sha512 -binary npm.tgz | openssl base64 -A)
    [[ "$hash" == 'Zov8KhamNneiLdELtj5YALtNmJW4L4fCLTzjfpzXG2w6MSHcf0UxgdlK5uloCuksWT+7mGUU7wi79cO6RqivPg==' ]] || die 'npm CLI integrity mismatch'
    tar -xzf npm.tgz
    failed=false
    for name in "${names[@]}"; do
      old=$(jq -er --arg n "$name" '.[$n]' <<< "$PREVIOUS_LATEST")
      current=$(latest "$name")
      if [[ "$current" == "$old" ]]; then continue; fi
      if [[ "$current" != "$BROWSE_VERSION" ]]; then
        summary "Refusing to overwrite $name latest: now $current, not $BROWSE_VERSION."
        failed=true
      elif ! node package/bin/npm-cli.js dist-tag add "$name@$old" latest --registry=https://registry.npmjs.org; then
        failed=true
      fi
    done
    [[ "$failed" == false ]] || die 'Rollback incomplete. Check Allow npm dist-tag on each trusted publisher; exact manual commands are in the job summary.'
    summary 'Restored the previous latest tags on all 12 packages.'
    ;;
  *) die 'Expected snapshot or restore' ;;
esac
