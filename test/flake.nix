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
          # The same picker over the whole registry rather than one profile.
          registry = pkgs.testers.runNixOSTest (import ./test-picker.nix {
            name = "registry";
            menu = agent-distro.packages.${system}.default;
            profiles = agent-distro.profiles;
            inherit (import "${agent-distro}/profiles/registry.nix") default;
          });
          # Every profile shares one CODEX_HOME: none may inherit another's plugins.
          registry-codex-isolation = pkgs.testers.runNixOSTest {
            name = "registry-codex-isolation";
            nodes.machine = { ... }: {
              imports = [ (import ./common.nix).baseNode ];
              environment.systemPackages = [ agent-distro.packages.${system}.default pkgs.python3 ];
            };
            testScript =
              let
                profiles = lib.mapAttrs (_: profile: (profile.plugins or [ ]) != [ ]) agent-distro.profiles;
              in
              ''
                import shlex
                ${(import ./common.nix).testPreamble}
                command = "python ${./check-codex-profiles.py} " + shlex.quote('${builtins.toJSON profiles}')
                machine.succeed("su - testuser -c " + shlex.quote(command))
              '';
          };
        };
    };
}
