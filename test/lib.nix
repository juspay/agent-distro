# Metadata selects the checks; shared code supplies only VM and fixture plumbing.
#
# The checks launch the one package, and a profile reaches them the way it
# reaches a user: `AI_PROFILE`, holding the store paths of the `mkProfile`
# outputs the caller passes. What the checks expect of those profiles — their
# `env`, their `settings`, and each plugin's skills — is read back from those
# builds (`share/agent-distro/profile.json` and its plugins' descriptions), so
# an expectation and the launch cannot drift.
#
# `updated` is the same profiles with their plugins rebuilt to new store paths:
# the `changed` fixture launches with those, for the checks that a plugin whose
# content changed is installed again. `koluPlugin` is kolu's Agent Plugin
# directory, for the `koluLaunch` checks: they load it through
# AGENT_DISTRO_PLUGINS rather than from the profile.
{ pkgs, profiles ? [ ], updated ? null, features ? [ ], koluPlugin ? null }:
let
  inherit (pkgs) lib;
  common = import ./common.nix;
  discovery = import ../lib/discover-harnesses.nix;
  launchers = import ../lib/mk-launchers.nix { inherit pkgs; };
  # What one built profile says: its `env` and `settings`, and its plugins, each
  # with the skills the reader found in it.
  described = profile:
    let
      json = builtins.fromJSON (builtins.readFile "${profile}/share/agent-distro/profile.json");
      indexes = builtins.attrNames (builtins.readDir "${profile}/share/agent-distro/plugins");
      plugins = map
        (index: builtins.fromJSON
          (builtins.readFile "${profile}/share/agent-distro/plugins/${index}/description.json"))
        indexes;
    in
    {
      inherit (json) env settings;
      expected = builtins.listToAttrs (map
        (plugin: { name = plugin.manifest.name; value = builtins.attrNames plugin.skills; })
        plugins);
    };
  # The stack, composed left to right as a launch composes it: plugins both, in
  # order, and `env`/`settings` key-wise with the later profile winning.
  each = map described profiles;
  expected = builtins.foldl' (all: one: all // one.expected) { } each;
  env = builtins.foldl' (all: one: all // one.env) { } each;
  settings = builtins.foldl' (all: one: all // one.settings) { } each;
  aiProfile = lib.concatStringsSep ":" (map toString profiles);
  # The prefix every one-launch Codex marketplace is named with
  # (src/harness/codex.ts); a check that needs the marketplaces derives the rest.
  marketplace = "agent-distro-";
  # The `secret` variables of the profiles' `env`: a check that needs the
  # harness to start sets them, as a user who has a key would.
  secrets = lib.mapAttrs (_: _: "test-api-key")
    (lib.filterAttrs (_: value: lib.isAttrs value && (value.secret or false)) env);
  fixtures = harness: {
    changed = pkgs.writeShellScriptBin "${harness}-changed" ''
      AI_PROFILE=${lib.escapeShellArg (lib.concatStringsSep ":" (map toString (if updated == null then profiles else updated)))} \
        exec ${lib.getExe launchers.${harness}} "$@"
    '';
    upstream = pkgs.writeShellScriptBin "${harness}-upstream" ''
      AI_PROFILE= exec ${lib.getExe launchers.${harness}} "$@"
    '';
    koluFixture = pkgs.writeShellScriptBin "kolu" ''
      exec ${pkgs.python3}/bin/python ${./support/kolu-mcp-fixture.py} "$@"
    '';
    recordFixture = pkgs.writeShellScriptBin "fixture-record" ''
      exec ${pkgs.python3}/bin/python ${./fixtures/spec-plugin/bin/record} "$@"
    '';
  };
  mkCheck = harness: { name, script, requires ? [ ], packages ? [ ], env ? { }, diskSize ? null }:
    let
      gateway = builtins.elem "gateway" requires;
    in
    pkgs.testers.runNixOSTest {
      inherit name;
      nodes.machine = { ... }: {
        imports = [ common.baseNode ] ++ lib.optional gateway common.gatewayNode;
        virtualisation.diskSize = if diskSize == null then 1024 else diskSize;
        environment.systemPackages = [ launchers.${harness} pkgs.python3 ] ++ map (key: (fixtures harness).${key}) packages;
        # The profiles these checks launch with, and the plugins a check may put
        # on AGENT_DISTRO_PLUGINS; that variable is never set globally.
        environment.variables = lib.optionalAttrs (aiProfile != "") { AI_PROFILE = aiProfile; }
          // lib.optionalAttrs gateway secrets
          // { AGENT_DISTRO_TEST_PLUGIN = "${./fixtures/launch-plugin}"; }
          // { AGENT_DISTRO_TEST_SPEC = "${./fixtures/spec-plugin}"; }
          // lib.optionalAttrs (builtins.elem "koluLaunch" requires) {
            AGENT_DISTRO_TEST_KOLU = if koluPlugin == null then throw "koluLaunch checks need koluPlugin" else "${koluPlugin}";
          }
          // env;
      };
      testScript = ''
        import json
        import shlex
        ${common.testPreamble}
        ${lib.optionalString gateway ''
          machine.wait_for_unit("fake-gateway.service")
          machine.wait_for_open_port(8080)
        ''}
        # What the profiles in effect declare. A check the driver runs itself
        # (`builtins.readFile` in meta.nix) reads these as globals; a guest
        # script, which runs inside the VM with its support module beside it
        # (test/guest-script.nix), reads the `env` from its argv instead, after
        # the expected skills and the Codex marketplace prefix.
        profile_env = json.loads(${builtins.toJSON (builtins.toJSON env)})
        profile_settings = json.loads(${builtins.toJSON (builtins.toJSON settings)})
        arguments = ${builtins.toJSON (lib.escapeShellArgs [
          (builtins.toJSON expected) marketplace (builtins.toJSON env)
        ])}
        ${script}
      '';
    };
  checks = lib.concatMap
    (harness: map (check: { name = check.name; value = mkCheck harness check; })
      (builtins.filter
        (check:
          assert builtins.all (feature: builtins.elem feature [ "plugins" "gateway" "kolu" "spec" "koluLaunch" ]) (check.requires or [ ]);
          builtins.all (feature: builtins.elem feature features) (check.requires or [ ]))
        discovery.metadata.${harness}.checks))
    discovery.ordered;
in
builtins.listToAttrs checks // {
  picker = pkgs.testers.runNixOSTest (import ./test-picker.nix {
    menu = launchers.picker;
  });
}
