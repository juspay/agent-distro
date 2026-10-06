/**
 * Translate one plugin description into a Claude Code plugin directory.
 *
 * Usage: node claude.ts OUT ARGS_JSON
 *
 * At launch, src/plugin/launch.ts uses `adapter` to write the same root for a
 * plugin on AGENT_DISTRO_PLUGINS into its cache.
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
import type { Adapter, ProfileEntry, Report } from '../plugin/launch.ts';
import { launcher, shellQuote } from '../plugin/launcher.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, fileName, launchable, readDescription } from '../plugin/resources.ts';

const MANIFEST_FIELDS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
const TRANSPORTS = { 'streamable-http': 'http', sse: 'sse' } as const;

type ClaudeServer =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string };

type Inputs = { bash: string; env: string };

/** Write `description` as a Claude Code plugin root at `out`. */
export function writePlugin(description: Description, out: string, { bash, env }: Inputs, report: Report) {
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
      report(`mcp.json: server ${JSON.stringify(name)} skipped, `
        + 'Claude Code adapter cannot launch a command containing "="');
      return;
    }
    const script = join(out, 'mcp-launchers', `${index}-${fileName(name)}`);
    mkdirSync(join(out, 'mcp-launchers'), { recursive: true });
    // Owner bits suffice: Nix canonicalizes store files to 0555/0444 on
    // registration, so the launcher is executable by every user.
    writeFileSync(script, launcher(description, name, server, bash, env, 'CLAUDE_PLUGIN_DATA'),
      { flag: 'wx', mode: 0o700 });
    servers[name] = { type: 'stdio', command: script };
  });
  if (Object.keys(servers).length) {
    writeFileSync(join(out, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  }
}

type LaunchArgs = Inputs & { profile: (ProfileEntry & { dir: string })[] };

/**
 * At launch: the `--plugin-dir` arguments for every plugin, as shell words,
 * replacing the launcher's own. A plugin on the variable is one more
 * session-only plugin directory.
 */
export const adapter: Adapter<LaunchArgs, LaunchArgs['profile'][number]> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, args, report) => writePlugin(description, out, args, report),
  launch: ({ kept, plugins }) => [
    ...kept.map((plugin) => plugin.entry.dir),
    ...plugins.map((plugin) => plugin.translation),
  ].flatMap((dir) => ['--plugin-dir', shellQuote(dir)]).join(' '),
};

if (import.meta.main) {
  const [out, argsPath] = process.argv.slice(2);
  const args: Inputs & { description: string } = JSON.parse(readFileSync(argsPath, 'utf8'));
  const description = readDescription(args.description);
  writePlugin(description, out, args, (message) => process.stderr.write(`${description.root}: ${message}\n`));
}
