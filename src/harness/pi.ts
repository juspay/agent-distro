/**
 * Pi's plugin protocol: resources go into its user JSON files, never global CLI
 * options, because Pi's subcommands reject prepended flags.
 *
 * Usage: node pi.ts write-config OUT ARGS_JSON
 *        node pi.ts merge-state --check|--merge AGENT_DIR FRAGMENT_JSON [GATEWAY_JSON]
 *
 * write-config translates plugins once, at build time. merge-state runs at
 * launch: ours replace ours, user entries stay untouched, and invalid JSON
 * aborts before any write. --check stages every write without replacing a file
 * and exits 2 when the directory cannot be written.
 *
 * AGENT_DISTRO_PLUGINS reaches Pi the same way: src/plugin/launch.ts uses
 * `adapter` to write a fragment with the variable's plugins, and merge-state
 * records what that launch added in RECORD, beside Pi's files. The next merge
 * removes whatever is still as recorded, so they last one launch.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Gateway } from '../gateway/models.ts';
import { LaunchError, writeAddressed, type Adapter, type ProfileEntry, type Report } from '../plugin/launch.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, launchable, readDescription, writeLauncher } from '../plugin/resources.ts';
import { isSystemError, realpath, writeTemporary } from '../util.ts';

type Servers = Record<string, Record<string, unknown>>;
/**
 * What merge-state applies. `launch` names the parts that come from
 * AGENT_DISTRO_PLUGINS, and `replaces` the profile servers they displace.
 */
type Fragment = {
  skills: string[];
  mcpServers: Servers;
  launch?: { skills: string[]; mcpServers: string[]; replaces: Servers };
};
type GatewayConfig = { providers: { litellm: unknown }; defaultProvider: string; defaultModel: string };
type JsonObject = Record<string, any>;
type Inputs = { bash: string; env: string };
/** What the last launch-time merge added, so the next one can take it back. */
type LaunchRecord = { skills: string[]; mcpServers: Servers };

export const RECORD = '.agent-distro-launch.json';

class Invalid extends Error {}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One plugin's skill directory and servers, materialized under `out`. */
export function pluginFragment(description: Description, out: string, { bash, env }: Inputs, report: Report) {
  const skills = copySkills(description, join(out, 'skills', description.manifest.name));
  const servers: Servers = {};
  Object.entries(description.mcpServers).forEach(([name, server], index) => {
    let reason: string | null = null;
    if (server.type === 'sse') {
      reason = 'Pi does not support SSE';
    } else if (server.type === 'stdio') {
      if (!launchable(description, server)) {
        reason = 'Pi adapter cannot launch a command containing "="';
      } else {
        servers[name] = { command: writeLauncher(description, name, server, out, index, bash, env) };
      }
    } else {
      servers[name] = { url: server.url, headers: server.headers };
    }
    if (reason) report(`mcp.json: server ${JSON.stringify(name)} skipped, ${reason}`);
  });
  return { skills: skills ? [skills] : [], mcpServers: servers };
}

/** Fail on a server name two plugins declare. */
function claim(owners: Record<string, string>, description: Description, Failure: new (message: string) => Error = Invalid) {
  const plugin = description.manifest.name;
  for (const name of Object.keys(description.mcpServers)) {
    if (Object.hasOwn(owners, name)) {
      throw new Failure(`Pi: MCP server ${JSON.stringify(name)} is declared by both `
        + `plugins ${JSON.stringify(owners[name])} and ${JSON.stringify(plugin)}`);
    }
    owners[name] = plugin;
  }
}

export function writeConfig(out: string, argsPath: string) {
  const args: Inputs & { gateway: Gateway | null; descriptions: string[] } =
    JSON.parse(readFileSync(argsPath, 'utf8'));
  const { gateway } = args;
  mkdirSync(out, { recursive: true });
  const skills: string[] = [];
  const servers: Servers = {};
  const owners: Record<string, string> = {};
  for (const path of args.descriptions) {
    const description = readDescription(path);
    claim(owners, description);
    const fragment = pluginFragment(description, out, args,
      (message) => process.stderr.write(`${description.root}: ${message}\n`));
    skills.push(...fragment.skills);
    Object.assign(servers, fragment.mcpServers);
  }
  writeFileSync(join(out, 'config.json'), JSON.stringify({ skills, mcpServers: servers }, null, 2));
  if (gateway !== null) {
    const config: GatewayConfig = {
      providers: {
        litellm: {
          baseUrl: gateway.url.replace(/\/+$/, '') + '/v1',
          api: 'openai-completions',
          apiKey: '$' + gateway.keyEnv,
          models: [...new Set(Object.values(gateway.models))].map((id) => ({ id })),
        },
      },
      defaultProvider: 'litellm',
      defaultModel: gateway.models.large,
    };
    writeFileSync(join(out, 'gateway.json'), JSON.stringify(config, null, 2));
  }
}

function readObject(path: string): JsonObject {
  const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!isObject(data)) throw new Invalid(`${path} must contain a JSON object`);
  return data;
}

function readRecord(path: string): LaunchRecord {
  const record = readObject(path);
  const skills = record.skills ?? [];
  const servers = record.mcpServers ?? {};
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string') || !isObject(servers)) {
    throw new Invalid(`${path} is not a launch record`);
  }
  return { skills, mcpServers: servers };
}

type Changes = { writes: Map<string, JsonObject>; remove: string | null };

/** The files to write or remove; none of them touched yet. */
function prepare(directory: string, fragment: Fragment, gateway: GatewayConfig | null): Changes {
  const names = ['mcp', 'settings', ...(gateway ? ['models'] : [])];
  const paths = Object.fromEntries(names.map((name) => [name, realpath(join(directory, `${name}.json`))]));
  // Validate every input before any write, including files another merge owns.
  const original = Object.fromEntries(names.map((name) => [name, readObject(paths[name])]));
  const recordPath = realpath(join(directory, RECORD));
  const previous = readRecord(recordPath);
  const data: Record<string, JsonObject> = structuredClone(original);
  const servers = Object.hasOwn(data.mcp, 'mcpServers') ? data.mcp.mcpServers : {};
  if (!isObject(servers)) throw new Invalid('mcpServers must be a JSON object');
  // Take back what the last launch added and what it displaced, unless the
  // user has changed it since; the fragment puts back what is still wanted.
  const remaining = { ...servers };
  const undo = { ...previous.mcpServers, ...fragment.launch?.replaces };
  for (const [name, entry] of Object.entries(undo)) {
    if (isDeepStrictEqual(remaining[name], entry)) delete remaining[name];
  }
  const merged = { ...remaining, ...fragment.mcpServers };
  if (!isDeepStrictEqual(merged, servers)) data.mcp.mcpServers = merged;
  const skills = Object.hasOwn(data.settings, 'skills') ? data.settings.skills : [];
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) {
    throw new Invalid('skills must be an array of paths');
  }
  // Stale resource recognition relies on the pi-config derivation name.
  const refreshed = [
    ...skills.filter((s: string) => !s.includes('-pi-config/skills/') && !previous.skills.includes(s)),
    ...fragment.skills,
  ];
  if (!isDeepStrictEqual(refreshed, skills)) data.settings.skills = refreshed;
  // Thinking blocks are transcript content, not the thinking-level indicator.
  // Absent by default; a user's explicit value, including `false`, survives.
  if (!Object.hasOwn(data.settings, 'hideThinkingBlock')) data.settings.hideThinkingBlock = true;
  if (gateway) {
    if (!Object.hasOwn(data.models, 'providers')) data.models.providers = {};
    if (!isObject(data.models.providers)) throw new Invalid('providers must be a JSON object');
    data.models.providers.litellm = gateway.providers.litellm;
    for (const key of ['defaultProvider', 'defaultModel'] as const) {
      if (!Object.hasOwn(data.settings, key)) data.settings[key] = gateway[key];
    }
  }
  const writes = new Map(names.filter((name) => !isDeepStrictEqual(data[name], original[name]))
    .map((name) => [paths[name], data[name]]));
  const launch = fragment.launch;
  const record: LaunchRecord = {
    skills: launch?.skills ?? [],
    mcpServers: Object.fromEntries((launch?.mcpServers ?? []).map((name) => [name, fragment.mcpServers[name]])),
  };
  const empty = !record.skills.length && !Object.keys(record.mcpServers).length;
  let remove: string | null = null;
  if (empty) {
    if (existsSync(recordPath)) remove = recordPath;
  } else if (!isDeepStrictEqual(record, previous) || !existsSync(recordPath)) {
    writes.set(recordPath, record);
  }
  return { writes, remove };
}

export function mergeState(mode: string, directory: string, fragmentPath: string, gatewayPath?: string) {
  const fragment: Fragment = JSON.parse(readFileSync(fragmentPath, 'utf8'));
  const gateway: GatewayConfig | null = gatewayPath ? JSON.parse(readFileSync(gatewayPath, 'utf8')) : null;
  const { writes, remove } = prepare(directory, fragment, gateway);
  const staged: [string, string][] = [];
  try {
    for (const [path, data] of writes) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = writeTemporary(dirname(path), '.pi-', JSON.stringify(data, null, 2) + '\n');
      staged.push([temporary, path]);
      chmodSync(temporary, existsSync(path) ? statSync(path).mode & 0o7777 : 0o600);
    }
    if (mode !== '--check') {
      for (const [temporary, path] of staged) renameSync(temporary, path);
      if (remove) rmSync(remove);
    }
  } finally {
    for (const [temporary] of staged) rmSync(temporary, { force: true });
  }
}

type LaunchArgs = Inputs & { config: string; profile: ProfileEntry[] };

/**
 * At launch: the profile's fragment without the replaced plugins and with the
 * variable's, written to the cache by content. Prints its path, which the
 * launcher hands merge-state in place of the profile's.
 */
export const adapter: Adapter<LaunchArgs> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, args, report) =>
    writeFileSync(join(out, 'fragment.json'), JSON.stringify(pluginFragment(description, out, args, report))),
  launch: ({ args, kept, replaced, plugins, cache }) => {
    const base: Fragment = JSON.parse(readFileSync(join(args.config, 'config.json'), 'utf8'));
    const owners: Record<string, string> = {};
    for (const plugin of kept) claim(owners, plugin.description, LaunchError);
    const replaces: Servers = {};
    let skills = base.skills;
    for (const plugin of replaced) {
      skills = skills.filter((path) => path !== join(args.config, 'skills', plugin.name));
      for (const name of Object.keys(plugin.description.mcpServers)) {
        if (Object.hasOwn(base.mcpServers, name)) replaces[name] = base.mcpServers[name];
        delete base.mcpServers[name];
      }
    }
    const launch = { skills: [] as string[], mcpServers: [] as string[], replaces };
    for (const plugin of plugins) {
      claim(owners, plugin.description, LaunchError);
      const fragment: Fragment = JSON.parse(readFileSync(join(plugin.translation, 'fragment.json'), 'utf8'));
      launch.skills.push(...fragment.skills);
      launch.mcpServers.push(...Object.keys(fragment.mcpServers));
      Object.assign(base.mcpServers, fragment.mcpServers);
    }
    const fragment: Fragment = { skills: [...skills, ...launch.skills], mcpServers: base.mcpServers, launch };
    return writeAddressed(join(cache, 'pi', 'launch'), fragment);
  },
};

function run(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'write-config') {
    try {
      writeConfig(rest[0], rest[1]);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      process.stderr.write(error.message + '\n');
      return 1;
    }
    return 0;
  }
  if (command !== 'merge-state') throw new Error(`unknown command: ${command}`);
  try {
    mergeState(rest[0], rest[1], rest[2], rest[3]);
  } catch (error) {
    if (isSystemError(error)) {
      process.stderr.write(`Pi: warning: cannot merge user configuration: ${error.message}\n`);
      return rest[0] === '--check' ? 2 : 0;
    }
    process.stderr.write(`Pi: invalid configuration; no files changed: ${(error as Error).message}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
