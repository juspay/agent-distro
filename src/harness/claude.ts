/**
 * Translate one plugin description into a Claude Code plugin directory.
 *
 * Usage: node claude.ts OUT ARGS_JSON
 *
 * Each part reads the validated description, never the plugin's own JSON, so a
 * Claude Code format change touches this file and a spec change none. Skills are
 * only the discovered ones, with only their in-root files, materialized: Claude
 * rejects component symlinks outside its root.
 *
 * Claude Code runs a plugin's stdio server in its own launch directory and
 * applies its own variable expansion, neither of which is the Agent Plugins
 * contract. So each stdio server gets a launcher script that sets up the spec's
 * environment, working directory and placeholders itself, and Claude Code is
 * handed only that script. Remote servers cannot be wrapped and are mapped to
 * Claude Code's transport names.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launcher } from '../plugin/launcher.ts';
import { copySkills, fileName, launchable, readDescription } from '../plugin/resources.ts';

const MANIFEST_FIELDS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
const TRANSPORTS = { 'streamable-http': 'http', sse: 'sse' } as const;

type ClaudeServer =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string };

function main(out: string, argsPath: string) {
  const args: { bash: string; env: string; description: string } = JSON.parse(readFileSync(argsPath, 'utf8'));
  const description = readDescription(args.description);
  mkdirSync(join(out, '.claude-plugin'), { recursive: true });
  const manifest: Record<string, unknown> = {};
  for (const key of MANIFEST_FIELDS) {
    if (description.manifest[key] != null) manifest[key] = description.manifest[key];
  }
  writeFileSync(join(out, '.claude-plugin/plugin.json'), JSON.stringify(manifest, null, 2));
  mkdirSync(join(out, 'skills'));
  copySkills(description, join(out, 'skills'));
  const servers: Record<string, ClaudeServer> = {};
  Object.entries(description.mcpServers).forEach(([name, server], index) => {
    if (server.type !== 'stdio') {
      const headers = Object.keys(server.headers).length ? { headers: server.headers } : {};
      servers[name] = { type: TRANSPORTS[server.type], url: server.url, ...headers };
      return;
    }
    if (!launchable(description, server)) {
      process.stderr.write(`${description.root}: mcp.json: server ${JSON.stringify(name)} skipped, `
        + 'Claude Code adapter cannot launch a command containing "="\n');
      return;
    }
    const script = join(out, 'mcp-launchers', `${index}-${fileName(name)}`);
    mkdirSync(join(out, 'mcp-launchers'), { recursive: true });
    // Owner bits suffice: Nix canonicalizes store files to 0555/0444 on
    // registration, so the launcher is executable by every user.
    writeFileSync(script, launcher(description, name, server, args.bash, args.env, 'CLAUDE_PLUGIN_DATA'),
      { flag: 'wx', mode: 0o700 });
    servers[name] = { type: 'stdio', command: script };
  });
  if (Object.keys(servers).length) {
    writeFileSync(join(out, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  }
}

main(process.argv[2], process.argv[3]);
