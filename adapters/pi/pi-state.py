"""Fuse the build-time pi-config fragments into the user's agent directory.

Pi reads its whole user state statically: MCP servers from mcp.json, skills
and defaults from settings.json, models from models.json — and there is no
per-session config or CLI flag that could shadow any of them. The store paths
the fragments name change between builds, so this step rewrites our entries on
every launch, keeping the user's own entries untouched.

The agent directory is not worth a failed launch: when it cannot be written,
warn once and leave Pi to run with whatever it can read. Only invalid JSON in
an *existing* file aborts, because that is the user's data, not our absence of
a place to put it.

Usage: pi-state.py AGENT_DIR CONFIG [KEY_ENV CACHE CURL]
"""
import json
import os
import sys
from pathlib import Path
import subprocess

from gateway_models import fetch_ids
from write_json import read_json, write_json

OUR_SKILLS = '-pi-config/skills/'


def load_user(path, what):
    """The user's current file, or {} when absent; invalid JSON aborts."""
    data = read_json(path)
    if data is None:
        return {}
    if not isinstance(data, dict):
        sys.exit(f'pi: cannot update {what}: {path} must be an object')
    return data


def merge_mcp(user, fragment):
    servers = user.get('mcpServers')
    if servers is None:
        servers = user['mcpServers'] = {}
    elif not isinstance(servers, dict):
        sys.exit('pi: cannot update mcp.json: "mcpServers" must be an object')
    # Our servers replace previous builds' entries of the same names; the
    # user's own servers are never touched.
    servers.update(fragment['mcpServers'])


def merge_skills(user, configured):
    """Our materialised skill dirs replace our previous builds' entries.

    Ours are recognised by this config's store-path segment; anything else in
    the user's `skills` array is theirs and stays.
    """
    skills = user.get('skills')
    if skills is None:
        skills = user['skills'] = []
    if not isinstance(skills, list):
        sys.exit('pi: cannot update settings.json: "skills" must be an array')
    user['skills'] = [entry for entry in skills if OUR_SKILLS not in str(entry)] + configured


def merge_defaults(user, defaults):
    """Add absent gateway defaults; a user key always wins."""
    for key, value in defaults.items():
        if key not in user:
            user[key] = value


def merge_gateway(user, gateway_cfg, cache, key_env, curl):
    """The litellm provider is ours: replaced wholesale, others untouched."""
    provider = gateway_cfg['providers']['litellm']
    aliases = [model['id'] for model in provider['models']]
    providers = user.setdefault('providers', {})
    if not isinstance(providers, dict):
        sys.exit('pi: cannot update models.json: "providers" must be an object')
    # The cache and the user file always carry at least the aliases: a dead
    # gateway must not take the gateway's models away from a launch.
    try:
        served = fetch_ids(curl, provider['baseUrl'], key_env)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError,
            subprocess.SubprocessError):
        if cache.is_file():
            source, fallback = 'cached model list', cache
            selected = json.loads(cache.read_text())['providers']['litellm']['models']
        else:
            source, fallback = 'two profile aliases', gateway_cfg
            selected = [{'id': alias} for alias in aliases]
        print(f'Pi: gateway model discovery failed; using {source} from {fallback}', file=sys.stderr)
    else:
        seen = set(aliases)
        models = [{'id': alias} for alias in aliases]
        for name in served:
            if name not in seen:
                seen.add(name)
                models.append({'id': name})
        selected = models
        # A fresh fetch replaces the cache before it is ever read back.
        write_json(cache, {'providers': {'litellm': dict(provider, models=models)}})
    providers['litellm'] = dict(provider, models=selected)


def main(agent_dir, config, key_env=None, cache=None, curl=None):
    agent_dir = Path(agent_dir).resolve()
    config = Path(config)
    try:
        agent_dir.mkdir(parents=True, exist_ok=True)
        mcp_fragment = json.loads((config / 'mcp.json').read_text())
        settings_fragment = json.loads((config / 'settings.json').read_text())

        mcp_user = load_user(agent_dir / 'mcp.json', 'mcp.json')
        settings_user = load_user(agent_dir / 'settings.json', 'settings.json')
        merge_mcp(mcp_user, mcp_fragment)
        # Skills are not gateway-dependent: Pi loads the `skills` array from
        # user settings on every launch, so our entries are fused in whatever
        # the gateway state, and the subcommand breakage of a --skill flag
        # never happens in the first place.
        merge_skills(settings_user, settings_fragment.get('skills', []))
        write_json(agent_dir / 'mcp.json', mcp_user)
        write_json(agent_dir / 'settings.json', settings_user)

        # Absent gateway defaults ride along with the models: a user who
        # opted out (AI_GATEWAY=0) keeps their settings byte-for-byte.
        gateway_path = config / 'models.json'
        if (gateway_path.is_file() and key_env and cache and curl
                and os.environ.get('AI_GATEWAY', '1') != '0'):
            merge_defaults(settings_user, settings_fragment.get('defaults', {}))
            write_json(agent_dir / 'settings.json', settings_user)
            gateway_fragment = json.loads(gateway_path.read_text())
            models_user = load_user(agent_dir / 'models.json', 'models.json')
            merge_gateway(models_user, gateway_fragment, Path(cache), key_env, curl)
            write_json(agent_dir / 'models.json', models_user)
    except OSError as error:
        print(f'pi: cannot write {agent_dir}: {error}; skipping state updates', file=sys.stderr)


if __name__ == '__main__':
    main(*sys.argv[1:])
