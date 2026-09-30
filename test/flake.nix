{
  description = "Launcher integration tests for every profile in the registry";
  inputs = {
    agent-distro.url = "path:..";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "agent-distro/nixpkgs";
    nixpkgs.follows = "agent-distro/nixpkgs";
  };
  outputs = { nixpkgs, agent-distro, home-manager, ... }:
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
        named "vanilla" { inherit (vanilla) omp codex codexCli codexTerminal claude opencode picker; }
        # Plugins, a gateway, and Kolu's MCP server: every check applies.
        // named "juspay" {
          inherit (juspay) omp codex codexTerminal claude opencode picker gateway gatewayEnv
            ompPlugins codexPlugins codexStaleMarketplace claudePlugins opencodePlugins ompKolu codexKolu claudeKolu opencodeKolu;
        }
        # MCP-only, skills-only, and every MCP shape the translation handles.
        # No `omp`: OMP 18.4.1 loads no skills from these plugins as `-e` roots
        # (the real profiles' plugins also carry harness-specific manifests).
        // named "fixtures" { inherit (fixtures) codex claude opencode opencodePlugins claudeSpec; }
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
          update-schedule = import ./test-update-schedule.nix {
            inherit pkgs nixpkgs agent-distro home-manager;
          };
          auto-update = pkgs.testers.runNixOSTest (import ./test-auto-update.nix {
            inherit pkgs agent-distro home-manager;
          });
          reserved-profile = assert builtins.all (name:
            !(builtins.tryEval (agent-distro.lib.mkFlake {
              profile = agent-distro.profiles.vanilla // { inherit name; };
            })).success) [ "default" "omp" "codex" "claude" "opencode" ]; pkgs.runCommand "reserved-profile" { nativeBuildInputs = [ pkgs.nix ]; } ''
            export NIX_STATE_DIR="$TMPDIR/nix-state"
            if nix-instantiate --eval --expr '(import ${agent-distro}/lib/validate-profile.nix) { name = "opencode"; }' 2>error; then
              exit 1
            fi
            grep -F 'Profile "opencode" uses a reserved name; reserved names: default, omp, codex, claude, opencode.' error
            touch "$out"
          '';
          packages = import ./test-packages.nix {
            inherit pkgs;
            bindLaunchers = import "${agent-distro}/lib/mk-launchers.nix";
          };
        };
    };
}
