/**
 * Translate validated plugins once; OpenCode merges this file at launch.
 *
 * Usage: node opencode.ts OUT ARGS_JSON
 *
 * One adapter serves both config schemas: `v1` for OpenCode and `v2` for
 * OpenCode v2, which differ only in where skills, servers and the provider go.
 * At launch, src/plugin/launch.ts uses `adapter` to add AGENT_DISTRO_PLUGINS to
 * the session config.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LaunchError, writeAddressed, type Adapter, type ProfileEntry, type Report } from '../plugin/launch.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, launchable, readDescription, writeLauncher } from '../plugin/resources.ts';
import type { Gateway } from '../gateway/models.ts';

type Args = { schema: string; bash: string; env: string; gateway: Gateway | null; descriptions: string[] };
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

/** Where each schema keeps skill paths and servers. */
function sections(config: Record<string, any>, schema: string): { skills: string[]; servers: Record<string, Server> } {
  return schema === 'v2'
    ? { skills: config.skills, servers: config.mcp.servers }
    : { skills: config.skills.paths, servers: config.mcp };
}

/** Fail on a server name two plugins declare: OpenCode keeps one silently. */
function claim(owners: Record<string, string>, description: Description) {
  const plugin = description.manifest.name;
  for (const name of Object.keys(description.mcpServers)) {
    if (Object.hasOwn(owners, name)) {
      throw new LaunchError(`OpenCode: MCP server ${JSON.stringify(name)} is declared by both `
        + `plugins ${JSON.stringify(owners[name])} and ${JSON.stringify(plugin)}`);
    }
    owners[name] = plugin;
  }
}

function main(out: string, argsPath: string) {
  const args: Args = JSON.parse(readFileSync(argsPath, 'utf8'));
  const { schema, gateway } = args;
  if (schema !== 'v1' && schema !== 'v2') throw new Error(`Unknown OpenCode schema: ${schema}`);
  const owners: Record<string, string> = {};
  mkdirSync(join(out, 'bin'), { recursive: true });
  const skillsPaths: string[] = [];
  const servers: Record<string, Server> = {};
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    skills: schema === 'v2' ? skillsPaths : { paths: skillsPaths },
    mcp: schema === 'v2' ? { servers } : servers,
  };
  for (const path of args.descriptions) {
    const description = readDescription(path);
    try {
      claim(owners, description);
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      process.stderr.write(error.message + '\n');
      process.exit(1);
    }
    const fragment = pluginFragment(description, out, args,
      (message) => process.stderr.write(`${description.root}: ${message}\n`));
    if (fragment.skills) skillsPaths.push(fragment.skills);
    Object.assign(servers, fragment.servers);
  }
  writeFileSync(join(out, 'opencode.json'), JSON.stringify(config, null, 2));
  if (gateway !== null) {
    const models = Object.fromEntries(Object.values(gateway.models).map((model) => [model, { name: model }]));
    const url = gateway.url.replace(/\/+$/, '') + '/v1';
    if (schema === 'v2') {
      config.providers = {
        litellm: {
          name: 'LiteLLM', models, env: [gateway.keyEnv],
          package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: url },
        },
      };
    } else {
      config.provider = {
        litellm: {
          name: 'LiteLLM', models, npm: '@ai-sdk/openai-compatible',
          options: { baseURL: url, apiKey: '{env:' + gateway.keyEnv + '}' },
        },
      };
      config.small_model = 'litellm/' + gateway.models.small;
    }
    config.model = 'litellm/' + gateway.models.large;
    writeFileSync(join(out, 'gateway.json'), JSON.stringify(config, null, 2));
  }
}

type LaunchArgs = Inputs & { schema: string; name: string; config: string; profile: ProfileEntry[] };

/**
 * At launch: the session config (the launcher's own, gateway included, as
 * BASE) without the replaced profile plugins and with the variable's, written
 * to the cache by content. Prints its path, for OPENCODE_CONFIG.
 */
export const adapter: Adapter<LaunchArgs> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, args, report) =>
    writeFileSync(join(out, 'fragment.json'), JSON.stringify(pluginFragment(description, out, args, report))),
  launch: ({ args, kept, replaced, plugins, rest, cache }) => {
    const config = JSON.parse(readFileSync(rest[0], 'utf8'));
    const { skills, servers } = sections(config, args.schema);
    const owners: Record<string, string> = {};
    for (const plugin of kept) claim(owners, plugin.description);
    for (const plugin of replaced) {
      const index = skills.indexOf(join(args.config, 'skills', plugin.name));
      if (index >= 0) skills.splice(index, 1);
      for (const name of Object.keys(plugin.description.mcpServers)) delete servers[name];
    }
    for (const plugin of plugins) {
      claim(owners, plugin.description);
      const fragment: Fragment = JSON.parse(readFileSync(join(plugin.translation, 'fragment.json'), 'utf8'));
      if (fragment.skills) skills.push(fragment.skills);
      Object.assign(servers, fragment.servers);
    }
    return writeAddressed(join(cache, args.name, 'launch'), config);
  },
};

if (import.meta.main) main(process.argv[2], process.argv[3]);
