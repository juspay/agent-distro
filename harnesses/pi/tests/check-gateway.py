def pi_user(command):
    return machine.succeed("su - testuser -c " + shlex.quote(command))

PI_DIR = "/home/testuser/.pi/agent"
def pi_read(name):
    return json.loads(pi_user(f"cat {PI_DIR}/{name}.json"))

def pi_write(name, data):
    pi_user("printf %s " + shlex.quote(json.dumps(data)) + f" > {PI_DIR}/{name}.json")

# Opt-out must not create a provider file or seed gateway defaults.
pi_user(f"env -u {gateway['keyEnv']} AI_GATEWAY=0 pi --version")
machine.fail(f"test -e {PI_DIR}/models.json")
assert "defaultProvider" not in pi_read("settings")
assert "defaultModel" not in pi_read("settings")
assert "defaultThinkingLevel" not in pi_read("settings")
machine.succeed("systemctl start fake-gateway.service")
machine.wait_for_open_port(8080)
personal_provider = {"baseUrl": "https://personal.invalid/v1", "api": "openai-completions",
                     "apiKey": "personal-key", "models": [{"id": "keep-me"}]}
pi_write("models", {"providers": {"personal": personal_provider}})
pi_user("pi --version")
models = pi_read("models")
provider = models["providers"]["litellm"]
aliases = {gateway['models']['large'], gateway['models']['small']}
assert {m["id"] for m in provider["models"]} == aliases | {"served-large", "served-small"}
assert provider["baseUrl"] == "http://127.0.0.1:8080/v1"
assert provider["api"] == "openai-completions"
assert provider["apiKey"] == "$" + gateway['keyEnv'], provider
assert models["providers"]["personal"] == personal_provider
assert pi_read("settings")["defaultProvider"] == "litellm"
assert pi_read("settings")["defaultModel"] == gateway['models']['large']
assert pi_read("settings")["defaultThinkingLevel"] == "off"
listing = pi_user("pi --list-models litellm")
for model in aliases | {"served-large", "served-small"}:
    assert model in listing, listing
cache = pi_user("cat /home/testuser/.cache/agent-distro/pi/*/models.json")
assert "test-api-key" not in cache

custom = pi_read("settings") | {"defaultProvider": "personal", "defaultModel": "keep-me", "defaultThinkingLevel": "high"}
pi_write("settings", custom)
pi_user("pi --version")
assert pi_read("settings") == custom
machine.succeed("systemctl stop fake-gateway.service")
pi_user("pi --version")
assert pi_read("models") == models
pi_user("XDG_CACHE_HOME=/home/testuser/pi-empty-cache pi --version")
assert {m["id"] for m in pi_read("models")["providers"]["litellm"]["models"]} == aliases

before = {name: pi_user(f"cat {PI_DIR}/{name}.json") for name in ["settings", "models", "mcp"]}
pi_user(f"env -u {gateway['keyEnv']} AI_GATEWAY=0 pi --version")
assert all(pi_user(f"cat {PI_DIR}/{name}.json") == value for name, value in before.items())
machine.fail(f"su - testuser -c 'env -u {gateway['keyEnv']} pi --version </dev/null'")
# Bad provider JSON must stop before refreshing MCP or settings.
pi_user(f"printf '{{' > {PI_DIR}/models.json")
machine.fail("su - testuser -c 'pi --version'")
assert pi_user(f"cat {PI_DIR}/models.json") == "{"
assert all(pi_user(f"cat {PI_DIR}/{name}.json") == before[name] for name in ["settings", "mcp"])
pi_user(f"env -u {gateway['keyEnv']} AI_GATEWAY=0 pi --version")
assert pi_user(f"cat {PI_DIR}/models.json") == "{"
