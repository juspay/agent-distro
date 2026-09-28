"""Read one Agent Plugins 1.0.0 directory into a harness-independent description.

Usage: read-plugin.py PLUGIN_DIR > description.json

The description holds what a harness adapter needs and nothing it must
re-validate: the filesystem-resolved root, the manifest's known fields, the
discovered skills with the files each may use, the valid MCP server entries,
and a report for everything skipped or ignored. Reports also go to stderr, so
they appear in the build log. A fatal manifest violation exits non-zero with
a message naming the field.
"""
import ipaddress
import json
import os
import re
import sys
from urllib.parse import urlsplit

# Canonical identifier → Agent Plugins version. Adding a compatible release is
# one entry here; nothing else keys off the identifier.
PLUGIN_SCHEMAS = {'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json': '1.0.0'}
MCP_SCHEMAS = {'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json': '1.0.0'}

NAME = re.compile(r'^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$')
STRING_FIELDS = ['version', 'description', 'homepage', 'repository', 'license']
MANIFEST_FIELDS = {'$schema', 'name', 'author', 'keywords', 'extensions', *STRING_FIELDS}
SERVER_FIELDS = {
    'stdio': {'type', 'command', 'args', 'env', 'cwd'},
    'streamable-http': {'type', 'url', 'headers'},
    'sse': {'type', 'url', 'headers'},
}
CWD_FORM = re.compile(r'^(?:\./|\$\{PLUGIN_ROOT\}(?:/|$)|\$\{PLUGIN_DATA\}(?:/|$))')
PLACEHOLDER = re.compile(r'\$\{PLUGIN_(?:ROOT|DATA)\}')
HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
# RFC 9110 field-value: visible ASCII, obs-text, and inner spaces or tabs.
HEADER_VALUE = re.compile(r'^(?:[!-~\x80-\xff](?:[ \t!-~\x80-\xff]*[!-~\x80-\xff])?)?$')


class Fatal(Exception):
    pass


class Invalid(Exception):
    pass


def is_type(value, kind):
    # bool is an int in Python, but never a JSON string, array or object.
    return isinstance(value, kind) and not isinstance(value, bool)


def within(path, root):
    return path == root or path.startswith(root + os.sep)


def read_manifest(root, report):
    path = os.path.join(root, 'plugin.json')
    if not os.path.lexists(path):
        raise Fatal('plugin.json is missing')
    resolved = os.path.realpath(path)
    if not within(resolved, root):
        raise Fatal('plugin.json resolves outside the plugin root')
    if not os.path.isfile(resolved):
        raise Fatal('plugin.json is not a regular file')
    try:
        with open(resolved, encoding='utf-8') as f:
            manifest = json.load(f)
    except (ValueError, UnicodeDecodeError) as e:
        raise Fatal(f'plugin.json is not valid JSON: {e}')
    if not isinstance(manifest, dict):
        raise Fatal('plugin.json must contain a JSON object')

    if '$schema' not in manifest:
        raise Fatal('`$schema` is missing')
    if not is_type(manifest['$schema'], str) or manifest['$schema'] not in PLUGIN_SCHEMAS:
        raise Fatal(f'`$schema` {json.dumps(manifest["$schema"])} is not a supported Agent Plugins version')
    if 'name' not in manifest:
        raise Fatal('`name` is missing')
    name = manifest['name']
    if not is_type(name, str) or not 1 <= len(name) <= 64 or not NAME.match(name):
        raise Fatal(f'`name` {json.dumps(name)} must be 1-64 characters of a-z, 0-9, "-" and ".", '
                    'start and end alphanumeric, and contain no "--" or ".."')
    for field in STRING_FIELDS:
        if field in manifest and not is_type(manifest[field], str):
            raise Fatal(f'`{field}` must be a string')
    if 'author' in manifest:
        author = manifest['author']
        if not isinstance(author, dict):
            raise Fatal('`author` must be an object')
        for key, value in author.items():
            if key not in ('name', 'email', 'url'):
                raise Fatal(f'`author.{key}` is not an allowed field')
            if not is_type(value, str):
                raise Fatal(f'`author.{key}` must be a string')
    if 'keywords' in manifest:
        keywords = manifest['keywords']
        if not isinstance(keywords, list) or not all(is_type(k, str) for k in keywords):
            raise Fatal('`keywords` must be an array of strings')

    result = {k: v for k, v in manifest.items() if k in MANIFEST_FIELDS and k != 'extensions'}
    for field in manifest:
        if field not in MANIFEST_FIELDS:
            report(f'plugin.json: ignored unknown field `{field}`')
    if 'extensions' in manifest:
        extensions = manifest['extensions']
        if not isinstance(extensions, dict):
            report('plugin.json: ignored `extensions`, which is not an object')
        else:
            # Values are opaque to clients that do not implement the namespace,
            # but the schema still requires each one to be an object (§5.2).
            for namespace, value in extensions.items():
                if not isinstance(value, dict):
                    raise Fatal(f'`extensions.{namespace}` must be an object')
            result['extensions'] = extensions
    return result


def component(root, location, kind, report):
    """The resolved fixed location, or None when absent or unusable (§6.2)."""
    path = os.path.join(root, location)
    if not os.path.lexists(path):
        return None
    resolved = os.path.realpath(path)
    if not within(resolved, root):
        report(f'{location}: ignored, it resolves outside the plugin root')
        return None
    if not (os.path.isdir if kind == 'directory' else os.path.isfile)(resolved):
        report(f'{location}: ignored, it is not a {kind}')
        return None
    return resolved


def skill_files(root, skill, report):
    """Every regular file of a skill that stays inside the plugin root (§4.1)."""
    files = []

    def walk(relative, ancestors):
        directory = os.path.join(root, 'skills', skill, relative)
        for entry in sorted(os.listdir(directory)):
            path = os.path.join(relative, entry) if relative else entry
            resolved = os.path.realpath(os.path.join(directory, entry))
            label = f'skills/{skill}/{path}'
            if not within(resolved, root):
                report(f'{label}: skipped, it resolves outside the plugin root')
            elif os.path.isdir(resolved):
                if resolved in ancestors:
                    report(f'{label}: skipped, it links back to its own ancestor')
                else:
                    walk(path, ancestors | {resolved})
            elif os.path.isfile(resolved):
                files.append(path)
            else:
                report(f'{label}: skipped, it is not a regular file or directory')

    walk('', {os.path.realpath(os.path.join(root, 'skills', skill))})
    return files


def read_skills(root, report):
    skills_dir = component(root, 'skills', 'directory', report)
    if skills_dir is None:
        return {}
    skills = {}
    for entry in sorted(os.listdir(skills_dir)):
        child = os.path.realpath(os.path.join(root, 'skills', entry))
        if not within(child, root):
            report(f'skills/{entry}: skipped, it resolves outside the plugin root')
            continue
        # Exactly `SKILL.md`, even on a case-insensitive filesystem (§7.1).
        if not os.path.isdir(child) or 'SKILL.md' not in os.listdir(child):
            continue
        skill_md = os.path.realpath(os.path.join(child, 'SKILL.md'))
        if not within(skill_md, root):
            report(f'skills/{entry}: skipped, its SKILL.md resolves outside the plugin root')
        elif os.path.isfile(skill_md):
            skills[entry] = skill_files(root, entry, report)
    return skills


def expand_root(value, root):
    return value.replace('${PLUGIN_ROOT}', root)


def check_process_string(value, field):
    if not is_type(value, str):
        raise Invalid(f'`{field}` must be a string')
    # A process argument or environment entry cannot carry NUL.
    if '\0' in value:
        raise Invalid(f'`{field}` contains a NUL character')


def read_stdio(server, root):
    command = server.get('command')
    check_process_string(command, 'command')
    if not command:
        raise Invalid('`command` is empty')
    if command.startswith('./'):
        if not within(os.path.realpath(os.path.join(root, command)), root):
            raise Invalid('`command` resolves outside the plugin root')
    elif '/' in command:
        raise Invalid('`command` must be a bare executable name or a path beginning with "./"')

    args = server.get('args', [])
    if not isinstance(args, list):
        raise Invalid('`args` must be an array of strings')
    for arg in args:
        check_process_string(arg, 'args[]')

    env = server.get('env', {})
    if not isinstance(env, dict):
        raise Invalid('`env` must be an object of strings')
    for key, value in env.items():
        if key in ('PLUGIN_ROOT', 'PLUGIN_DATA'):
            raise Invalid(f'`env` must not set {key}; the client supplies it')
        # POSIX environment names cannot be empty or contain "=" or NUL.
        if not key or '=' in key or '\0' in key:
            raise Invalid(f'`env` name {json.dumps(key)} cannot be an environment variable')
        check_process_string(value, f'env.{key}')

    result = {'type': 'stdio', 'command': command, 'args': args, 'env': env}
    if 'cwd' in server:
        cwd = server['cwd']
        check_process_string(cwd, 'cwd')
        if not CWD_FORM.match(cwd):
            raise Invalid('`cwd` must begin with "./", "${PLUGIN_ROOT}" or "${PLUGIN_DATA}"')
        base = 'data' if cwd.startswith('${PLUGIN_DATA}') else 'root'
        # PLUGIN_DATA is known only at launch, where the launcher checks
        # containment again; a root-based cwd is checked here too (§7.2.1).
        if base == 'root' and '${PLUGIN_DATA}' not in cwd:
            expanded = expand_root(cwd, root)
            target = os.path.join(root, expanded) if cwd.startswith('./') else expanded
            if not within(os.path.realpath(target), root):
                raise Invalid('`cwd` resolves outside the plugin root')
        result['cwd'] = cwd
        result['cwdBase'] = base
    return result


def read_remote(server, kind):
    url = server.get('url')
    if not is_type(url, str) or not url:
        raise Invalid('`url` must be a non-empty string')
    if any(c.isspace() or ord(c) < 0x20 or ord(c) == 0x7f for c in url):
        raise Invalid('`url` contains whitespace or control characters')
    try:
        parts = urlsplit(url)
        host = parts.hostname
        parts.port  # Raises on an invalid port.
    except ValueError as e:
        raise Invalid(f'`url` is not a valid URL: {e}')
    if parts.scheme not in ('http', 'https') or not host:
        raise Invalid('`url` must be an absolute http or https URL')
    if '@' in parts.netloc:
        raise Invalid('`url` must not contain user information')
    if '#' in url:
        raise Invalid('`url` must not contain a fragment')
    if parts.scheme == 'http' and not is_loopback(host):
        raise Invalid('`url` must use https unless its host is localhost or a loopback address')

    headers = server.get('headers', {})
    if not isinstance(headers, dict):
        raise Invalid('`headers` must be an object of strings')
    seen = set()
    for name, value in headers.items():
        if not HEADER_NAME.match(name):
            raise Invalid(f'header name {json.dumps(name)} is not a valid HTTP field name')
        if name.lower() in seen:
            raise Invalid(f'header {json.dumps(name)} is repeated under different casing')
        seen.add(name.lower())
        if not is_type(value, str) or not HEADER_VALUE.match(value):
            raise Invalid(f'header {json.dumps(name)} does not have a valid HTTP field value')
    return {'type': kind, 'url': url, 'headers': headers}


def is_loopback(host):
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def read_mcp(root, version, report):
    path = component(root, 'mcp.json', 'regular file', report)
    if path is None:
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            config = json.load(f)
    except (ValueError, UnicodeDecodeError) as e:
        report(f'mcp.json: MCP disabled, it is not valid JSON: {e}')
        return {}
    problem = None
    if not isinstance(config, dict):
        problem = 'it is not a JSON object'
    elif not is_type(config.get('$schema'), str) or config['$schema'] not in MCP_SCHEMAS:
        problem = f'`$schema` {json.dumps(config.get("$schema"))} is not a supported Agent Plugins version'
    elif MCP_SCHEMAS[config['$schema']] != version:
        problem = f'it targets Agent Plugins {MCP_SCHEMAS[config["$schema"]]}, but plugin.json targets {version}'
    elif not isinstance(config.get('mcpServers'), dict):
        problem = '`mcpServers` must be an object'
    elif set(config) - {'$schema', 'mcpServers'}:
        problem = f'unknown top-level fields {sorted(set(config) - {"$schema", "mcpServers"})}'
    if problem:
        report(f'mcp.json: MCP disabled, {problem}')
        return {}

    servers = {}
    for name, server in config['mcpServers'].items():
        try:
            if not isinstance(server, dict):
                raise Invalid('it is not an object')
            kind = server.get('type')
            if kind not in SERVER_FIELDS:
                raise Invalid(f'unknown `type` {json.dumps(kind)}')
            unknown = sorted(set(server) - SERVER_FIELDS[kind])
            if unknown:
                raise Invalid(f'unknown fields for type {kind}: {unknown}')
            servers[name] = read_stdio(server, root) if kind == 'stdio' else read_remote(server, kind)
        except Invalid as e:
            report(f'mcp.json: server {json.dumps(name)} skipped, {e}')
    return servers


def main(plugin):
    reports = []

    def report(message):
        reports.append(message)
        print(f'{plugin}: {message}', file=sys.stderr)

    root = os.path.realpath(plugin)
    try:
        if not os.path.isdir(root):
            raise Fatal('the plugin is not a directory')
        manifest = read_manifest(root, report)
    except Fatal as e:
        print(f'{plugin}: invalid Agent Plugin: {e}', file=sys.stderr)
        return 1
    version = PLUGIN_SCHEMAS[manifest['$schema']]
    json.dump({
        'root': root,
        'version': version,
        'manifest': manifest,
        'skills': read_skills(root, report),
        'mcpServers': read_mcp(root, version, report),
        'reports': reports,
    }, sys.stdout, indent=2)
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
