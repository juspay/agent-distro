# Profiles read at launch (src/profile/resolve.ts), in a VM without network:
# every reference is local.
#
# Stub harnesses that print what they were started with show the plugins and
# packages each launch got: path and git+file: references, discovery from a
# nested directory, the precedence of the positional selector, the
# repository's agent-distro.nix, AI_PROFILE and the built-in profile, an
# evaluation that sees neither the user's environment nor the network, and
# the refusal of a package the binary cache lacks. Then a copy of the Juspay
# profile's agent-distro.nix, its github: plugin reference replaced by a local
# path, runs the real OMP, Codex and Claude Code as the built-in Juspay
# profile did.
{ pkgs, agent-distro, nixpkgs, juspay-skills, koluPlugin }:
let
  inherit (pkgs) lib;
  common = import ./common.nix;
  vanilla = agent-distro.profiles.vanilla;
  # Each stub prints its arguments, one per line, then where it finds the
  # commands a profile's packages provide.
  stub = name: pkgs: pkgs.writeShellScriptBin name ''
    echo STUB-STARTED
    printf '%s\n' "$@"
    echo "hello=$(command -v hello || true)"
  '' // { version = "0"; };
  probe = agent-distro.lib.mkLaunchers { inherit pkgs; profile = vanilla; sources = stub; };
  # Under their own names, so the real harnesses keep theirs.
  probes = map
    (name: pkgs.writeShellScriptBin "probe-${name}" ''
      exec ${lib.getExe probe.${name}} "$@"
    '')
    [ "claude" "omp" ]
  ++ [
    (pkgs.writeShellScriptBin "probe-agent-distro" ''
      exec ${lib.getExe probe.picker} "$@"
    '')
  ];
  plugin = name: pkgs.runCommand "plugin-${name}" { } ''
    mkdir -p "$out/skills/${name}-skill"
    printf '%s' ${lib.escapeShellArg (builtins.toJSON {
      "$schema" = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
      inherit name;
    })} > "$out/plugin.json"
    printf -- '---\nname: ${name}-skill\ndescription: ${name}\n---\n' > "$out/skills/${name}-skill/SKILL.md"
  '';
  plugins = lib.genAttrs [ "alpha" "beta" "gamma" "delta" ] plugin;
  # The Juspay profile's agent-distro.nix, as its repository carries it.
  juspayProfile = ''
    {
      name = "juspay";
      description = "Juspay skills + Kolu, via Juspay's LiteLLM gateway";
      plugins = [ ./. "github:juspay/kolu?dir=agent-plugin" ];
      packages = pkgs: [ pkgs.mcp-nixos ];
      gateway = {
        url = "https://grid.ai.juspay.net";
        keyEnv = "LITELLM_API_KEY";
        models = { large = "open-large"; small = "open-fast"; };
        keyHint = "Requires Juspay VPN to access the dashboard";
      };
    }
  '';
  # Skills per plugin, as the built-in Juspay profile's checks expected them.
  expected = builtins.listToAttrs (map
    (root:
      let
        manifest = builtins.fromJSON (builtins.readFile "${root}/plugin.json");
        entries = builtins.readDir "${root}/skills";
      in
      {
        name = manifest.name;
        value = builtins.filter (name: builtins.pathExists "${root}/skills/${name}/SKILL.md") (builtins.attrNames entries);
      })
    [ juspay-skills koluPlugin ]);
  koluFixture = pkgs.writeShellScriptBin "kolu" ''
    exec ${pkgs.python3}/bin/python ${./support/kolu-mcp-fixture.py} "$@"
  '';
  # A package no binary cache has: fetching it would mean compiling it.
  uncached = ''(pkgs.hello.overrideAttrs { pname = "agent-distro-uncached"; })'';
in
{
  name = "profiles";
  nodes.machine = { ... }: {
    imports = [ common.baseNode ];
    virtualisation.memorySize = 4096;
    virtualisation.diskSize = 4096;
    environment.systemPackages = [ agent-distro.packages.${pkgs.stdenv.hostPlatform.system}.vanilla pkgs.python3 pkgs.git koluFixture ] ++ probes;
    # What the profiles' packages evaluate to is already here, as a binary
    # cache would provide it; nothing else is, and nothing can be fetched.
    # The nixpkgs source too, at the store path launchers find it by (the
    # input's outPath: `pkgs.path`, a path value, would be copied to another).
    system.extraDependencies = [ pkgs.hello pkgs.mcp-nixos nixpkgs.outPath ] ++ lib.attrValues plugins;
    nix.settings.substituters = lib.mkForce [ ];
  };
  testScript = ''
    import json
    import shlex
    ${common.testPreamble}

    def user(command):
        return machine.succeed("su - testuser -c " + shlex.quote(command))

    def refused(command):
        status, output = machine.execute("su - testuser -c " + shlex.quote(command + " 2>&1"))
        assert status != 0, output
        return output

    def write(path, text):
        user(f"mkdir -p $(dirname {path}) && printf %s {shlex.quote(text)} > {path}")

    def launched(command):
        """The plugins a stub harness was started with, by manifest name, and where it found hello."""
        lines = user(command).splitlines()
        assert lines[0] == "STUB-STARTED", lines
        dirs = [lines[i + 1] for i, line in enumerate(lines) if line == "--plugin-dir"]
        names = [json.loads(machine.succeed(f"cat {d}/.claude-plugin/plugin.json"))["name"] for d in dirs]
        return names, lines[-1].removeprefix("hello=")

    def in_effect(cwd="~", env=""):
        return json.loads(user(f"cd {cwd} && {env} probe-agent-distro --list --json"))["profile"]

    # A repository whose profile names a plugin beside it, for discovery.
    user("mkdir -p ~/repo/.git ~/repo/nested/deep && cp -r ${plugins.alpha} ~/repo/plugin && chmod -R u+w ~/repo/plugin")
    write("~/repo/agent-distro.nix", '{ name = "repo"; description = "The repository"; plugins = [ ./plugin ]; gateway = null; }')
    # A profile directory, for AI_PROFILE and the positional selector.
    write("~/elsewhere/agent-distro.nix", '{ name = "elsewhere"; plugins = [ ${plugins.beta} ]; }')
    # A git repository fetched by git+file:, itself a plugin, naming another
    # plugin by git+file: reference.
    user("mkdir -p ~/plugins && cp -r ${plugins.delta} ~/plugins/delta && chmod -R u+w ~/plugins")
    user("cd ~/plugins && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm plugins")
    user("cp -r ${plugins.gamma} ~/fetched && chmod -R u+w ~/fetched")
    write("~/fetched/agent-distro.nix", '{ name = "fetched"; plugins = [ ./. "git+file:///home/testuser/plugins?dir=delta" ]; }')
    user("cd ~/fetched && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm profile")

    with subtest("a path profile, positional or in AI_PROFILE"):
        assert launched("probe-agent-distro /home/testuser/elsewhere claude") == (["beta"], "")
        assert launched("cd ~ && probe-agent-distro ./elsewhere claude") == (["beta"], "")
        assert launched("AI_PROFILE=/home/testuser/elsewhere/agent-distro.nix probe-claude") == (["beta"], "")

    with subtest("a git+file: reference, and a plugin by reference"):
        assert launched("probe-agent-distro git+file:///home/testuser/fetched claude") == (["gamma", "delta"], "")
        assert in_effect(env="AI_PROFILE=git+file:///home/testuser/fetched") == {
            "name": "fetched", "description": "", "source": "variable", "origin": "git+file:///home/testuser/fetched"}

    with subtest("discovery from a nested directory, up to the git root"):
        assert launched("cd ~/repo/nested/deep && probe-claude") == (["alpha"], "")
        assert in_effect("~/repo/nested/deep") == {
            "name": "repo", "description": "The repository", "source": "repository",
            "origin": "/home/testuser/repo/agent-distro.nix"}
        # --list names it, and where it was found.
        assert "repo · The repository · from /home/testuser/repo/agent-distro.nix" in user("cd ~/repo && probe-agent-distro --list")
        # Outside the repository, the built-in profile.
        assert launched("probe-claude") == ([], "")
        assert in_effect() == {"name": "vanilla", "description": "${vanilla.description}", "source": "builtin", "origin": "vanilla"}

    with subtest("precedence: positional, repository, AI_PROFILE, built-in"):
        other = "AI_PROFILE=/home/testuser/elsewhere"
        assert launched(f"cd ~/repo && {other} probe-agent-distro /home/testuser/fetched claude")[0] == ["gamma", "delta"]
        assert launched(f"cd ~/repo && {other} probe-agent-distro vanilla claude")[0] == []
        assert launched(f"cd ~/repo && {other} probe-claude")[0] == ["alpha"]
        assert in_effect("~/repo", other)["source"] == "repository"
        assert launched(f"{other} probe-claude")[0] == ["beta"]
        assert in_effect("~", other)["source"] == "variable"
        assert launched("probe-claude")[0] == []
        # AGENT_DISTRO_PLUGINS composes on top of whichever profile is in effect.
        assert launched("cd ~/repo && AGENT_DISTRO_PLUGINS=${plugins.beta} probe-claude")[0] == ["alpha", "beta"]
        # The positional selector is the picker's own: it never reaches the harness.
        assert "/home/testuser/fetched" not in user("probe-agent-distro /home/testuser/fetched claude")

    with subtest("a profile is evaluated without the user's environment or the network"):
        write("~/nosy/agent-distro.nix", '{ name = "nosy"; description = "[" + builtins.getEnv "SECRET" + "]"; }')
        assert in_effect("~", "SECRET=hunter2 AI_PROFILE=/home/testuser/nosy")["description"] == "[]"
        write("~/fetching/agent-distro.nix", '{ name = "fetching"; description = builtins.readFile (builtins.fetchurl "https://example.com/"); }')
        output = refused("AI_PROFILE=/home/testuser/fetching probe-claude")
        assert "access to URI 'https://example.com/' is forbidden in restricted mode" in output, output
        assert "STUB-STARTED" not in output, output

    with subtest("packages from the binary cache, and the refusal of one it lacks"):
        write("~/packaged/agent-distro.nix", '{ name = "packaged"; packages = pkgs: [ pkgs.hello ]; }')
        assert launched("AI_PROFILE=/home/testuser/packaged probe-claude") == ([], "${pkgs.hello}/bin/hello")
        write("~/uncached/agent-distro.nix", '{ name = "uncached"; packages = pkgs: [ ${uncached} ]; }')
        for command in ["AI_PROFILE=/home/testuser/uncached probe-claude", "probe-agent-distro /home/testuser/uncached claude",
                        "AI_PROFILE=/home/testuser/uncached probe-omp"]:
            output = refused(command)
            assert "package agent-distro-uncached-${pkgs.hello.version} is not in the binary cache" in output, output
            assert "agent-distro never compiles" in output, output
            assert "STUB-STARTED" not in output, output

    with subtest("the Juspay profile's agent-distro.nix behaves as the built-in Juspay profile did"):
        user("cp -r ${juspay-skills} ~/juspay && chmod -R u+w ~/juspay")
        write("~/juspay/agent-distro.nix", ${builtins.toJSON (builtins.replaceStrings
          [ ''"github:juspay/kolu?dir=agent-plugin"'' ] [ ''"${koluPlugin}"'' ] juspayProfile)})
        juspay = "AI_PROFILE=/home/testuser/juspay"
        assert in_effect("~", juspay)["name"] == "juspay"
        user(f"{juspay} python " + shlex.quote("${./profiles/check-juspay.py}") + " " + " ".join(shlex.quote(a) for a in [
            ${builtins.toJSON (builtins.toJSON expected)}, "juspay-ai",
            "${../harnesses/omp/tests}", "${../harnesses/codex/tests}", "${../harnesses/claude/tests}",
            "${pkgs.mcp-nixos}/bin"]))
  '';
}
