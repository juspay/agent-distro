{ launchers, profile, gatewayLaunchers }:
let common = import ./common.nix;
in {
  name = "gateway";
  nodes.machine = { pkgs, ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ launchers.omp gatewayLaunchers.pi gatewayLaunchers.opencode gatewayLaunchers.opencode2 pkgs.python3 ];
    systemd.services.fake-gateway = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python ${./opencode-gateway-fixture.py}";
    };
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
    ## Pi: gateway models, defaults, and the AI_GATEWAY=0 opt-out.
    PI = "/home/testuser/.pi/agent"
    run_as_user(f"mkdir -p {PI}/empty")
    machine.succeed("systemctl start fake-gateway.service")
    machine.wait_for_open_port(8080)
    run_as_user("AI_GATEWAY=1 pi --version")
    models = json.loads(run_as_user(f"cat {PI}/models.json"))["providers"]["litellm"]
    assert {model["id"] for model in models["models"]} == {
        "served-large", "served-small", "${profile.gateway.models.large}", "${profile.gateway.models.small}"}, models
    assert models["baseUrl"] == "http://127.0.0.1:8080/v1", models
    settings = json.loads(run_as_user(f"cat {PI}/settings.json"))
    assert settings["defaultProvider"] == "litellm" and settings["defaultModel"] == "${profile.gateway.models.large}", settings

    # Served ids ride along in the cache even when the gateway is down.
    machine.succeed("systemctl stop fake-gateway.service")
    run_as_user("rm -rf /home/testuser/.cache /home/testuser/.pi")
    run_as_user(f"mkdir -p {PI}")
    run_as_user("AI_GATEWAY=1 pi --version")
    cached = json.loads(run_as_user("cat /home/testuser/.cache/agent-distro/pi/*/models.json"))["providers"]["litellm"]
    assert {model["id"] for model in cached["models"]} == {
        "served-large", "served-small", "${profile.gateway.models.large}", "${profile.gateway.models.small}"}, cached
    run_as_user("rm -rf /home/testuser/.cache/agent-distro")
    run_as_user("AI_GATEWAY=1 pi --version")
    fallback = json.loads(run_as_user(f"cat {PI}/models.json"))["providers"]["litellm"]
    assert {model["id"] for model in fallback["models"]} == {
        "${profile.gateway.models.large}", "${profile.gateway.models.small}"}, fallback

    # Existing user settings win; unrelated models.json content survives.
    run_as_user(f"printf '%s' '{{\"defaultModel\": \"personal/model\", \"defaultProvider\": \"personal\", \"user\": 1}}' > {PI}/settings.json")
    run_as_user(f"printf '%s' '{{\"providers\": {{\"personal\": {{\"baseUrl\": \"x\"}}}}, \"top\": 1}}' > {PI}/models.json")
    machine.succeed("systemctl start fake-gateway.service")
    machine.wait_for_open_port(8080)
    run_as_user("AI_GATEWAY=1 pi --version")
    settings = json.loads(run_as_user(f"cat {PI}/settings.json"))
    assert settings["defaultModel"] == "personal/model" and settings["defaultProvider"] == "personal" and settings["user"] == 1, settings
    assert "skills" in settings, settings  # skills are fused unconditionally.
    merged_models = json.loads(run_as_user(f"cat {PI}/models.json"))
    assert merged_models["top"] == 1 and merged_models["providers"]["personal"]["baseUrl"] == "x", merged_models
    assert {model["id"] for model in merged_models["providers"]["litellm"]["models"]} == {
        "served-large", "served-small", "${profile.gateway.models.large}", "${profile.gateway.models.small}"}, merged_models
    machine.succeed("systemctl stop fake-gateway.service")

    # AI_GATEWAY=0 skips only the gateway work: no models.json write and no
    # gateway defaults, but the skills array still lands in settings.json.
    before = run_as_user(f"cat {PI}/models.json")
    run_as_user("env -u ${profile.gateway.keyEnv} AI_GATEWAY=0 pi --version")
    assert run_as_user(f"cat {PI}/models.json") == before
    settings = json.loads(run_as_user(f"cat {PI}/settings.json"))
    assert "defaultProvider" not in settings and "defaultModel" not in settings and "skills" in settings, settings
    # Missing credentials fail before launching Pi or changing config.
    machine.fail("su - testuser -c 'env -u ${profile.gateway.keyEnv} AI_GATEWAY=1 pi --version </dev/null'")
    assert run_as_user(f"cat {PI}/models.json") == before

    # Invalid mcp.json aborts the launch without writing.
    run_as_user(f"printf '%s' '{{ bad' > {PI}/mcp.json")
    machine.fail("su - testuser -c 'AI_GATEWAY=0 pi --version'")
    assert machine.succeed(f"cat {PI}/mcp.json") == "{ bad"
    run_as_user(f"rm {PI}/mcp.json")
   '';
}
