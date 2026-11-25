{ self, pkgs }:
let
  inherit (pkgs) lib;
  system = pkgs.stdenv.hostPlatform.system;
  browse = self.packages.${system}.browse;

  evalNixos =
    module:
    (self.inputs.nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        self.nixosModules.browse
        {
          system.stateVersion = "26.05";
        }
        module
      ];
    }).config;
in
{
  package = pkgs.runCommand "browse-package-check" { } ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    ${lib.getExe browse} --version
    ${lib.getExe browse} tools > /dev/null
    touch "$out"
  '';
}
// lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
  modules =
    let
      disabled = evalNixos {
        programs.browse.enable = false;
      };
      enabled = evalNixos {
        programs.chromium.enable = true;
        programs.browse = {
          enable = true;
          port = 20000;
          autoPairLocalRelay = true;
          browsers = [
            "chromium"
            "chrome"
          ];
          installExtension = true;
          settings = {
            window = "separate";
            grouping = "session";
            groupCollapse = "off";
            idleMinutes = 30;
            humanInput = "off";
            muteTabs = "on";
            handoffNotifications = "always";
            browserName = "Helium on NixOS";
          };
        };
      };
      chromiumPolicy =
        builtins.fromJSON
          enabled.environment.etc."chromium/policies/managed/opencode-browse.json".text;
      chromePolicy =
        builtins.fromJSON
          enabled.environment.etc."opt/chrome/policies/managed/opencode-browse.json".text;
      extId = "mfnicocicmmlkpjnaffgihfjhdgjkdjg";
      extPolicy = chromiumPolicy."3rdparty".extensions.${extId};
    in
    assert !(builtins.elem browse disabled.environment.systemPackages);
    assert builtins.elem browse enabled.environment.systemPackages;
    assert enabled.environment.sessionVariables.OPENCODE_BROWSER_AUTO_UPDATE == "off";
    assert enabled.environment.sessionVariables.OPENCODE_BROWSER_UPDATE_CHECK == "0";
    assert enabled.environment.sessionVariables.OPENCODE_BROWSER_PORT == "20000";
    assert enabled.environment.sessionVariables.OPENCODE_BROWSER_AGENT_WINDOW == "separate";
    assert enabled.environment.sessionVariables.OPENCODE_BROWSER_HUMAN_INPUT == "0";
    assert enabled.environment.sessionVariables.OPENCODE_BROWSER_AUTO_PAIR_LOCAL == "1";
    assert builtins.elem extId enabled.programs.chromium.extensions;
    assert chromiumPolicy == chromePolicy;
    assert extPolicy.window == "separate";
    assert extPolicy.grouping == "session";
    assert extPolicy.groupCollapse == "off";
    assert extPolicy.idleMinutes == 30;
    assert extPolicy.humanInput == "off";
    assert extPolicy.muteTabs == "on";
    assert extPolicy.handoffNotifications == "always";
    assert extPolicy.browserName == "Helium on NixOS";
    assert extPolicy.relayAddress == "localhost:20000";
    assert extPolicy.autoPairLocalRelay == true;
    pkgs.runCommand "browse-module-check" { } ''
      touch "$out"
    '';
}
