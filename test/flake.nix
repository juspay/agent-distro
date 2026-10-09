{
  description = "Launcher integration tests for the built-in profile, test profiles and profiles at launch";
  inputs = {
    agent-distro.url = "path:..";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "agent-distro/nixpkgs";
    nixpkgs.follows = "agent-distro/nixpkgs";
    # The Juspay profile's sources, for a test profile built from them and for
    # a fixture copy of its agent-distro.nix read at launch.
    juspay-skills = { url = "github:juspay/skills"; flake = false; };
    kolu = { url = "github:juspay/kolu"; flake = false; };
  };
  outputs = { nixpkgs, agent-distro, home-manager, juspay-skills, kolu, ... }:
    let
      inherit (nixpkgs) lib;
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (agent-distro.lib) mkLaunchers;
      # Kolu's plugin as kolu ships it: a directory inside a store path.
      koluPlugin = "${kolu}/agent-plugin";
      # The Juspay profile as it was built in before profiles were read at
      # launch: the gateway, plugin and Kolu checks run against it.
      juspayProfile = {
        name = "juspay";
        description = "Juspay skills + Kolu, via Juspay's LiteLLM gateway";
        plugins = [ juspay-skills koluPlugin ];
        packages = pkgs: [ pkgs.mcp-nixos ];
        gateway = {
          url = "https://grid.ai.juspay.net";
          keyEnv = "LITELLM_API_KEY";
          models = { large = "open-large"; small = "open-fast"; };
          keyHint = "Requires Juspay VPN to access the dashboard";
        };
      };
      # Profiles are tested through the public builder, the same way a
      # third-party distribution reaches them.
      suite = features: profile: import ./lib.nix {
        inherit pkgs profile mkLaunchers features koluPlugin;
        launchers = mkLaunchers { inherit pkgs profile; };
      };
      # No plugins of its own, so kolu arrives only through AGENT_DISTRO_PLUGINS.
      vanilla = suite [ "koluLaunch" ] agent-distro.profiles.vanilla;
      juspay = suite [ "plugins" "gateway" "kolu" ] juspayProfile;
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
          # AGENT_DISTRO_PLUGINS alone, without a VM: cache keys (a store
          # path as is, a checkout by content), re-translation after an edit,
          # name-based precedence, and the launches that must fail.
          launch-plugins = pkgs.runCommand "launch-plugins-check" { } ''
            ${runtime.node} ${./check-launch-plugins.ts} ${runtime.tree}/src \
              ${./fixtures/my-skills} ${./fixtures}/my-skills ${pkgs.nix}/bin/nix-hash
            touch "$out"
          '';
          # `--list --json` alone, without a VM: its type, the picker's menu
          # with the profile in effect, `--list`, versions stripped of `+`
          # suffixes, and the bundle's profile.json.
          list-json =
            let inherit (import "${agent-distro}/profiles/registry.nix") default;
            in
            pkgs.runCommand "list-json-check" { } ''
              ${runtime.node} ${./check-list-json.ts} ${runtime.tree}/src \
                ${lib.getExe agent-distro.packages.${system}.default} \
                ${default}=${agent-distro.packages.${system}.${default}}
              touch "$out"
            '';
          # Launchers name nixpkgs by a locked reference, fetched only for a
          # profile with packages (lib/nixpkgs-reference.nix): no bundle holds
          # its source.
          vanilla-closure = pkgs.runCommand "vanilla-closure-check"
            { closure = pkgs.closureInfo { rootPaths = [ agent-distro.packages.${system}.vanilla ]; }; } ''
            source=${lib.escapeShellArg (builtins.unsafeDiscardStringContext nixpkgs.outPath)}
            if grep -qxF "$source" "$closure/store-paths"; then
              echo "the vanilla bundle's closure holds the nixpkgs source $source" >&2
              exit 1
            fi
            # The reference instead.
            grep -q '"nixpkgs":"github:NixOS/nixpkgs/' ${agent-distro.packages.${system}.default.passthru.info}
            touch "$out"
          '';
          # The profile in effect without a VM: discovery, precedence,
          # references, the evaluation cache and the no-compile policy, with a
          # fake nix.
          profile-resolve = pkgs.runCommand "profile-resolve-check" { } ''
            export HOME="$TMPDIR"
            ${runtime.node} ${./check-profile.ts} ${runtime.tree}/src
            touch "$out"
          '';
          # Profiles read at launch, in a VM: paths and git+file: references,
          # discovery from a nested directory, precedence, the refusal of a
          # package the binary cache lacks, and a copy of the Juspay profile's
          # agent-distro.nix behaving as the built-in Juspay profile did.
          profiles = pkgs.testers.runNixOSTest (import ./test-profiles.nix {
            inherit pkgs agent-distro juspay-skills koluPlugin;
          });
          # The picker's widths, truncation and layout, without a terminal.
          picker-layout = pkgs.runCommand "picker-layout-check" { } ''
            ${runtime.node} ${./check-picker-layout.ts} ${runtime.tree}/src
            touch "$out"
          '';
          # The picker's auth probes, on fixture homes and stores.
          picker-auth = pkgs.runCommand "picker-auth-check" { } ''
            ${runtime.node} ${./check-picker-auth.ts} ${runtime.tree}/src
            touch "$out"
          '';
          # The bytes a `--progress` run reports, from the internal-json stderr
          # of a real `nix build` captured on a CI machine.
          update-progress = pkgs.runCommand "update-progress-check" { } ''
            ${runtime.node} ${./check-update-progress.ts} ${runtime.tree}/src ${./fixtures/internal-json.log}
            touch "$out"
          '';
          update-schedule = import ./test-update-schedule.nix {
            inherit pkgs nixpkgs agent-distro home-manager;
          };
          lib-exports = import ./test-lib-exports.nix {
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
