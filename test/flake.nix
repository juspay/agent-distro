{
  description = "Launcher integration tests for every profile in the registry";
  inputs = {
    agent-distro.url = "path:..";
    nixpkgs.follows = "agent-distro/nixpkgs";
  };
  outputs = { nixpkgs, agent-distro, ... }:
    let
      inherit (nixpkgs) lib;
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (agent-distro.lib) mkLaunchers;
      # Profiles are tested through the public builder, the same way a
      # third-party distribution reaches them.
      suite = profile: import ./lib.nix {
        inherit pkgs profile mkLaunchers;
        launchers = mkLaunchers { inherit pkgs profile; };
      };
      vanilla = suite agent-distro.profiles.vanilla;
      juspay = suite agent-distro.profiles.juspay;
      named = profile: lib.mapAttrs' (check: lib.nameValuePair "${profile}-${check}");
      profiles = builtins.attrNames agent-distro.profiles;
    in
    {
      checks.${system} =
        # No plugins and no gateway, so only the core four apply.
        named "vanilla" { inherit (vanilla) omp codex claude picker; }
        # Plugins, a gateway, and Kolu's MCP server: every check applies.
        // named "juspay" {
          inherit (juspay) omp codex claude picker gateway gatewayEnv
            ompPlugins codexPlugins claudePlugins ompKolu codexKolu claudeKolu;
        }
        // {
          menu = pkgs.testers.runNixOSTest (import ./test-menu.nix {
            inherit profiles;
            menu = agent-distro.packages.${system}.default;
            # registry.nix names the default; reading it here keeps the test
            # honest about which profile the menu opens on.
            inherit (import "${agent-distro}/profiles/registry.nix") default;
          });
        };
    };
}
