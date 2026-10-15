/**
 * Translate validated plugins once; OpenCode merges this file at launch.
 *
 * Usage: node opencode.ts OUT ARGS_JSON
 *
 * The session config names the plugins that discover the profile's models
 * (the vendored opencode-plugin-litellm) for every launch; the profile's
 * `settings.opencode` is merged over it at launch, by
 * src/harness/opencode-settings.ts, since the profile in effect is only known
 * then.
 *
 * At launch, src/plugin/launch.ts uses `adapter` to add AGENT_DISTRO_PLUGINS to
 * the session config.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LaunchError, readCached, writeAddressed, type Adapter, type Report } from '../plugin/launch.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, launchable, writeLauncher } from '../plugin/resources.ts';

type Args = { bash: string; env: string; plugin: string };
type Server = { type: 'remote'; url: string; headers: Record<string, string> } | { type: 'local'; command: string[] };
type Fragment = { skills: string | null; servers: Record<string, Server> };
type Inputs = { bash: string; env: string };

/** One plugin's skills directory and servers, materialized under `out`. */
export function pluginFragment(description: Description, out: string, { bash, env }: Inputs, report: Report): Fragment {
  const skills = copySkills(description, join(out, 'skills', description.manifest.name));
  const servers: Record<string, Server> = {};
  Object.entries(description.mcpServers).forEach(([name, server], index) => {
    if (server.type !== 'stdio') {
      servers[name] = { type: 'remote', url: server.url, headers: server.headers };
      return;
    }
    if (!launchable(description, server)) {
      report(`mcp.json: server ${JSON.stringify(name)} skipped, OpenCode adapter cannot launch a command containing "="`);
      return;
    }
    servers[name] = { type: 'local', command: [writeLauncher(description, name, server, out, index, bash, env)] };
  });
  return { skills, servers };
}

const isFragment = (value: unknown): value is Fragment => typeof value === 'object' && value !== null
  && 'skills' in value && (value.skills === null || typeof value.skills === 'string')
  && 'servers' in value && typeof value.servers === 'object' && value.servers !== null;

/** Fail on a server name two plugins declare: OpenCode keeps one silently. */
function claim(owners: Record<string, string>, description: Description) {
  const plugin = description.manifest.name;
  for (const name of Object.keys(description.mcpServers)) {
    if (Object.hasOwn(owners, name)) {
      throw new LaunchError(`MCP server ${JSON.stringify(name)} is declared by both `
        + `plugins ${JSON.stringify(owners[name])} and ${JSON.stringify(plugin)}`);
    }
    owners[name] = plugin;
  }
}

function main(out: string, argsPath: string) {
  const args: Args = JSON.parse(readFileSync(argsPath, 'utf8'));
  mkdirSync(out, { recursive: true });
  // No profile contributes to the build any more: the session config carries
  // the plugin every launch needs, and the plugins of the profiles in effect
  // are merged into it at launch (`adapter.launch`), which is why `skills` and
  // `mcp.servers` start empty here.
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    // The vendored opencode-plugin-litellm, in the base config of every
    // launch: it registers the `litellm` provider when a configuration names
    // it or LITELLM_BASE_URL is set, and health-probes otherwise.
    plugins: [args.plugin],
    skills: [],
    mcp: { servers: {} },
  };
  writeFileSync(join(out, 'opencode.json'), JSON.stringify(config, null, 2));
}

type LaunchArgs = Inputs & { name: string; config: string };
/** The session config the launcher writes, and this adapter merges into. */
type Session = { skills: string[]; mcp: { servers: Record<string, Server> } };

/**
 * At launch: the launcher's session config with every plugin merged into it,
 * written to the cache by content. Prints its path, for OPENCODE_CONFIG.
 */
export const adapter: Adapter<LaunchArgs, Inputs> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, inputs, report) =>
    writeFileSync(join(out, 'fragment.json'), JSON.stringify(pluginFragment(description, out, inputs, report))),
  launch: ({ args, plugins, cache }) => {
    const base = join(args.config, 'opencode.json');
    if (!plugins.length) return base;
    const config = JSON.parse(readFileSync(base, 'utf8')) as Session;
    const skills = config.skills;
    const servers = config.mcp.servers;
    const owners: Record<string, string> = {};
    for (const plugin of plugins) {
      claim(owners, plugin.description);
      const fragment = readCached(join(plugin.translation, 'fragment.json'), isFragment);
      if (fragment.skills) skills.push(fragment.skills);
      Object.assign(servers, fragment.servers);
    }
    return writeAddressed(join(cache!, args.name, 'launch'), config);
  },
};

if (import.meta.main) main(process.argv[2], process.argv[3]);
