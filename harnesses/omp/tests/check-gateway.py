"""Starting OMP with the profile's settings: what the launcher fills in, and
what it refuses to start without.

Runs in the gateway suite: the launcher was built with a profile that declares
`env` (a value and a secret) and `settings.omp` (model roles), and the VM sets
every secret, as a user with a key would.
"""
from omp_support import *

CONFIG = "/home/testuser/.omp/agent/config.yml"


def run_as_user(command):
    return machine.succeed("su - testuser -c " + shlex.quote(command))


def refused(command):
    status, output = machine.execute("su - testuser -c " + shlex.quote(command + " 2>&1"))
    assert status != 0, output
    return output


def write_config(path, content):
    run_as_user("printf %s " + shlex.quote(content) + " > " + shlex.quote(path))


def effective_setting(key):
    """The value omp itself resolves for `key`, from the global layer.

    Query the agent's settings resolver rather than matching YAML spelling.
    """
    return json.loads(run_as_user(f"omp config get {key} --json"))["value"]


secrets = [name for name, value in profile_env.items() if not isinstance(value, str)]
assert len(secrets) == 1, profile_env
key = secrets[0]
hint = profile_env[key]["hint"]
roles = profile_settings["omp"]["modelRoles"]

# Missing credentials must fail before launching OMP or changing config: a
# secret the environment does not set is prompted for, and there is no
# terminal here.
for missing in [f"-u {key}", f"{key}="]:
    output = refused(f"env {missing} omp --version </dev/null")
    assert hint in output, output
    assert f"cannot prompt for {key} (stdin is not a terminal)" in output, output
machine.fail(f"test -e {CONFIG}")

# AGENT_DISTRO_SETTINGS=0 loads the plugins and nothing else: no environment,
# no prompt, no settings — while the wrapper's own display defaults stand.
machine.succeed(f"su - testuser -c 'env -u {key} AGENT_DISTRO_SETTINGS=0 omp --version </dev/null'")
opted_out = machine.succeed(f"cat {CONFIG}")
assert "hideThinkingBlock: true" in opted_out, opted_out
assert "showResolvedModelBadge: true" in opted_out, opted_out
assert "modelRoles" not in opted_out, opted_out

# A launch with settings fills the roles the profile names, absent keys only.
version = run_as_user("omp --version")
print(f"omp version: {version}")
assert effective_setting("modelRoles") == roles, effective_setting("modelRoles")
assert effective_setting("task.showResolvedModelBadge") is True
assert effective_setting("hideThinkingBlock") is True
# Whether the gateway serves anything is OMP's business: the wrapper hands it
# no model list to keep.
machine.fail(f"test -e /home/testuser/.omp/agent/models.yml")

# A user's own value is never replaced: an expensive primary and a display
# default turned off both survive, with the profile's other keys filled in
# around them and the comments kept.
old_config = "# user settings\nsetupVersion: 2\nmodelRoles:\n  default: 'anthropic/expensive:high' # keep choice\ntask:\n  showResolvedModelBadge: false\n"
write_config(CONFIG, old_config)
run_as_user("omp --version")
config = machine.succeed(f"cat {CONFIG}")
for expected in ["# user settings", "setupVersion: 2", "default: 'anthropic/expensive:high' # keep choice",
                 "showResolvedModelBadge: false", "hideThinkingBlock: true"]:
    assert expected in config, config
assert effective_setting("task.showResolvedModelBadge") is False
assert effective_setting("modelRoles")["default"] == "anthropic/expensive:high"
assert effective_setting("modelRoles")["slow"] == roles["slow"]

# Relocated configs get the same fill without touching the normal one.
run_as_user("mkdir -p /home/testuser/relocated")
relocated = "/home/testuser/relocated/config.yml"
write_config(relocated, old_config)
run_as_user("PI_CODING_AGENT_DIR=/home/testuser/relocated omp --version")
assert f"slow: {roles['slow']}" in machine.succeed(f"cat {relocated}")
assert machine.succeed(f"cat {CONFIG}") == config

# A config that does not parse stops the launch without a write.
for invalid in ["modelRoles: [", "modelRoles: []\n", "task: []\n"]:
    write_config(relocated, invalid)
    machine.fail("su - testuser -c 'PI_CODING_AGENT_DIR=/home/testuser/relocated omp --version'")
    assert machine.succeed(f"cat {relocated}") == invalid
print("✅ the profile's roles fill only what the user left absent; an invalid config stays untouched")
