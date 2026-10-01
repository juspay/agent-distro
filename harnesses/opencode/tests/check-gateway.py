# nixos-test-driver
def opencode_config(binary, extra=''):
    inspect = '--pure debug config'
    command = f'OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true {extra} {binary} {inspect}'
    result = json.loads(machine.succeed('su - testuser -c ' + shlex.quote(command)))
    return result
for binary, provider_key, settings_key in [('opencode', 'provider', 'options')]:
    machine.succeed('systemctl start fake-gateway.service')
    machine.wait_for_open_port(8080)
    config = opencode_config(binary)
    provider = config[provider_key]['litellm']
    assert set(provider['models']) == {'served-large', 'served-small', '@models.large@', '@models.small@'}, config
    assert provider[settings_key]['baseURL'] == 'http://127.0.0.1:8080/v1'
    cached_text = machine.succeed(f'cat /home/testuser/.cache/agent-distro/{binary}/*/opencode.json')
    cached = json.loads(cached_text)
    assert 'test-api-key' not in cached_text
    assert cached['model'] == 'litellm/@models.large@'
    assert provider['options']['apiKey'] == '***'
    assert cached['provider']['litellm']['options']['apiKey'] == '{env:@keyEnv@}'
    assert config['model'] == 'litellm/@models.large@'
    assert config['small_model'] == 'litellm/@models.small@'
    machine.succeed('systemctl stop fake-gateway.service')
    assert opencode_config(binary) == config
    fallback = opencode_config(binary, 'XDG_CACHE_HOME=/home/testuser/empty-cache')
    assert set(fallback[provider_key]['litellm']['models']) == {'@models.large@', '@models.small@'}
    assert 'litellm' not in opencode_config(binary, 'AI_GATEWAY=0').get(provider_key, {})
    machine.fail(f"su - testuser -c 'env -u @keyEnv@ {binary} --version </dev/null'")
