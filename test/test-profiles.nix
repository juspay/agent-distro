# Profiles read at launch (src/profile/resolve.ts), in a VM without network:
# every reference is local.
#
# Stub harnesses that print what they were started with show the plugins and
# packages each launch got: path and git+file: references, discovery from a
# nested directory, the positional selector taken exactly, the repository's
# agent-distro.nix composed over AI_PROFILE over the built-in profile, the
# environment and settings it carries, an evaluation that sees neither the
# user's environment nor the network, and the refusal of a package the binary
# cache lacks. Then the gateway profile of test/flake.nix, written out as a
# repository would carry it, runs the real OMP, Codex and Claude Code.
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
  # The gateway profile of test/flake.nix, as a repository carries it: the same
  # `env` and `settings`, against the same fixture, its plugin references local
  # paths since the VM has no network.
  profileEnv = {
    LITELLM_BASE_URL = "http://127.0.0.1:8080";
    LITELLM_API_KEY = { secret = true; hint = "Create a key at the team's dashboard"; };
  };
  profileSettings = {
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
  # The file and the checks below read one source: JSON as a string literal,
  # which Nix parses, handed to `builtins.fromJSON` (pure, so the restricted
  # evaluation of a profile read at launch is unaffected).
  profileFile = ''
    {
      name = "gateway";
      description = "A team's skills, with the LiteLLM gateway it runs them on";
      plugins = [ ./. "${koluPlugin}" ];
      packages = pkgs: [ pkgs.mcp-nixos ];
      env = builtins.fromJSON ${builtins.toJSON (builtins.toJSON profileEnv)};
      settings = builtins.fromJSON ${builtins.toJSON (builtins.toJSON profileSettings)};
    }
  '';
  # Skills per plugin, as the profile's checks expect them.
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
    write("~/repo/agent-distro.nix", '{ name = "repo"; description = "The repository"; plugins = [ ./plugin ]; }')
    # A profile directory, for AI_PROFILE and the positional selector, with an
    # environment and a secret variable for the repository's to fall back to.
    write("~/elsewhere/agent-distro.nix", '{ name = "elsewhere"; plugins = [ ${plugins.beta} ]; '
          + 'env = { ELSEWHERE_URL = "https://elsewhere.test"; '
          + 'ELSEWHERE_KEY = { secret = true; hint = "Ask the team for a key"; }; }; }')
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

    with subtest("a launch names a profile the directory or AI_PROFILE chose, on stderr"):
        def stderr_of(command):
            return user(f"{{ {command}; }} 2>&1 >/dev/null")
        repo = stderr_of("cd ~/repo && probe-claude")
        assert "agent-distro profile: using repo (from /home/testuser/repo/agent-distro.nix) · https://agent-distro.nixos.asia\n" in repo, repo
        variable = stderr_of("AI_PROFILE=/home/testuser/elsewhere probe-claude")
        assert "agent-distro profile: using elsewhere (from AI_PROFILE=/home/testuser/elsewhere) · https://agent-distro.nixos.asia\n" in variable, variable
        # The built-in profile, and a positional choice, say nothing.
        builtin = stderr_of("probe-claude")
        assert "agent-distro" not in builtin, builtin
        positional = stderr_of("probe-agent-distro /home/testuser/elsewhere claude")
        assert "agent-distro profile: using" not in positional, positional

    with subtest("a repository's profile composes over AI_PROFILE; a positional one is exact"):
        other = "AI_PROFILE=/home/testuser/elsewhere"
        # Named positionally: that profile alone.
        assert launched(f"cd ~/repo && {other} probe-agent-distro /home/testuser/fetched claude")[0] == ["gamma", "delta"]
        assert launched(f"cd ~/repo && {other} probe-agent-distro /home/testuser/elsewhere claude")[0] == ["beta"]
        # The user's plugins, then the repository's.
        assert launched(f"cd ~/repo && {other} probe-claude")[0] == ["beta", "alpha"]
        assert in_effect("~/repo", other) == {
            "name": "repo", "description": "The repository", "source": "repository",
            "origin": "/home/testuser/repo/agent-distro.nix",
            "over": {"name": "elsewhere", "description": "", "source": "variable", "origin": "/home/testuser/elsewhere"}}
        listed = user(f"cd ~/repo && {other} probe-agent-distro --list")
        assert ("elsewhere + repo · The repository · from /home/testuser/repo/agent-distro.nix"
                " over AI_PROFILE=/home/testuser/elsewhere") in listed, listed
        noticed = stderr_of(f"cd ~/repo && {other} probe-claude")
        assert ("agent-distro profile: using elsewhere + repo (from /home/testuser/repo/agent-distro.nix"
                " over AI_PROFILE=/home/testuser/elsewhere) · https://agent-distro.nixos.asia\n") in noticed, noticed
        # The repository declares no `env`: AI_PROFILE's is in effect, and its
        # secret variable is what a launch without a terminal refuses.
        output = refused(f"cd ~/repo && {other} probe-omp")
        assert "ELSEWHERE_KEY is not set" in output and "Ask the team for a key" in output, output
        assert launched(f"{other} probe-claude")[0] == ["beta"]
        assert in_effect("~", other)["source"] == "variable"
        assert "over" not in in_effect("~", other)
        assert launched("probe-claude")[0] == []
        # AGENT_DISTRO_PLUGINS composes on top of whichever profile is in effect.
        assert launched("cd ~/repo && AGENT_DISTRO_PLUGINS=${plugins.beta} probe-claude")[0] == ["alpha", "beta"]
        assert launched(f"cd ~/repo && {other} AGENT_DISTRO_PLUGINS=${plugins.gamma} probe-claude")[0] == ["beta", "alpha", "gamma"]
        # The positional selector is the picker's own: it never reaches the harness.
        assert "/home/testuser/fetched" not in user("probe-agent-distro /home/testuser/fetched claude")

    with subtest("AI_PROFILE is a stack: every entry, composed left to right"):
        # Two entries, both at the fixture: `elsewhere`'s plugin, then
        # `fetched`'s own and the one it names by reference.
        stack = "AI_PROFILE=/home/testuser/elsewhere:/home/testuser/fetched"
        assert launched(f"{stack} probe-claude")[0] == ["beta", "gamma", "delta"]
        assert in_effect(env=stack) == {
            "name": "fetched", "description": "", "source": "variable", "origin": "/home/testuser/fetched",
            "over": {"name": "elsewhere", "description": "", "source": "variable", "origin": "/home/testuser/elsewhere"}}
        # Named from the bottom up, each entry where it came from.
        listed = user(f"{stack} probe-agent-distro --list")
        assert ("elsewhere + fetched ·  · from AI_PROFILE=/home/testuser/fetched"
                " over AI_PROFILE=/home/testuser/elsewhere") in listed, listed
        # The earlier entry's `env` is in effect, and its secret variable is
        # what a launch without a terminal refuses.
        output = refused(f"{stack} probe-omp")
        assert "ELSEWHERE_KEY is not set" in output and "Ask the team for a key" in output, output
        # An entry that is not a reference is refused, naming it and its place.
        output = refused("AI_PROFILE=/home/testuser/elsewhere:nonesuch probe-claude")
        assert "AI_PROFILE=nonesuch (entry 2 of 2): not a reference" in output, output
        assert "STUB-STARTED" not in output, output

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

    with subtest("the gateway profile, read at launch, behaves as a built-in one would"):
        user("cp -r ${juspay-skills} ~/gateway && chmod -R u+w ~/gateway")
        write("~/gateway/agent-distro.nix", ${builtins.toJSON profileFile})
        gateway = "AI_PROFILE=/home/testuser/gateway"
        assert in_effect("~", gateway)["name"] == "gateway"
        user(f"{gateway} python " + shlex.quote("${./profiles/check-gateway-profile.py}") + " " + " ".join(shlex.quote(a) for a in [
            ${builtins.toJSON (builtins.toJSON expected)}, "gateway-ai",
            "${../harnesses/omp/tests}", "${../harnesses/codex/tests}", "${../harnesses/claude/tests}",
            "${pkgs.mcp-nixos}/bin",
            ${builtins.toJSON (builtins.toJSON profileEnv)},
            ${builtins.toJSON (builtins.toJSON profileSettings)}]))
  '';
}
