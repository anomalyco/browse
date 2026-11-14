# Releasing the Rust browse

One binary, `browse`, built from `crates/browse` with the workspace's release profile (`opt-level = "z"`, LTO, one
codegen unit, stripped, `panic = "abort"`).

```sh
cd rust
BROWSE_VERSION=0.1.0 script/release.sh            # every target
BROWSE_VERSION=0.1.0 script/release.sh linux-x64  # one
```

`BROWSE_VERSION` is baked in (else the crate version). A version with `-dev.` follows the `dev` channel, `-beta.` the
`beta` channel, anything else `stable`.

| Install script name | Rust target | Release service target |
|---|---|---|
| linux-x64 | x86_64-unknown-linux-gnu | linux-x64 |
| linux-arm64 | aarch64-unknown-linux-gnu | linux-arm64 |
| linux-x64-musl | x86_64-unknown-linux-musl | linux-x64-musl |
| linux-arm64-musl | aarch64-unknown-linux-musl | linux-arm64-musl |
| darwin-arm64 | aarch64-apple-darwin | macos-arm64 |
| darwin-x64 | x86_64-apple-darwin | macos-x64 |
| windows-x64 | x86_64-pc-windows-msvc | windows-x64 (also runs on Windows on ARM) |

The TS build's `-baseline` (no AVX2) variants aren't needed: Rust's default x86-64 target doesn't require AVX2. Publish the
same file under the baseline names until the install script stops asking for them.

The script prints `name size sha256` per file: those go into the channel manifest's `release.targets` at
`https://anoma.ly/release/browse/cli/<channel>.json`. Installed binaries poll it hourly (unless updates are `off`),
download their target with curl, check size and SHA-256, and replace `~/.local/bin/browse` in place. The relay restarts
on the new file once no agent is using the browser; `browse mcp` proxies reconnect to it on their own.

Update settings: `browse update --mode on|notify|off`, overridden by `OPENCODE_BROWSER_AUTO_UPDATE`
(`OPENCODE_BROWSER_UPDATE_CHECK=0` means off). `OPENCODE_BROWSER_RELEASE_SERVICE` points at another service for tests.
