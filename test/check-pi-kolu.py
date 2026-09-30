import re
import shutil
from pi_support import *

# `pi mcp list --json` is the no-model way to see MCP server states, but a
# global option before a subcommand breaks Pi's option parsing: the adapter
# launcher always prepends --skill, so `pi mcp list --json` through it fails
# with "Unknown option: --json". Run the raw binary instead — it reads the
# same merged mcp.json, which is what we are asserting.
def raw_pi():
    launcher = Path(shutil.which('pi')).read_text()  # bundle → adapter launcher
    inner = re.search(r'^exec (\S+) "\$@"', launcher, re.MULTILINE).group(1)
    adapter = Path(inner).read_text()
    return re.search(r'^exec (\S+) --skill', adapter, re.MULTILINE).group(1)

run('--version')  # the launcher's merge writes our servers into mcp.json
listing = json.loads(run('mcp', 'list', '--json', launcher=raw_pi()).stdout)
servers = {server['name']: server for server in listing['servers']}
assert 'kolu' in servers, servers
assert servers['kolu']['state'] == 'connected', servers['kolu']
assert 'nixos' in servers, servers  # juspay's mcp-nixos server, via its launcher.
assert 'user-server' not in servers  # untouched by our merge.