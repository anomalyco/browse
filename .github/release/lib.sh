# shellcheck shell=bash
# Shared helpers for the release scripts. Sourced, never executed.
#
# These scripts run in the jobs that hold a secret, an OIDC token or a write token. They must never execute
# repository code or artifact contents: artifacts are data, and every value that names a destination comes from
# the environment the workflow sets (BROWSE_VERSION, BROWSE_CHANNEL, BROWSE_NPM_TAG, BROWSE_DRY_RUN, ...).

set -euo pipefail
# Platform suffixes accepted by publish-npm and its dist-tag rollback. Never take package names from artifacts.
# shellcheck disable=SC2034 # Used by scripts sourcing this library.
browse_targets='linux-x64 linux-x64-baseline linux-arm64 linux-x64-musl linux-x64-baseline-musl linux-arm64-musl darwin-arm64 darwin-x64 darwin-x64-baseline windows-x64 windows-x64-baseline'
# macOS /bin/bash (sign-macos.sh) is 3.2, which lacks inherit_errexit.
if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" = 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }; then
  shopt -s inherit_errexit
fi

die() {
  echo "::error::$*" >&2
  exit 1
}

dry_run() {
  [ "${BROWSE_DRY_RUN:-false}" = true ]
}

sha256() {
  sha256sum "$@"
}

summary() {
  printf '%s\n' "$@"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi
}

# A stable release version: x.y.z, each part at most 65535 (Chrome's manifest version limit).
stable_version() {
  [[ "$1" =~ ^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$ ]] &&
    [ "${BASH_REMATCH[1]}" -le 65535 ] && [ "${BASH_REMATCH[2]}" -le 65535 ] && [ "${BASH_REMATCH[3]}" -le 65535 ]
}

# Checks that a file is the one this workflow built and attested on dev.
verify_attestation() {
  dry_run && return
  gh attestation verify "$1" --repo "$GITHUB_REPOSITORY" \
    --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml" --source-ref refs/heads/dev > /dev/null ||
    die "No attestation from this workflow on dev for $(basename "$1")"
}

# The release notes split into the summary (first non-empty line) and the body.
notes_summary() {
  printf '%s\n' "${BROWSE_RELEASE_NOTES:-}" | sed '/^[[:space:]]*$/d' | head -n 1
}

notes_body() {
  printf '%s\n' "${BROWSE_RELEASE_NOTES:-}" | sed -e '/./,$!d' | sed -e '1d' -e '/./,$!d'
}
