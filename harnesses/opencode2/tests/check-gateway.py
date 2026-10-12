def opencode_config(binary, extra=''):
    inspect = 'api --standalone GET /api/config --header x-opencode-directory:/home/testuser'
    command = f'OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true {extra} {binary} {inspect}'
    result = json.loads(machine.succeed('su - testuser -c ' + shlex.quote(command)))
    documents = [entry['info'] for entry in result if entry['type'] == 'document']
    return next((info for info in documents if 'litellm' in info.get('providers', {})), {})
for binary, provider_key, settings_key in [('opencode2', 'providers', 'settings')]:
    machine.succeed('systemctl start fake-gateway.service')
    machine.wait_for_open_port(8080)
    config = opencode_config(binary)
    provider = config[provider_key]['litellm']
    assert set(provider['models']) == {'served-large', 'served-small', gateway['models']['large'], gateway['models']['small']}, config
    assert provider[settings_key]['baseURL'] == 'http://127.0.0.1:8080/v1'
    cached_text = machine.succeed(f'cat /home/testuser/.cache/agent-distro/{binary}/*/opencode.json')
    cached = json.loads(cached_text)
    assert 'test-api-key' not in cached_text
    assert cached['model'] == f'litellm/{gateway['models']['large']}'
    assert provider['env'] == [gateway['keyEnv']]
    assert provider['package'] == '@opencode/ai/providers/openai-compatible'
    assert config['model'] == {'providerID': 'litellm', 'model': gateway['models']['large']}
    # v2's replacement for v1's small_model, resolved as the top-level model is.
    assert config['agents']['title']['model'] == {'providerID': 'litellm', 'model': gateway['models']['small']}, config
    assert 'small_model' not in cached
    assert cached['agents']['title']['model'] == f'litellm/{gateway['models']['small']}'
    machine.succeed('systemctl stop fake-gateway.service')
    assert opencode_config(binary) == config
    fallback = opencode_config(binary, 'XDG_CACHE_HOME=/home/testuser/empty-cache')
    assert set(fallback[provider_key]['litellm']['models']) == {gateway['models']['large'], gateway['models']['small']}
    assert 'litellm' not in opencode_config(binary, 'AI_GATEWAY=0').get(provider_key, {})
    machine.fail(f"su - testuser -c 'env -u {gateway['keyEnv']} {binary} --version </dev/null'")
