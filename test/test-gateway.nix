{ launchers, profile, opencodeLaunchers }:
let common = import ./common.nix;
in {
  name = "gateway";
  nodes.machine = { pkgs, ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ launchers.omp opencodeLaunchers.opencode opencodeLaunchers.opencode2 opencodeLaunchers.pi pkgs.python3 ];
    systemd.services.fake-gateway = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python ${./opencode-gateway-fixture.py}";
    };
    environment.variables.PI_SKIP_VERSION_CHECK = "1";
    environment.variables.${profile.gateway.keyEnv} = "test-api-key";
  };
  testScript = ''
    import json
    import shlex
    ${common.testPreamble}
    machine.wait_for_unit("fake-gateway.service")
    machine.wait_for_open_port(8080)
    def opencode_config(binary, extra=""):
        inspect = "--pure debug config" if binary == "opencode" else "api --standalone GET /api/config --header x-opencode-directory:/home/testuser"
        command = f"OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true {extra} {binary} {inspect}"
        result = json.loads(machine.succeed("su - testuser -c " + shlex.quote(command)))
        if binary == "opencode":
            return result
        # V2 exposes config sources; select the generated gateway document.
        documents = [entry["info"] for entry in result if entry["type"] == "document"]
        return next((info for info in documents if "litellm" in info.get("providers", {})), {})

    for binary, provider_key, settings_key in [("opencode", "provider", "options"), ("opencode2", "providers", "settings")]:
        machine.succeed("systemctl start fake-gateway.service")
        machine.wait_for_open_port(8080)
        config = opencode_config(binary)
        provider = config[provider_key]["litellm"]
        assert set(provider["models"]) == {"served-large", "served-small", "${profile.gateway.models.large}", "${profile.gateway.models.small}"}, config
        assert provider[settings_key]["baseURL"] == "http://127.0.0.1:8080/v1"
        cached_text = machine.succeed(f"cat /home/testuser/.cache/agent-distro/{binary}/*/opencode.json")
        cached = json.loads(cached_text)
        assert "test-api-key" not in cached_text
        assert cached["model"] == "litellm/${profile.gateway.models.large}"
        if binary == "opencode":
            assert provider["options"]["apiKey"] == "***"
            assert cached["provider"]["litellm"]["options"]["apiKey"] == "{env:${profile.gateway.keyEnv}}"
            assert config["model"] == "litellm/${profile.gateway.models.large}"
            assert config["small_model"] == "litellm/${profile.gateway.models.small}"
        else:
            assert provider["env"] == ["${profile.gateway.keyEnv}"]
            assert provider["package"] == "@opencode/ai/providers/openai-compatible"
            assert config["model"] == {"providerID": "litellm", "model": "${profile.gateway.models.large}"}
            assert "small_model" not in cached
        machine.succeed("systemctl stop fake-gateway.service")
        assert opencode_config(binary) == config
        fallback = opencode_config(binary, "XDG_CACHE_HOME=/home/testuser/empty-cache")
        assert set(fallback[provider_key]["litellm"]["models"]) == {"${profile.gateway.models.large}", "${profile.gateway.models.small}"}
        assert "litellm" not in opencode_config(binary, "AI_GATEWAY=0").get(provider_key, {})
        machine.fail(f"su - testuser -c 'env -u ${profile.gateway.keyEnv} {binary} --version </dev/null'")
    def pi_user(command):
        return machine.succeed("su - testuser -c " + shlex.quote(command))

    PI_DIR = "/home/testuser/.pi/agent"
    def pi_read(name):
        return json.loads(pi_user(f"cat {PI_DIR}/{name}.json"))

    def pi_write(name, data):
        pi_user("printf %s " + shlex.quote(json.dumps(data)) + f" > {PI_DIR}/{name}.json")

    # Opt-out must not create a provider file or seed gateway defaults.
    pi_user("env -u ${profile.gateway.keyEnv} AI_GATEWAY=0 pi --version")
    machine.fail(f"test -e {PI_DIR}/models.json")
    assert "defaultProvider" not in pi_read("settings")
    assert "defaultModel" not in pi_read("settings")
    machine.succeed("systemctl start fake-gateway.service")
    machine.wait_for_open_port(8080)
    personal_provider = {"baseUrl": "https://personal.invalid/v1", "api": "openai-completions",
                         "apiKey": "personal-key", "models": [{"id": "keep-me"}]}
    pi_write("models", {"providers": {"personal": personal_provider}})
    pi_user("pi --version")
    models = pi_read("models")
    provider = models["providers"]["litellm"]
    aliases = {"${profile.gateway.models.large}", "${profile.gateway.models.small}"}
    assert {m["id"] for m in provider["models"]} == aliases | {"served-large", "served-small"}
    assert provider["baseUrl"] == "http://127.0.0.1:8080/v1"
    assert provider["api"] == "openai-completions"
    assert provider["apiKey"] == "$${profile.gateway.keyEnv}"
    assert models["providers"]["personal"] == personal_provider
    assert pi_read("settings")["defaultProvider"] == "litellm"
    assert pi_read("settings")["defaultModel"] == "${profile.gateway.models.large}"
    listing = pi_user("pi --list-models litellm")
    for model in aliases | {"served-large", "served-small"}:
        assert model in listing, listing
    cache = pi_user("cat /home/testuser/.cache/agent-distro/pi/*/models.json")
    assert "test-api-key" not in cache

    custom = pi_read("settings") | {"defaultProvider": "personal", "defaultModel": "keep-me"}
    pi_write("settings", custom)
    pi_user("pi --version")
    assert pi_read("settings") == custom
    machine.succeed("systemctl stop fake-gateway.service")
    pi_user("pi --version")
    assert pi_read("models") == models
    pi_user("XDG_CACHE_HOME=/home/testuser/pi-empty-cache pi --version")
    assert {m["id"] for m in pi_read("models")["providers"]["litellm"]["models"]} == aliases

    before = {name: pi_user(f"cat {PI_DIR}/{name}.json") for name in ["settings", "models", "mcp"]}
    pi_user("env -u ${profile.gateway.keyEnv} AI_GATEWAY=0 pi --version")
    assert all(pi_user(f"cat {PI_DIR}/{name}.json") == value for name, value in before.items())
    machine.fail("su - testuser -c 'env -u ${profile.gateway.keyEnv} pi --version </dev/null'")
    # Bad provider JSON must stop before refreshing MCP or settings.
    pi_user(f"printf '{{' > {PI_DIR}/models.json")
    machine.fail("su - testuser -c 'pi --version'")
    assert pi_user(f"cat {PI_DIR}/models.json") == "{"
    assert all(pi_user(f"cat {PI_DIR}/{name}.json") == before[name] for name in ["settings", "mcp"])
    pi_user("env -u ${profile.gateway.keyEnv} AI_GATEWAY=0 pi --version")
    assert pi_user(f"cat {PI_DIR}/models.json") == "{"

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
