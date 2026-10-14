/**
 * Translate validated plugins once; OpenCode merges this file at launch.
 *
 * Usage: node opencode.ts OUT ARGS_JSON
 *
 * The profile's gateway is added at launch, by src/gateway/config.ts with
 * `withGateway`, since the profile in effect is only known then.
 *
 * At launch, src/plugin/launch.ts uses `adapter` to add AGENT_DISTRO_PLUGINS to
 * the session config.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.ts';
import { LaunchError, readCached, writeAddressed, type Adapter, type ProfileEntry, type Report } from '../plugin/launch.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, launchable, readDescription, writeLauncher } from '../plugin/resources.ts';
import type { Gateway } from '../gateway/models.ts';

type Args = { bash: string; env: string; descriptions: string[] };
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
  const owners: Record<string, string> = {};
  mkdirSync(join(out, 'bin'), { recursive: true });
  const skillsPaths: string[] = [];
  const servers: Record<string, Server> = {};
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    skills: skillsPaths,
    mcp: { servers },
  };
  for (const path of args.descriptions) {
    const description = readDescription(path);
    try {
      claim(owners, description);
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      log.opencode.error(error.message);
      process.exit(1);
    }
    const fragment = pluginFragment(description, out, args,
      (message) => log.opencode.warn(`${description.root}: ${message}`));
    if (fragment.skills) skillsPaths.push(fragment.skills);
    Object.assign(servers, fragment.servers);
  }
  writeFileSync(join(out, 'opencode.json'), JSON.stringify(config, null, 2));
}

/**
 * `config` with the profile's gateway as its provider, its default models and
 * the plugin that discovers the models it serves; at launch, by
 * gateway/config.ts.
 */
export function withGateway(config: Record<string, unknown>, gateway: Gateway, plugin: string): Record<string, unknown> {
  const url = gateway.url.replace(/\/+$/, '') + '/v1';
  // No key: the plugin reads LITELLM_API_KEY, which the launcher exports.
  return {
    ...config,
    // OpenCode concatenates `plugins` across config files, so a user's own
    // survive this document's entry.
    plugins: [plugin],
    providers: {
      litellm: {
        name: 'LiteLLM',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: url },
      },
    },
    // The small model has no `small_model` in this schema; upstream's
    // migration puts it on the hidden title agent.
    agents: { title: { model: 'litellm/' + gateway.models.small } },
    model: 'litellm/' + gateway.models.large,
  };
}

type LaunchArgs = Inputs & { name: string; config: string; profile: ProfileEntry[] };

/**
 * At launch: the launcher's session config, before any gateway, without the
 * replaced profile plugins and with the variable's, written
 * to the cache by content. Prints its path, for OPENCODE_CONFIG.
 */
export const adapter: Adapter<LaunchArgs, ProfileEntry, Inputs> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, inputs, report) =>
    writeFileSync(join(out, 'fragment.json'), JSON.stringify(pluginFragment(description, out, inputs, report))),
  launch: ({ args, kept, replaced, plugins, cache }) => {
    const base = join(args.config, 'opencode.json');
    if (!plugins.length && !replaced.length) return base;
    const config = JSON.parse(readFileSync(base, 'utf8'));
    const { skills, servers } = config as { skills: string[]; servers: Record<string, Server> };
    const owners: Record<string, string> = {};
    for (const plugin of kept) claim(owners, plugin.description);
    for (const plugin of replaced) {
      const index = skills.indexOf(join(args.config, 'skills', plugin.name));
      if (index >= 0) skills.splice(index, 1);
      for (const name of Object.keys(plugin.description.mcpServers)) delete servers[name];
    }
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
