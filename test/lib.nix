# Metadata selects the checks; shared code supplies only VM and fixture plumbing.
{ pkgs, launchers, profile, mkLaunchers ? import ../lib/mk-launchers.nix, features ? [ ] }:
let
  inherit (pkgs) lib;
  common = import ./common.nix;
  discovered = import ../lib/discover-harnesses.nix;
  expected = builtins.listToAttrs (map
    (plugin:
      let
        manifest = builtins.fromJSON (builtins.readFile "${plugin}/plugin.json");
        skills = "${plugin}/skills";
        entries = if builtins.pathExists skills then builtins.readDir skills else { };
      in
      {
        name = manifest.name;
        value = builtins.filter (name: builtins.pathExists "${skills}/${name}/SKILL.md") (builtins.attrNames entries);
      })
    profile.plugins);
  updated = common.updatedLaunchers mkLaunchers pkgs profile;
  upstream = mkLaunchers { inherit pkgs; profile = profile // { plugins = [ ]; gateway = null; }; };
  gatewayProfile = profile // { gateway = profile.gateway // { url = "http://127.0.0.1:8080"; }; };
  gatewayLaunchers = mkLaunchers { inherit pkgs; profile = gatewayProfile; };
  fixtures = harness: {
    updated = pkgs.writeShellScriptBin "${harness}-updated" ''
      exec ${lib.getExe updated.${harness}} "$@"
    '';
    upstream = pkgs.writeShellScriptBin "${harness}-upstream" ''
      exec ${lib.getExe upstream.${harness}} "$@"
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
      selected = if gateway then gatewayLaunchers else launchers;
      scripts = builtins.path {
        path = builtins.dirOf script;
        name = "${harness}-test-scripts";
        filter = path: type: type == "directory" || lib.hasSuffix ".py" path;
      };
      body = builtins.readFile script;
      driver = lib.hasPrefix "# nixos-test-driver" body;
      gatewayBody = lib.replaceStrings
        [ "@keyEnv@" "@models.large@" "@models.small@" ]
        [ profile.gateway.keyEnv profile.gateway.models.large profile.gateway.models.small ]
        body;
    in
    pkgs.testers.runNixOSTest {
      inherit name;
      nodes.machine = { ... }: {
        imports = [ common.baseNode ] ++ lib.optional gateway common.gatewayNode;
        virtualisation.diskSize = if diskSize == null then 1024 else diskSize;
        environment.systemPackages = [ selected.${harness} pkgs.python3 ] ++ map (key: (fixtures harness).${key}) packages;
        environment.variables = lib.optionalAttrs gateway { ${profile.gateway.keyEnv} = "test-api-key"; } // env;
      };
      testScript = ''
        import json
        import shlex
        ${common.testPreamble}
        ${lib.optionalString gateway ''
          machine.wait_for_unit("fake-gateway.service")
          machine.wait_for_open_port(8080)
        ''}
        ${if driver then gatewayBody else ''
          command = "python ${scripts}/${baseNameOf script} " + shlex.quote('${builtins.toJSON expected}') + " " + shlex.quote('${profile.name}-ai') + " " + shlex.quote('${if gateway then gatewayProfile.gateway.url else if (profile.gateway or null) == null then "" else profile.gateway.url}')
          machine.succeed("su - testuser -c " + shlex.quote(command))
        ''}
      '';
    };
  checks = lib.concatMap
    (harness: map (check: { name = check.name; value = mkCheck harness check; })
      (builtins.filter
        (check:
          assert builtins.all (feature: builtins.elem feature [ "plugins" "gateway" "kolu" "spec" ]) (check.requires or [ ]);
          builtins.all (feature: builtins.elem feature features) (check.requires or [ ]))
        discovered.metadata.${harness}.checks))
    discovered.ordered;
in
builtins.listToAttrs checks // {
  picker = pkgs.testers.runNixOSTest (import ./test-picker.nix {
    menu = launchers.picker;
    profiles = { ${profile.name} = profile; };
    default = profile.name;
  });
}
