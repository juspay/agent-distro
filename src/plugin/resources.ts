/** Materialize reader-approved resources shared by the adapters. */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Report } from './launch.ts';
import type { Description, StdioServer } from './read.ts';
import { launcher } from './launcher.ts';

/** The two programs every generated launcher runs through. */
export type Inputs = { bash: string; env: string };

export function readDescription(path: string): Description {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Copy each approved skill file, links followed; the directory, or null if none. */
export function copySkills(description: Description, skills: string): string | null {
  for (const [name, files] of Object.entries(description.skills)) {
    for (const file of files) {
      const target = join(skills, name, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(description.root, 'skills', name, file), target);
    }
  }
  return Object.keys(description.skills).length ? skills : null;
}

/** A server name as a file name. */
export const fileName = (name: string) => name.replace(/[^A-Za-z0-9._-]/gu, '_');

/** `env` reads its first argument without "=" as the command. */
export const launchable = (description: Description, server: StdioServer) =>
  !server.command.includes('=') && !description.root.includes('=');

export function writeLauncher(
  description: Description, name: string, server: StdioServer, root: string, index: number, bash: string, env: string,
): string {
  const script = join(root, 'bin', `${description.manifest.name}-${index}-${fileName(name)}`);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, launcher(description, name, server, bash, env));
  chmodSync(script, 0o700);
  return script;
}

/**
 * Write `description` as an Agent Plugins directory whose stdio servers run
 * through generated launchers, for the harnesses that read a plugin's `mcp.json`
 * themselves: OMP and Codex. The working directory that buys them is
 * src/plugin/launcher.ts's; a remote server has none and is written as it is.
 *
 * `plugin.json`, `skills/` and `mcp.json` are the whole Agent Plugins 1.0.0
 * surface a harness may read from a plugin directory — v1 defines skills and MCP
 * servers as its component types, and puts commands, hooks, agents and rules
 * outside it — and these two read exactly that: an original directory's other
 * files, kolu's `.claude-plugin/` among them, were never read by either.
 */
export function writeSpecPlugin(description: Description, out: string, { bash, env }: Inputs, report: Report) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'plugin.json'), JSON.stringify(description.manifest, null, 2) + '\n');
  copySkills(description, join(out, 'skills'));
  const servers: Record<string, unknown> = {};
  Object.entries(description.mcpServers).forEach(([name, server], index) => {
    if (server.type !== 'stdio') {
      servers[name] = { type: server.type, url: server.url, headers: server.headers };
      return;
    }
    if (!launchable(description, server)) {
      report(`mcp.json: server ${JSON.stringify(name)} skipped, the adapter cannot launch a command containing "="`);
      return;
    }
    // Plugin-relative, never absolute: `command` is a single executable token
    // that MUST be a bare name or a `./` path resolved against the plugin root
    // (§7.2.1) — a client drops a server whose command is anything else.
    const script = writeLauncher(description, name, server, out, index, bash, env);
    servers[name] = { type: 'stdio', command: './' + relative(out, script), args: [] };
  });
  writeFileSync(join(out, 'mcp.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: servers,
  }, null, 2) + '\n');
}
