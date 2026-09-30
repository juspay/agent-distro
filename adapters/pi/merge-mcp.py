"""Merge our MCP server entries into the user's mcp.json, atomically.

Pi reads MCP servers only from `~/.pi/agent/mcp.json` (or the directory
PI_CODING_AGENT_DIR names), and nothing per-launch can shadow them: the store
paths our entries name change between builds, so they are rewritten on every
launch. Entries are keyed by server name; ours replace ours, other entries are
untouched. Invalid JSON aborts the launch without writing, like OMP's
config.yml handling.

Usage: merge-mcp.py AGENT_DIR mcp.json
"""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def main(agent_dir, fragment_path):
    agent_dir = Path(agent_dir)
    target = agent_dir / 'mcp.json'
    fragment = json.loads(Path(fragment_path).read_text())
    try:
        merged = json.loads(target.read_text()) if target.exists() else {}
    except (ValueError, UnicodeDecodeError) as error:
        sys.exit(f'pi: cannot merge MCP servers: {target} is not valid JSON: {error}')
    if not isinstance(merged, dict):
        sys.exit(f'pi: cannot merge MCP servers: {target} must contain a JSON object')
    servers = merged.get('mcpServers')
    if servers is None:
        servers = merged['mcpServers'] = {}
    elif not isinstance(servers, dict):
        sys.exit(f'pi: cannot merge MCP servers: {target} must contain an "mcpServers" object')
    # Our servers replace previous builds' entries of the same names; the
    # user's own servers are never touched.
    servers.update(fragment['mcpServers'])
    agent_dir.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix='.mcp-', dir=agent_dir)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(merged, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    main(*sys.argv[1:])