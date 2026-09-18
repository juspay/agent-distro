# Each attribute is independent. Select only tests applicable to your profile.
{ pkgs, launchers, profile, mkLaunchers ? null }:
let
  common = import ./common.nix;
  expected = builtins.listToAttrs (map
    (plugin:
      let
        manifest = builtins.fromJSON (builtins.readFile "${plugin}/plugin.json");
        entries = builtins.readDir "${plugin}/skills";
      in
      {
        name = manifest.name;
        value = builtins.filter (name: entries.${name} == "directory") (builtins.attrNames entries);
      })
    profile.plugins);
  updated = common.updatedLaunchers
    (if mkLaunchers != null then mkLaunchers else throw "Plugin rebuild tests require mkLaunchers")
    pkgs
    profile;
  # Copy the scripts together so Python support-module imports work in the VM.
  scripts = builtins.path {
    path = ./.;
    name = "agent-distro-test-scripts";
    filter = path: type: type == "directory" || pkgs.lib.hasSuffix ".py" path;
  };
  mkCheck = name: script: extraPackages: environment: pkgs.testers.runNixOSTest {
    inherit name;
    nodes.machine = { ... }: {
      imports = [ common.baseNode ];
      environment.systemPackages = [ launchers.omp launchers.codex launchers.claude pkgs.python3 ] ++ extraPackages;
      environment.variables = environment;
    };
    testScript = ''
      import shlex
      ${common.testPreamble}
      command = "python ${scripts}/${script} " + shlex.quote('${builtins.toJSON expected}') + " " + shlex.quote('${profile.name}-ai') + " " + shlex.quote('${if (profile.gateway or null) == null then "" else profile.gateway.url}')
      machine.succeed("su - testuser -c " + shlex.quote(command))
    '';
  };
  updatedBin = harness: pkgs.writeShellScriptBin "${harness}-updated" ''
    exec ${pkgs.lib.getExe updated.${harness}} "$@"
  '';
  # A plugin-free launcher is the same upstream Codex, without registration.
  upstreamCodex = (if mkLaunchers != null then mkLaunchers else throw "Codex rebuild tests require mkLaunchers") {
    inherit pkgs;
    profile = profile // { plugins = [ ]; gateway = null; };
  };
  codexUpstream = pkgs.writeShellScriptBin "codex-upstream" ''
    exec ${pkgs.lib.getExe upstreamCodex.codex} "$@"
  '';
  koluFixture = pkgs.writeShellScriptBin "kolu" ''
    exec ${pkgs.python3}/bin/python ${./kolu-mcp-fixture.py} "$@"
  '';
  gatewayEnvironment = { ${profile.gateway.keyEnv} = "test-api-key"; };
in
{
  omp = mkCheck "omp" (if (profile.gateway or null) == null then "check-no-gateway.py" else "check-omp.py") [ ] { AI_GATEWAY = "0"; };
  codex = mkCheck "codex" "check-codex.py" [ ] { };
  claude = mkCheck "claude" "check-claude.py" [ ] { };
  picker = pkgs.testers.runNixOSTest (import ./test-picker.nix { inherit launchers profile; });

  gateway = pkgs.testers.runNixOSTest (import ./test-gateway.nix { inherit launchers profile; });
  gatewayEnv = mkCheck "gateway-env" "check-gateway-env.py" [ ] gatewayEnvironment;

  # Nonempty plugin profiles only: same home, different plugin store paths (#181).
  ompPlugins = mkCheck "omp-plugins" "check-omp-plugins.py" [ (updatedBin "omp") ] { };
  codexPlugins = mkCheck "codex-plugins" "check-codex-plugins.py" [ (updatedBin "codex") codexUpstream ] { };
  claudePlugins = mkCheck "claude-plugins" "check-claude-plugins.py" [ (updatedBin "claude") ] { };

  # Profiles containing Kolu's plugin only; the server is an offline fixture.
  ompKolu = mkCheck "omp-kolu" "check-omp-kolu.py" [ koluFixture ] { AI_GATEWAY = "0"; };
  codexKolu = mkCheck "codex-kolu" "check-codex-kolu.py" [ koluFixture ] { };
  claudeKolu = mkCheck "claude-kolu" "check-claude-kolu.py" [ koluFixture ] { };
}
