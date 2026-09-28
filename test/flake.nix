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
      # Test-only: the plugin shapes the Agent Plugins spec allows beyond what
      # the real profiles happen to use.
      fixtures = suite {
        name = "fixtures";
        description = "Agent Plugins test fixtures";
        plugins = [ ./fixtures/spec-plugin ./fixtures/mcp-only ./fixtures/my-skills ];
        gateway = null;
      };
      readPlugin = pkgs.callPackage "${agent-distro}/lib/read-plugin.nix" { };
      named = profile: lib.mapAttrs' (check: lib.nameValuePair "${profile}-${check}");
    in
    {
      checks.${system} =
        # No plugins and no gateway, so only the core launcher checks apply.
        named "vanilla" { inherit (vanilla) omp codex codexTerminal claude picker; }
        # Plugins, a gateway, and Kolu's MCP server: every check applies.
        // named "juspay" {
          inherit (juspay) omp codex codexTerminal claude picker gateway gatewayEnv
            ompPlugins codexPlugins claudePlugins ompKolu codexKolu claudeKolu;
        }
        # MCP-only, skills-only, and every MCP shape the translation handles.
        # No `omp`: OMP 18.4.1 loads no skills from these plugins as `-e` roots
        # (the real profiles' plugins also carry harness-specific manifests).
        // named "fixtures" { inherit (fixtures) codex claude claudeSpec; }
        // {
          # The reader alone, without a VM: invalid manifests, skipped
          # components, and a failed build that names the field.
          reader = pkgs.runCommand "read-plugin-checks"
            {
              failed = pkgs.testers.testBuildFailure
                (readPlugin (pkgs.writeTextDir "plugin.json" ''{"name": "no-schema"}''));
            } ''
            ${pkgs.python3.interpreter} ${./check-read-plugin.py} ${agent-distro}/lib/read-plugin.py
            grep -F '`$schema` is missing' "$failed/testBuildFailure.log"
            touch "$out"
          '';
          # The same picker over the whole registry rather than one profile.
          registry = pkgs.testers.runNixOSTest (import ./test-picker.nix {
            name = "registry";
            menu = agent-distro.packages.${system}.default;
            profiles = agent-distro.profiles;
            inherit (import "${agent-distro}/profiles/registry.nix") default;
          });
          packages = import ./test-packages.nix {
            inherit pkgs;
            bindLaunchers = import "${agent-distro}/lib/mk-launchers.nix";
          };
        };
    };
}
