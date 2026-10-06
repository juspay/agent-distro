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
      suite = features: profile: import ./lib.nix {
        inherit pkgs profile mkLaunchers features;
        launchers = mkLaunchers { inherit pkgs profile; };
      };
      vanilla = suite [ ] agent-distro.profiles.vanilla;
      juspay = suite [ "plugins" "gateway" "kolu" ] agent-distro.profiles.juspay;
      # Test-only: the plugin shapes the Agent Plugins spec allows beyond what
      # the real profiles happen to use.
      fixtures = suite [ "plugins" "spec" ] {
        name = "fixtures";
        description = "Agent Plugins test fixtures";
        plugins = [ ./fixtures/spec-plugin ./fixtures/mcp-only ./fixtures/my-skills ];
        gateway = null;
      };
      runtime = import "${agent-distro}/lib/runtime.nix" pkgs;
      reserved = [ "default" ] ++ (import "${agent-distro}/lib/discover-harnesses.nix").ordered;
      named = profile: lib.mapAttrs' (check: lib.nameValuePair "${profile}-${check}");
    in
    {
      checks.${system} =
        named "vanilla" vanilla
        // named "juspay" juspay
        // named "fixtures" fixtures
        // lib.listToAttrs (lib.concatMap
          (harness:
            let directory = "${agent-distro}/harnesses/${harness}";
            in lib.optional (builtins.pathExists "${directory}/tests/check-adapter.ts") {
              name = "${harness}-adapter";
              value = pkgs.runCommand "${harness}-adapter-checks" { } ''
                ${runtime.node} ${directory}/tests/check-adapter.ts ${runtime.tree}/src ${directory}
                touch "$out"
              '';
            })
          (import "${agent-distro}/lib/discover-harnesses.nix").ordered)
        // {
          # The reader alone, without a VM: invalid manifests, skipped
          # components, and a failed build that names the field.
          reader = pkgs.runCommand "read-plugin-checks"
            {
              failed = pkgs.testers.testBuildFailure
                (runtime.readPlugin (pkgs.writeTextDir "plugin.json" ''{"name": "no-schema"}''));
            } ''
            ${runtime.node} ${./check-read-plugin.ts} ${runtime.tree}/src/plugin/read.ts
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
          discovery = import ./test-discovery.nix { inherit pkgs agent-distro nixpkgs; };
          reserved-profile = assert builtins.all
            (name:
              !(builtins.tryEval (agent-distro.lib.mkFlake {
                profile = agent-distro.profiles.vanilla // { inherit name; };
              })).success)
            reserved;
            pkgs.runCommand "reserved-profile" { nativeBuildInputs = [ pkgs.nix ]; } ''
              export NIX_STATE_DIR="$TMPDIR/nix-state"
              ${lib.concatMapStringsSep "\n" (name: ''
                if nix-instantiate --eval --expr ${lib.escapeShellArg ''
                  (import ${agent-distro}/lib/validate-profile.nix) { name = ${builtins.toJSON name}; }
                ''} 2>error; then
                  echo "Reserved profile was accepted: ${name}" >&2
                  exit 1
                fi
                grep -F ${lib.escapeShellArg ''Profile "${name}" uses a reserved name; reserved names: ${lib.concatStringsSep ", " reserved}.''} error
              '') reserved}
              touch "$out"
            '';
          packages = import ./test-packages.nix {
            inherit pkgs;
            inherit mkLaunchers;
          };
        };
    };
}
