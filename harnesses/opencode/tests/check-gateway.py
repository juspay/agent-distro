"""The harness shows what the LiteLLM server serves, discovered by the plugin,
under the profile's `settings.opencode`."""
from contextlib import contextmanager
import time

PORT = 4096
QUIET = 'OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_PASSWORD=fixture'


def as_testuser(command):
    return 'su - testuser -c ' + shlex.quote(command)


@contextmanager
def server(extra=''):
    """A reader of one OpenCode server's API, the server started as a launch
    with `extra` would start it. Its model list "may precede initial plugin
    settlement" (OpenCode's API), and with 2.4.1 a one-shot `api --standalone`
    always answers before then, so discovery shows only to a server that
    outlives the read. A transient unit holds it, so no shell waits on it."""
    machine.succeed('systemd-run --unit=opencode-serve --collect -- '
                    + as_testuser(f'{QUIET} {extra} opencode serve --port {PORT}'))
    machine.wait_for_open_port(PORT)
    try:
        yield lambda resource: json.loads(machine.succeed(as_testuser(
            f'{QUIET} {extra} opencode api --server http://127.0.0.1:{PORT} GET /api/{resource}'
            ' --header x-opencode-directory:/home/testuser')))
    finally:
        machine.succeed('systemctl stop opencode-serve')
        machine.wait_for_closed_port(PORT)


def models(read):
    """OpenCode's registered litellm models, from a list that has settled: one
    that lists any model at all."""
    for _ in range(30):
        listed = read('model').get('data', [])
        if listed:
            return {model['id']: model for model in listed if model['providerID'] == 'litellm'}
        time.sleep(1)
    raise AssertionError('OpenCode never listed a model')


def discovered(read):
    """`models`, once the plugin has answered: a cold location discovers in the
    background, and the request that finds it still working answers without it."""
    for _ in range(30):
        found = models(read)
        if found:
            return found
        time.sleep(2)
    raise AssertionError('the gateway\'s models never appeared')


def document(read):
    documents = [entry['info'] for entry in read('config') if entry['type'] == 'document']
    return next((info for info in documents if 'litellm' in info.get('providers', {})), {})


machine.succeed('systemctl start fake-gateway.service')
machine.wait_for_open_port(8080)
with server() as read:
    # The server's own list, discovered by opencode-plugin-litellm: the
    # profile's two aliases and a model no profile names, with the prices,
    # limits and capabilities `/v1/model/info` reports.
    found = discovered(read)
    resolved = document(read)
assert set(found) == {'open-large', 'open-fast', 'served-only'}, found
# The fixture-only model is the one a profile cannot have contributed.
fixture_only = found['served-only']
assert fixture_only['limit'] == {'context': 200000, 'output': 8192}, fixture_only
assert fixture_only['cost'][0]['input'] == 1, fixture_only
assert fixture_only['cost'][0]['output'] == 2, fixture_only
assert fixture_only['capabilities']['tools'], fixture_only
# The profile's `settings.opencode` reaches the document OpenCode reads: the
# provider it points at the server, the model it makes the default, the small
# one on the title agent, and the plugin that discovers what is served.
settings = profile_settings['opencode']
provider = resolved['providers']['litellm']
assert provider['package'] == settings['providers']['litellm']['package'], provider
assert provider['settings']['baseURL'] == profile_env['LITELLM_BASE_URL'] + '/v1', provider
assert resolved['model'] == {'providerID': 'litellm', 'model': settings['model'].removeprefix('litellm/')}, resolved
assert resolved['agents']['title']['model'] == {'providerID': 'litellm', 'model': settings['agents']['title']['model'].removeprefix('litellm/')}, resolved
assert '/nix/store/' in resolved['plugins'][0], resolved
# The key is read from the environment, so it reaches no file.
cached = machine.succeed('cat /home/testuser/.cache/agent-distro/opencode/settings/*.json')
assert 'test-api-key' not in cached
assert profile_env['LITELLM_BASE_URL'] in cached

# AGENT_DISTRO_SETTINGS=0: the launcher exports nothing, prompts for nothing
# and merges nothing — here with the key out of the environment, so the launch
# neither asks for it nor has one. (The plugin's own fallback probe of
# localhost:8080 would find the fixture if the key were set, which is the
# plugin's business, not the launcher's.)
secrets = [name for name, value in profile_env.items() if not isinstance(value, str)]
assert len(secrets) == 1, profile_env
key = secrets[0]
opt_out = f'env -u {key} AGENT_DISTRO_SETTINGS=0'
before = machine.succeed('ls /home/testuser/.cache/agent-distro/opencode/settings')
machine.succeed(f"su - testuser -c '{opt_out} opencode --version </dev/null'")
assert machine.succeed('ls /home/testuser/.cache/agent-distro/opencode/settings') == before
with server(opt_out) as read:
    documents = [entry['info'] for entry in read('config') if entry['type'] == 'document']
    assert not any(info.get('providers') for info in documents), documents
    assert models(read) == {}
# Without it, the same launch has no key to start with.
machine.fail(f"su - testuser -c 'env -u {key} opencode --version </dev/null'")
