#!/usr/bin/env bash
# publish-npm.sh <build dir> <binaries dir> [<signed dir>]: publishes the platform packages @opencode/browse-<target>
# (opencode-browse-<target>-<version>.tgz: package/bin/browse, which the install script downloads), then
# opencode-browse-<version>.tgz (@opencode/browse, the npx package), all with BROWSE_NPM_TAG. Names, the version and the
# package set come from this script and the environment, never from the tarballs: each package.json is read as data and
# must match. With a signed dir (sign-macos.sh), the macOS packages must come from it. Lifecycle scripts never run
# (--ignore-scripts). npm authenticates with trusted publishing (OIDC); there is no token.
. "$(dirname "$0")/lib.sh"

build_dir=$1 binaries_dir=$2 signed_dir=${3:-}

check_package() { # <file> <name> [<os> <cpu> <libc or "">]
  local file=$1 name=$2 packed_name packed_version config scripts os cpu libc
  test -s "$file" || die "Missing $file"
  verify_attestation "$file"
  IFS=$'\t' read -r packed_name packed_version config scripts os cpu libc < <(tar -xzOf "$file" package/package.json |
    jq -r '[.name, .version, ((.publishConfig // {}) | keys - ["access"] | length > 0),
      ((.scripts // {}) | (has("preinstall") or has("install") or has("postinstall") or has("prepare"))),
      ((.os // []) | join(",")), ((.cpu // []) | join(",")), ((.libc // []) | join(","))] | @tsv')
  [ "$packed_name" = "$name" ] || die "$file is $packed_name, expected $name"
  [ "$packed_version" = "$BROWSE_VERSION" ] || die "$file has version $packed_version, expected $BROWSE_VERSION"
  [ "$config" = false ] || die "$file sets publishConfig beyond access"
  [ "$scripts" = false ] || die "$file has an install script"
  if [ $# -eq 2 ]; then return; fi
  [ "$os,$cpu,$libc" = "$3,$4,$5" ] || die "$file is for os $os cpu $cpu libc $libc, expected $3 $4 $5"
}

list=$(mktemp)
for target in $browse_targets; do
  IFS=- read -r os arch _ <<< "$target"
  executable=browse libc=""
  case $os in
    windows) os=win32 executable=browse.exe ;;
    linux) libc=glibc ;;
  esac
  if [[ "$target" == *-musl ]]; then libc=musl; fi
  dir=$binaries_dir
  if [ -n "$signed_dir" ] && [ "$os" = darwin ]; then dir=$signed_dir; fi
  file="$dir/opencode-browse-$target-$BROWSE_VERSION.tgz"
  check_package "$file" "@opencode/browse-$target" "$os" "$arch" "$libc"
  # Exactly the binary (executable), package.json and LICENSE, as the install script expects.
  entries=$(tar -tvzf "$file" | awk '{print $1, $NF}' | LC_ALL=C sort)
  expected=$(printf '%s\n' "-rw-r--r-- package/LICENSE" "-rw-r--r-- package/package.json" "-rwxr-xr-x package/bin/$executable" | LC_ALL=C sort)
  [ "$entries" = "$expected" ] || die "$file holds $entries"
  printf '%s\t%s\n' "@opencode/browse-$target" "$file" >> "$list"
done
# @opencode/browse goes last, once every binary of its version is on npm.
file="$build_dir/opencode-browse-$BROWSE_VERSION.tgz"
check_package "$file" @opencode/browse
printf '%s\t%s\n' @opencode/browse "$file" >> "$list"

# A clean directory and config, so nothing from an artifact can redirect the registry.
printf 'registry=https://registry.npmjs.org/\n' > "$RUNNER_TEMP/npmrc"
export NPM_CONFIG_USERCONFIG="$RUNNER_TEMP/npmrc"
cd "$(mktemp -d)" || exit

flags=(--tag "$BROWSE_NPM_TAG" --access public --ignore-scripts)
if dry_run; then flags+=(--dry-run); else flags+=(--provenance); fi
while IFS=$'\t' read -r name file; do
  if ! dry_run && [ "$(npm view "$name@$BROWSE_VERSION" version 2> /dev/null)" = "$BROWSE_VERSION" ]; then
    summary "$name@$BROWSE_VERSION is already on npm; nothing to publish."
    continue
  fi
  npm publish "$file" "${flags[@]}"
  summary "$(dry_run && echo "Would publish" || echo "Published") $name@$BROWSE_VERSION with dist-tag $BROWSE_NPM_TAG."
done < "$list"
