"""The harness shows what the gateway serves, discovered by the plugin."""
import time


def opencode(resource, extra=''):
    inspect = f'api --standalone GET /api/{resource} --header x-opencode-directory:/home/testuser'
    command = f'OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true {extra} opencode {inspect}'
    return json.loads(machine.succeed('su - testuser -c ' + shlex.quote(command)))


def models(extra=''):
    """OpenCode's registered litellm models, from the harness itself."""
    return {model['id']: model for model in opencode('model', extra).get('data', [])
            if model['providerID'] == 'litellm'}


def discovered():
    """`models`, once the plugin has answered: a cold location discovers in the
    background, and the request that finds it still working answers without it."""
    for _ in range(30):
        found = models()
        if found:
            return found
        time.sleep(2)
    raise AssertionError('the gateway\'s models never appeared')


def document(extra=''):
    documents = [entry['info'] for entry in opencode('config', extra) if entry['type'] == 'document']
    return next((info for info in documents if 'litellm' in info.get('providers', {})), {})


machine.succeed('systemctl start fake-gateway.service')
machine.wait_for_open_port(8080)
# The gateway's own list, discovered by opencode-plugin-litellm: the profile's
# two aliases and a model no profile names, with the prices, limits and
# capabilities `/v1/model/info` reports.
found = discovered()
assert set(found) == {'open-large', 'open-fast', 'served-only'}, found
assert found['served-only']['limit'] == {'context': 200000, 'output': 8192}, found['served-only']
assert found['served-only']['cost'][0]['input'] == 1, found['served-only']
assert found['served-only']['cost'][0]['output'] == 2, found['served-only']
assert found['served-only']['capabilities']['tools'], found['served-only']
# The launcher points the provider at the gateway and makes the profile's large
# model the default, with the small one on the title agent.
resolved = document()
provider = resolved['providers']['litellm']
assert provider['package'] == '@opencode/ai/providers/openai-compatible', provider
assert provider['settings']['baseURL'] == 'http://127.0.0.1:8080/v1', provider
assert resolved['model'] == {'providerID': 'litellm', 'model': gateway['models']['large']}, resolved
assert resolved['agents']['title']['model'] == {'providerID': 'litellm', 'model': gateway['models']['small']}, resolved
assert '/nix/store/' in resolved['plugins'][0], resolved
# The key is read from the environment, so it reaches no file.
cached = machine.succeed('cat /home/testuser/.cache/agent-distro/opencode/gateway/*.json')
assert 'test-api-key' not in cached
assert gateway['models']['large'] in cached
# AI_GATEWAY=0 leaves the gateway out of the config, and so out of the list.
assert 'litellm' not in document('AI_GATEWAY=0').get('providers', {})
assert models('AI_GATEWAY=0') == {}, models('AI_GATEWAY=0')
machine.fail(f"su - testuser -c 'env -u {gateway['keyEnv']} opencode --version </dev/null'")
