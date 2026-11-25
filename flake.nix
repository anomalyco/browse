{
  description = "OpenCode Browse CLI, relay, and NixOS module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      rev = self.shortRev or self.dirtyShortRev or "dirty";
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            cargo
            rustc
            clippy
            rustfmt
            bun
            nodejs
            pkg-config
            git
            shellcheck
            zip
            unzip
          ];
        };
      });

      overlays = {
        default = final: _prev: {
          browse = final.callPackage ./nix/browse.nix {
            inherit rev;
          };
        };
      };

      packages = forEachSystem (
        pkgs:
        let
          browse = pkgs.callPackage ./nix/browse.nix {
            inherit rev;
          };
        in
        {
          default = browse;
          inherit browse;
        }
      );

      nixosModules = {
        browse =
          { pkgs, lib, ... }:
          {
            imports = [ ./nix/module.nix ];
            programs.browse.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.browse;
          };
        default = self.nixosModules.browse;
      };

      checks = forEachSystem (pkgs: import ./nix/checks.nix { inherit self pkgs; });

      formatter = forEachSystem (pkgs: pkgs.nixfmt);
    };
}
