{
  lib,
  rustPlatform,
  makeBinaryWrapper,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  rev ? "dirty",
}:
let
  workspaceToml = builtins.fromTOML (builtins.readFile ../rust/Cargo.toml);
  version = workspaceToml.workspace.package.version;
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "browse";
  inherit version;

  src = lib.fileset.toSource {
    root = ../rust;
    fileset = lib.fileset.intersection (lib.fileset.fromSource (lib.sources.cleanSource ../rust)) (
      lib.fileset.unions [
        ../rust/Cargo.toml
        ../rust/Cargo.lock
        ../rust/crates
      ]
    );
  };

  cargoLock = {
    lockFile = ../rust/Cargo.lock;
  };

  cargoBuildFlags = [
    "-p"
    "browse"
  ];

  # Integration tests spawn browsers and local relays; unit tests run in CI and smoke checks run in installCheck/checks.
  doCheck = false;

  nativeBuildInputs = [
    makeBinaryWrapper
  ];

  env = {
    BROWSE_VERSION = finalAttrs.version;
    BROWSE_BUILD_ID = "${finalAttrs.version}+${lib.replaceString "-" "." rev}";
  };

  postInstall = ''
    # Keep CLI updates under Nix control by default while still letting explicit env vars override.
    wrapProgram $out/bin/browse \
      --set-default OPENCODE_BROWSER_AUTO_UPDATE off \
      --set-default OPENCODE_BROWSER_UPDATE_CHECK 0
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" ];
  versionCheckProgramArg = "--version";

  meta = {
    description = "Browser automation CLI, relay, and MCP server for coding agents";
    homepage = "https://github.com/anomalyco/browse";
    license = lib.licenses.mit;
    mainProgram = "browse";
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
})
