{ launchers, profile }:
let common = import ./common.nix;
in {
  name = "gateway";
  nodes.machine = { ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ launchers.omp ];
    environment.variables.${profile.gateway.keyEnv} = "test-api-key";
  };
  testScript = ''
    import json
    import shlex
    ${common.testPreamble}
    CONFIG = "/home/testuser/.omp/agent/config.yml"
    # Runtime opt-out uses the same package, needs no gateway key, and must not
    # seed gateway settings before upstream OMP starts.
    machine.succeed("su - testuser -c 'env -u ${profile.gateway.keyEnv} AI_GATEWAY=0 omp --version </dev/null'")
    machine.fail(f"test -e {CONFIG}")

    deprecated = machine.succeed("su - testuser -c 'env -u ${profile.gateway.keyEnv} JUSPAY=0 omp --version </dev/null 2>&1'")
    assert deprecated.count("JUSPAY=0 is deprecated; use AI_GATEWAY=0 instead.") == 1, deprecated
    machine.fail(f"test -e {CONFIG}")

    # First launch: this is also what seeds the config asserted on below.
    version = machine.succeed("su - testuser -c 'omp --version'")
    print(f"omp version: {version}")

    # Missing credentials must fail before launching OMP or changing config.
    for key in ["-u ${profile.gateway.keyEnv}", "${profile.gateway.keyEnv}="]:
        machine.fail(f"su - testuser -c 'env {key} omp --version </dev/null'")

    def run_as_user(command):
        return machine.succeed("su - testuser -c " + shlex.quote(command))

    def write_config(path, content):
        run_as_user("printf %s " + shlex.quote(content) + " > " + shlex.quote(path))

    def effective_setting(key):
        """The value omp itself resolves for `key`, from the global layer.

        Query the agent's settings resolver rather than matching YAML spelling.
        """
        return json.loads(run_as_user(f"omp config get {key} --json"))["value"]

    assert effective_setting("modelRoles") == {
        "default": "litellm/${profile.gateway.models.large}",
        "smol": "litellm/${profile.gateway.models.small}",
        "task": "litellm/${profile.gateway.models.large}",
        "slow": "litellm/${profile.gateway.models.large}",
    }
    assert effective_setting("task.showResolvedModelBadge") is True
    machine.fail("test -e /home/testuser/.omp/agent/models.yml")
    # Reproduce an existing wizard config with an expensive primary. Preserve
    # unrelated settings and comments while adding all background roles and the
    # display defaults.
    old_config = "# user settings\nsetupVersion: 2\nmodelRoles:\n  default: 'anthropic/expensive:high' # keep choice\n"
    write_config(CONFIG, old_config)
    run_as_user("omp --version")
    config = machine.succeed(f"cat {CONFIG}")
    for expected in ["# user settings", "setupVersion: 2", "default: 'anthropic/expensive:high' # keep choice", "smol: litellm/${profile.gateway.models.small}", "task: litellm/${profile.gateway.models.large}", "slow: litellm/${profile.gateway.models.large}", "showResolvedModelBadge: true"]:
        assert expected in config, config

    # A fully configured file must not even be rewritten — /model choices win,
    # and so does the user turning a defaulted setting off. The badge is the
    # only default that is a *choice* rather than a pointer at our gateway, so
    # `false` is the value a user is most likely to have set themselves.
    custom = config.replace("litellm/${profile.gateway.models.small}", "litellm/custom-fast").replace("litellm/${profile.gateway.models.large}", "litellm/custom-large").replace("showResolvedModelBadge: true", "showResolvedModelBadge: false")
    write_config(CONFIG, custom)
    before = machine.succeed(f"stat -c '%i %Y' {CONFIG}")
    run_as_user("omp --version")
    assert machine.succeed(f"cat {CONFIG}") == custom
    assert machine.succeed(f"stat -c '%i %Y' {CONFIG}") == before
    # The mirror of the fresh-config probe: a setting the wrapper wants on, off
    # by the user's own hand, has to reach omp as off.
    assert effective_setting("task.showResolvedModelBadge") is False

    # Relocated configs get the same migration without changing the normal one.
    run_as_user("mkdir -p /home/testuser/relocated")
    relocated = "/home/testuser/relocated/config.yml"
    write_config(relocated, old_config)
    run_as_user("PI_CODING_AGENT_DIR=/home/testuser/relocated omp --version")
    assert "task: litellm/${profile.gateway.models.large}" in machine.succeed(f"cat {relocated}")
    assert machine.succeed(f"cat {CONFIG}") == custom

    for initial in ["# my settings", "setupVersion: 2\n"]:
        write_config(relocated, initial)
        run_as_user("PI_CODING_AGENT_DIR=/home/testuser/relocated omp --version")
        repaired = machine.succeed(f"cat {relocated}")
        assert initial in repaired
        assert "default: litellm/${profile.gateway.models.large}" in repaired
        assert "slow: litellm/${profile.gateway.models.large}" in repaired

    for invalid in ["modelRoles: [", "modelRoles: []\n", "modelRoles: null\n", "task: []\n", "task: null\n"]:
        write_config(relocated, invalid)
        machine.fail("su - testuser -c 'PI_CODING_AGENT_DIR=/home/testuser/relocated omp --version'")
        assert machine.succeed(f"cat {relocated}") == invalid
    print("✅ existing roles, settings and comments survive migration; invalid config stays untouched")

    # Opting out also preserves existing user configuration without adding the
    # gateway's background roles or display defaults.
    personal = "# personal provider\nmodelRoles:\n  default: openai/my-model\n"
    write_config(relocated, personal)
    roles = json.loads(run_as_user(
        "env -u ${profile.gateway.keyEnv} AI_GATEWAY=0 PI_CODING_AGENT_DIR=/home/testuser/relocated "
        "omp config get modelRoles --json"
    ))["value"]
    assert roles == {"default": "openai/my-model"}
    assert machine.succeed(f"cat {relocated}") == personal

  '';
}
