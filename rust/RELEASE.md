# Releasing the Rust browse

Releases run in GitHub Actions ([../RELEASING.md](../RELEASING.md), [../.github/workflows/release.yml](../.github/workflows/release.yml)).
One binary, `browse`, built from `crates/browse` with the workspace's release profile (`opt-level = "z"`, LTO, one
codegen unit, stripped, `panic = "abort"`).

The version is the repository's one release version (`bun scripts/version.ts set <version>` writes it into
`Cargo.toml`'s `[workspace.package]` and every workspace crate in `Cargo.lock`; new crates take
`version.workspace = true`). The build also bakes it in from `BROWSE_VERSION` (else the crate version), and the relay's
`/version` `buildId` from `BROWSE_BUILD_ID` (the release uses the run's ISO time; else the version). A version with
`-dev.` follows the `dev` channel, `-beta.` the `beta` channel, anything else `stable`.

To build locally:

```sh
cd rust
BROWSE_VERSION=0.0.18 script/release.sh            # every target
BROWSE_VERSION=0.0.18 script/release.sh linux-x64  # one
bun ../scripts/npm-package.ts platforms --binaries dist --out dist/npm   # the platform packages
```

| Install script name | Rust target | Release service target |
|---|---|---|
| linux-x64 | x86_64-unknown-linux-gnu (glibc 2.17) | linux-x64 |
| linux-arm64 | aarch64-unknown-linux-gnu (glibc 2.17) | linux-arm64 |
| linux-x64-musl | x86_64-unknown-linux-musl | linux-x64-musl |
| linux-arm64-musl | aarch64-unknown-linux-musl | linux-arm64-musl |
| darwin-arm64 | aarch64-apple-darwin | macos-arm64 |
| darwin-x64 | x86_64-apple-darwin | macos-x64 |
| windows-x64 | x86_64-pc-windows-msvc (+crt-static) | windows-x64 (also runs on Windows on ARM) |

The TS build's `-baseline` (no AVX2) variants aren't needed: Rust's default x86-64 target doesn't require AVX2. The
release publishes the same binary under the baseline names, which the install script still asks for.

Each target ships as `opencode-browse-<target>-<version>.tgz` holding `package/bin/browse[.exe]`, `package.json` and
`LICENSE`: the npm package `@opencode/browse-<target>` and the release service file are the same tarball. Its size and
SHA-256 go into the channel manifest's `release.targets` at `https://anoma.ly/release/browse/cli/<channel>.json`.
Installed binaries poll it hourly (unless updates are `off`), download their target's tarball with curl, check size
and SHA-256, unpack it with tar and replace `~/.local/bin/browse` in place. The relay restarts on the new file once no
agent is using the browser; `browse mcp` proxies reconnect to it on their own.

`@opencode/browse` (npm) is `npm/browse.mjs`, shipped as `dist/cli.mjs`: it runs the binary of whichever
`@opencode/browse-<target>` npm installed. npm installs don't update themselves; `browse install` moves them to the
self-updating binary in `~/.local/bin`.

Update settings: `browse update --mode on|notify|off`, overridden by `OPENCODE_BROWSER_AUTO_UPDATE`
(`OPENCODE_BROWSER_UPDATE_CHECK=0` means off). `OPENCODE_BROWSER_RELEASE_SERVICE` points at another service for tests.
