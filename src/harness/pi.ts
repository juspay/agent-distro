/**
 * Pi's plugin protocol: resources go into its user JSON files, never global CLI
 * options, because Pi's subcommands reject prepended flags.
 *
 * Usage: node pi.ts write-config OUT ARGS_JSON
 *        node pi.ts merge-state --check|--merge AGENT_DIR CONFIG_JSON [GATEWAY_JSON]
 *
 * write-config translates plugins once, at build time. merge-state runs at
 * launch: ours replace ours, user entries stay untouched, and invalid JSON
 * aborts before any write. --check stages every write without replacing a file
 * and exits 2 when the directory cannot be written.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Gateway } from '../gateway/models.ts';
import { copySkills, launchable, readDescription, writeLauncher } from '../plugin/resources.ts';
import { isSystemError, realpath, writeTemporary } from '../util.ts';

type Fragment = { skills: string[]; mcpServers: Record<string, Record<string, unknown>> };
type GatewayConfig = { providers: { litellm: unknown }; defaultProvider: string; defaultModel: string };
type JsonObject = Record<string, any>;

class Invalid extends Error {}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function writeConfig(out: string, argsPath: string) {
  const args: { bash: string; env: string; gateway: Gateway | null; descriptions: string[] } =
    JSON.parse(readFileSync(argsPath, 'utf8'));
  const { bash, env, gateway } = args;
  mkdirSync(out, { recursive: true });
  const skills: string[] = [];
  const servers: Fragment['mcpServers'] = {};
  const owners: Record<string, string> = {};
  for (const path of args.descriptions) {
    const description = readDescription(path);
    const plugin = description.manifest.name;
    const skillPath = copySkills(description, join(out, 'skills', plugin));
    if (skillPath) skills.push(skillPath);
    Object.entries(description.mcpServers).forEach(([name, server], index) => {
      if (Object.hasOwn(owners, name)) {
        throw new Invalid(`Pi: MCP server ${JSON.stringify(name)} is declared by both `
          + `plugins ${JSON.stringify(owners[name])} and ${JSON.stringify(plugin)}`);
      }
      owners[name] = plugin;
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
      if (reason) process.stderr.write(`${description.root}: mcp.json: server ${JSON.stringify(name)} skipped, ${reason}\n`);
    });
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

/** The files to write and their new contents; none of them written yet. */
function prepare(directory: string, fragment: Fragment, gateway: GatewayConfig | null): Map<string, JsonObject> {
  const names = ['mcp', 'settings', ...(gateway ? ['models'] : [])];
  const paths = Object.fromEntries(names.map((name) => [name, realpath(join(directory, `${name}.json`))]));
  // Validate every input before any write, including files another merge owns.
  const original = Object.fromEntries(names.map((name) => [name, readObject(paths[name])]));
  const data: Record<string, JsonObject> = structuredClone(original);
  const servers = Object.hasOwn(data.mcp, 'mcpServers') ? data.mcp.mcpServers : {};
  if (!isObject(servers)) throw new Invalid('mcpServers must be a JSON object');
  if (Object.keys(fragment.mcpServers).length) data.mcp.mcpServers = { ...servers, ...fragment.mcpServers };
  const skills = Object.hasOwn(data.settings, 'skills') ? data.settings.skills : [];
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) {
    throw new Invalid('skills must be an array of paths');
  }
  // Stale resource recognition relies on the pi-config derivation name.
  const refreshed = [...skills.filter((s: string) => !s.includes('-pi-config/skills/')), ...fragment.skills];
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
  return new Map(names.filter((name) => !isDeepStrictEqual(data[name], original[name]))
    .map((name) => [paths[name], data[name]]));
}

export function mergeState(mode: string, directory: string, fragmentPath: string, gatewayPath?: string) {
  const fragment: Fragment = JSON.parse(readFileSync(fragmentPath, 'utf8'));
  const gateway: GatewayConfig | null = gatewayPath ? JSON.parse(readFileSync(gatewayPath, 'utf8')) : null;
  const changes = prepare(directory, fragment, gateway);
  const staged: [string, string][] = [];
  try {
    for (const [path, data] of changes) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = writeTemporary(dirname(path), '.pi-', JSON.stringify(data, null, 2) + '\n');
      staged.push([temporary, path]);
      chmodSync(temporary, existsSync(path) ? statSync(path).mode & 0o7777 : 0o600);
    }
    if (mode !== '--check') {
      for (const [temporary, path] of staged) renameSync(temporary, path);
    }
  } finally {
    for (const [temporary] of staged) rmSync(temporary, { force: true });
  }
}

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
