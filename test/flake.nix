{
  description = "Launcher integration tests for the one package, and for profiles read at launch";
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
      # Kolu's plugin as kolu ships it: a directory inside a store path.
      koluPlugin = "${kolu}/agent-plugin";
      # A team's profile as a repository would carry one: its skills, and the
      # LiteLLM gateway it points OMP and OpenCode at, written with `env` and
      # `settings`. test/support/gateway-fixture.py serves that gateway.
      gatewayProfile = {
        name = "gateway";
        description = "A team's skills, with the LiteLLM gateway it runs them on";
        plugins = [ juspay-skills koluPlugin ];
        packages = pkgs: [ pkgs.mcp-nixos ];
        env = {
          LITELLM_BASE_URL = "http://127.0.0.1:8080";
          LITELLM_API_KEY = { secret = true; hint = "Create a key at the team's dashboard"; };
        };
        settings = {
          omp.modelRoles = {
            default = "litellm/open-large";
            slow = "litellm/open-large";
            task = "litellm/open-large";
            smol = "litellm/open-fast";
          };
          opencode = {
            providers.litellm = {
              package = "@opencode/ai/providers/openai-compatible";
              settings.baseURL = "http://127.0.0.1:8080/v1";
            };
            model = "litellm/open-large";
            agents.title.model = "litellm/open-fast";
          };
        };
      };
      # The same profile with its plugins rebuilt to new store paths: what a
      # launch sees when a profile's own content changed.
      rebuilt = profile: profile // {
        plugins = map
          (plugin: pkgs.runCommand "updated-plugin" { } ''
            cp -r ${plugin} "$out"
            chmod u+w "$out"
            touch "$out/rebuild-marker"
          '')
          profile.plugins;
      };
      # Profiles are tested through the public builder and read from the store,
      # the way a caller pinning one reaches them.
      built = list: map (profile: agent-distro.lib.mkProfile { inherit system profile; }) list;
      suite = features: profiles: import ./lib.nix {
        inherit pkgs nixpkgs features koluPlugin;
        profiles = built profiles;
        updated = built (map rebuilt profiles);
      };
      # No profile at all, so kolu arrives only through AGENT_DISTRO_PLUGINS.
      plain = suite [ "koluLaunch" ] [ ];
      gateway = suite [ "plugins" "gateway" "kolu" ] [ gatewayProfile ];
      # Test-only: the plugin shapes the Agent Plugins spec allows beyond what
      # the real profiles happen to use.
      fixtures = suite [ "plugins" "spec" ] [ {
        name = "fixtures";
        description = "Agent Plugins test fixtures";
        plugins = [ ./fixtures/spec-plugin ./fixtures/mcp-only ./fixtures/my-skills ];
      } ];
      runtime = import "${agent-distro}/lib/runtime.nix" pkgs;
      named = profile: lib.mapAttrs' (check: lib.nameValuePair "${profile}-${check}");
    in
    {
      checks.${system} =
        named "plain" plain
        // named "gateway" gateway
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
          # name-based precedence, the shell a launcher evaluates (its `env`
          # and the prompt for a secret), and the launches that must fail.
          launch-plugins = pkgs.runCommand "launch-plugins-check" { } ''
            ${runtime.node} ${./check-launch-plugins.ts} ${runtime.tree}/src \
              ${./fixtures/my-skills} ${./fixtures}/my-skills ${pkgs.nix}/bin/nix-hash ${../lib/prompt-secrets.nix}
            touch "$out"
          '';
          # The OpenCode launcher's own arguments, without a VM or the harness:
          # an interactive launch has to reach `--standalone`, since the shared
          # server would otherwise serve one launch's config to the next.
          # Built against a package that only prints what it was handed.
          opencode-standalone =
            let
              # The adapter takes its version from the package, as it does for
              # the real one; every harness is built against this stub's argv
              # printer, and only OpenCode's launcher is realized.
              argv = pkgs.writeShellScriptBin "opencode" ''printf '%s\n' "$*"'' // { version = "0"; };
              launcher = (agent-distro.lib.mkLaunchers {
                inherit pkgs;
                sources = _: _: argv;
              }).opencode;
            in
            pkgs.runCommand "opencode-standalone-check" { nativeBuildInputs = [ pkgs.bash ]; } ''
              export HOME="$TMPDIR/home"
              mkdir -p "$HOME" "$TMPDIR/project"
              opencode=${lib.getExe launcher}
              same() {
                expected=$1
                shift
                actual=$("$opencode" "$@")
                if [ "$actual" != "$expected" ]; then
                  echo "opencode $*: expected $(printf '%q' "$expected"), got $(printf '%q' "$actual")" >&2
                  exit 1
                fi
              }
              # An argument-free launch is a terminal session: the session
              # defaults have to reach the launcher for this to hold. Their
              # decisions themselves are in tests/check-adapter.ts.
              same '--standalone'
              same "--standalone $TMPDIR/project" "$TMPDIR/project"
              touch "$out"
            '';
          # The OMP launcher's setup-wizard rule, without a VM or OMP: a
          # non-empty `settings.omp` exports `OMP_SKIP_SETUP`, a profile that
          # says nothing leaves it unset, and the user's own value survives.
          # Built against a package that only prints the variable it was handed.
          omp-skip-setup =
            let
              argv = pkgs.writeShellScriptBin "omp" ''
                printf '%s' "''${OMP_SKIP_SETUP-unset}"
              '' // { version = "0"; };
              launcher = (agent-distro.lib.mkLaunchers {
                inherit pkgs;
                sources = _: _: argv;
              }).omp;
            in
            pkgs.runCommand "omp-skip-setup-check" { nativeBuildInputs = [ pkgs.bash ]; } ''
              export HOME="$TMPDIR/home" XDG_CACHE_HOME="$TMPDIR/cache"
              mkdir -p "$HOME" "$XDG_CACHE_HOME"
              omp=${lib.getExe launcher}
              # A profile handed over as the picker hands one, with the settings
              # section its `agent-distro.nix` carries (src/plugin/launch.ts).
              resolved() { printf '{"name":"%s","description":"d","source":"variable","origin":"/%s","plugins":[],"env":{},"settings":%s,"paths":[]}' "$1" "$1" "$2"; }
              configured=$(resolved configured '{"omp":{"modelRoles":{"default":"litellm/large"}}}')
              silent=$(resolved silent '{}')
              empty=$(resolved empty '{"omp":{}}')
              same() {
                expected=$1
                shift
                actual=$("$@")
                if [ "$actual" != "$expected" ]; then
                  echo "OMP_SKIP_SETUP: expected '$expected', got '$actual'" >&2
                  exit 1
                fi
              }
              same 1 env AGENT_DISTRO_PROFILE="$configured" "$omp"
              same unset env AGENT_DISTRO_PROFILE="$silent" "$omp"
              # An empty `settings.omp` configured nothing: no wizard skip.
              same unset env AGENT_DISTRO_PROFILE="$empty" "$omp"
              same keep env AGENT_DISTRO_PROFILE="$configured" OMP_SKIP_SETUP=keep "$omp"
              touch "$out"
            '';
          # `--list --json` alone, without a VM: its type, the picker's menu
          # with the profile in effect, `--list`, and versions stripped of `+`
          # suffixes.
          list-json = pkgs.runCommand "list-json-check" { } ''
            ${runtime.node} ${./check-list-json.ts} ${runtime.tree}/src \
              ${lib.getExe agent-distro.packages.${system}.default} \
              ${agent-distro.packages.${system}.default}
            touch "$out"
          '';
          # Launchers name nixpkgs by a locked reference, fetched only for a
          # profile with packages (lib/nixpkgs-reference.nix): the package does
          # not hold its source.
          nixpkgs-reference = pkgs.runCommand "nixpkgs-reference-check"
            { closure = pkgs.closureInfo { rootPaths = [ agent-distro.packages.${system}.default ]; }; } ''
            source=${lib.escapeShellArg (builtins.unsafeDiscardStringContext nixpkgs.outPath)}
            if grep -qxF "$source" "$closure/store-paths"; then
              echo "the package's closure holds the nixpkgs source $source" >&2
              exit 1
            fi
            # The reference instead.
            grep -q '"nixpkgs":"github:NixOS/nixpkgs/' ${agent-distro.packages.${system}.default.passthru.infoFile}
            touch "$out"
          '';
          # The profile in effect without a VM: discovery, the stack and how
          # it composes, references, the evaluation cache and the no-compile policy, with a
          # fake nix.
          profile-resolve = pkgs.runCommand "profile-resolve-check" { } ''
            export HOME="$TMPDIR"
            ${runtime.node} ${./check-profile.ts} ${runtime.tree}/src ${agent-distro}/doc/agent-distro.schema.json
            touch "$out"
          '';
          # `check-profile` without a VM: one line per package, every package
          # reported, and the exit status, with a fake nix.
          check-check-profile = pkgs.runCommand "check-check-profile-check" { } ''
            export HOME="$TMPDIR"
            ${runtime.node} ${./check-check-profile.ts} ${runtime.tree}/src
            touch "$out"
          '';
          # Profiles read at launch, in a VM: paths and git+file: references,
          # discovery from a nested directory, precedence, the refusal of a
          # package the binary cache lacks, and a fixture copy of the Juspay
          # profile's `agent-distro.nix` read at launch, the way a profile
          # repository carries one.
          profiles = pkgs.testers.runNixOSTest (import ./test-profiles.nix {
            inherit pkgs agent-distro nixpkgs juspay-skills koluPlugin;
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
          # src/log.ts alone: the line format, levels, the journal prefix,
          # escaping, tags and `slow`.
          log = pkgs.runCommand "log-check" { } ''
            ${runtime.node} ${./check-log.ts} ${runtime.tree}/src
            touch "$out"
          '';
          # Stdout stays a protocol channel at AGENT_DISTRO_LOG=trace: the
          # launch's shell, `--list --json`, model discovery's path and
          # `--progress` JSON still parse.
          log-stdout = pkgs.runCommand "log-stdout-check" { } ''
            ${runtime.node} ${./check-log-stdout.ts} ${runtime.tree}/src ${./fixtures/my-skills}
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
          # The update that takes the published content-addressed package
          # instead of skipping, in a VM as an untrusted user.
          ca-update = pkgs.testers.runNixOSTest (import ./test-ca-update.nix {
            inherit pkgs agent-distro;
          });
          discovery = import ./test-discovery.nix { inherit pkgs agent-distro nixpkgs; };
          packages = import ./test-packages.nix {
            inherit pkgs;
            mkLaunchers = agent-distro.lib.mkLaunchers;
          };
          # `mkProfile`'s output, without a VM or a launch.
          mk-profile = import ./test-mk-profile.nix {
            inherit pkgs agent-distro;
            mkProfile = agent-distro.lib.mkProfile;
          };
        };
    };
}
