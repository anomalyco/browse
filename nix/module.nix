{
  config,
  lib,
  ...
}:
let
  cfg = config.programs.browse;

  defaultExtensionId = "mfnicocicmmlkpjnaffgihfjhdgjkdjg";

  browserPolicyDirs = {
    chromium = "chromium/policies/managed";
    chrome = "opt/chrome/policies/managed";
    brave = "brave/policies/managed";
    edge = "opt/edge/policies/managed";
    vivaldi = "vivaldi/policies/managed";
  };

  effectiveRelayAddress =
    if cfg.settings.relayAddress != null then
      cfg.settings.relayAddress
    else if cfg.port != null then
      "localhost:${toString cfg.port}"
    else
      null;

  extensionPolicy =
    lib.filterAttrs (_: value: value != null) {
      inherit (cfg.settings)
        window
        grouping
        groupCollapse
        idleMinutes
        humanInput
        muteTabs
        handoffNotifications
        browserName
        ;
      relayAddress = effectiveRelayAddress;
    }
    // lib.optionalAttrs cfg.autoPairLocalRelay {
      autoPairLocalRelay = true;
    };

  browserPolicy = {
    "3rdparty".extensions.${cfg.extensionId} = extensionPolicy;
  };

  policyDirs = lib.unique (
    map (browser: browserPolicyDirs.${browser}) cfg.browsers ++ cfg.extraPolicyDirs
  );

  environment = {
    OPENCODE_BROWSER_AUTO_UPDATE = "off";
    OPENCODE_BROWSER_UPDATE_CHECK = "0";
  }
  // lib.optionalAttrs (cfg.port != null) {
    OPENCODE_BROWSER_PORT = toString cfg.port;
  }
  // lib.optionalAttrs (cfg.extensionId != defaultExtensionId) {
    OPENCODE_BROWSER_STORE_ID = cfg.extensionId;
  }
  // lib.optionalAttrs (cfg.settings.window != null) {
    OPENCODE_BROWSER_AGENT_WINDOW = cfg.settings.window;
  }
  // lib.optionalAttrs (cfg.settings.humanInput != null) {
    OPENCODE_BROWSER_HUMAN_INPUT = if cfg.settings.humanInput == "on" then "1" else "0";
  }
  // lib.optionalAttrs cfg.autoPairLocalRelay {
    OPENCODE_BROWSER_AUTO_PAIR_LOCAL = "1";
  }
  // cfg.extraEnvironment;
in
{
  options.programs.browse = {
    enable = lib.mkEnableOption "OpenCode Browse browser automation";

    package = lib.mkOption {
      type = lib.types.package;
      description = "Browse CLI package to install.";
    };

    extensionId = lib.mkOption {
      type = lib.types.str;
      default = defaultExtensionId;
      description = "Chrome Web Store ID of the OpenCode Browse extension.";
    };

    port = lib.mkOption {
      type = lib.types.nullOr lib.types.port;
      default = null;
      example = 20000;
      description = "Pin the Browse relay to a specific loopback port (OPENCODE_BROWSER_PORT).";
    };

    autoPairLocalRelay = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Allow unpaired local browsers to automatically exchange an ephemeral ECDH
        handshake with the loopback relay for their own per-browser token, without
        storing credentials in the Nix store or entering a pairing code by hand.
        Enables both OPENCODE_BROWSER_AUTO_PAIR_LOCAL=1 on the relay and
        autoPairLocalRelay in browser managed policy. Only enable on single-user
        machines where loopback is trusted.
      '';
    };

    settings = {
      window = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "current"
            "separate"
          ]
        );
        default = null;
        description = "Where agents open their tabs (current window or separate window).";
      };

      grouping = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "shared"
            "session"
            "none"
          ]
        );
        default = null;
        description = "How agent tabs are grouped (shared, session, or none).";
      };

      groupCollapse = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "auto"
            "off"
          ]
        );
        default = null;
        description = "Whether Browse automatically collapses inactive agent tab groups.";
      };

      idleMinutes = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            0
            10
            30
            60
          ]
        );
        default = null;
        description = "Minutes before untouched agent tabs close (0 disables idle closing).";
      };

      humanInput = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "on"
            "off"
          ]
        );
        default = null;
        description = "Use human-like curved mouse paths and paced typing/scrolling.";
      };

      muteTabs = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "on"
            "off"
          ]
        );
        default = null;
        description = "Mute tabs opened by agents.";
      };

      handoffNotifications = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "recording"
            "always"
          ]
        );
        default = null;
        description = "Show system notifications only on recorded tabs or on every handoff.";
      };

      browserName = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Name used to identify this browser to agents.";
      };

      relayAddress = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "localhost:19988";
        description = "Relay host or host:port managed via browser policy.";
      };
    };

    browsers = lib.mkOption {
      type = lib.types.listOf (
        lib.types.enum [
          "chromium"
          "chrome"
          "brave"
          "edge"
          "vivaldi"
        ]
      );
      default = [ ];
      example = [ "chromium" ];
      description = ''
        Chromium-family browsers that should receive /etc/<browser>/policies/managed/opencode-browse.json
        for extension settings and local auto-pairing. Note that Helium and Ungoogled Chromium also
        read policies from "chromium" (/etc/chromium/policies/managed).
      '';
    };

    extraPolicyDirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "chromium/policies/managed" ];
      description = "Additional /etc-relative Chromium managed policy directories to write opencode-browse.json into.";
    };

    installExtension = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Add the Browse Chrome Web Store extension ID to programs.chromium.extensions.
        Requires programs.chromium.enable = true (or wire config.programs.browse.extensionId
        into a custom browser module instead).
      '';
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        OPENCODE_BROWSER_TOOLS = "all";
      };
      description = "Additional environment variables exported for the Browse CLI and relay.";
    };

    extensionPolicy = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      readOnly = true;
      description = "Computed extension policy object matching public/schema.json (for custom browser modules).";
    };

    browserPolicy = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      readOnly = true;
      description = "Computed Chromium 3rdparty policy fragment for this extension.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      description = "Computed Browse environment variables (suitable for sessionVariables and MCP server configs).";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.browse.extensionPolicy = extensionPolicy;
    programs.browse.browserPolicy = browserPolicy;
    programs.browse.environment = environment;

    environment.systemPackages = [ cfg.package ];
    environment.sessionVariables = environment;

    programs.chromium.extensions = lib.mkIf cfg.installExtension [ cfg.extensionId ];

    environment.etc = lib.mkIf (extensionPolicy != { }) (
      lib.listToAttrs (
        map (dir: {
          name = "${dir}/opencode-browse.json";
          value.text = builtins.toJSON browserPolicy;
        }) policyDirs
      )
    );
  };
}
