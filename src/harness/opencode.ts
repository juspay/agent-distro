/**
 * Translate validated plugins once; OpenCode merges this file at launch.
 *
 * Usage: node opencode.ts OUT ARGS_JSON
 *
 * One adapter serves both config schemas: `v1` for OpenCode and `v2` for
 * OpenCode v2, which differ only in where skills, servers and the provider go.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copySkills, launchable, readDescription, writeLauncher } from '../plugin/resources.ts';
import type { Gateway } from '../gateway/models.ts';

type Args = { schema: string; bash: string; env: string; gateway: Gateway | null; descriptions: string[] };
type Server = { type: 'remote'; url: string; headers: Record<string, string> } | { type: 'local'; command: string[] };

function main(out: string, argsPath: string) {
  const args: Args = JSON.parse(readFileSync(argsPath, 'utf8'));
  const { schema, bash, env, gateway } = args;
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
    const plugin = description.manifest.name;
    const skills = copySkills(description, join(out, 'skills', plugin));
    if (skills) skillsPaths.push(skills);
    Object.entries(description.mcpServers).forEach(([name, server], index) => {
      if (Object.hasOwn(owners, name)) {
        process.stderr.write(`OpenCode: MCP server ${JSON.stringify(name)} is declared by both `
          + `plugins ${JSON.stringify(owners[name])} and ${JSON.stringify(plugin)}\n`);
        process.exit(1);
      }
      owners[name] = plugin;
      if (server.type !== 'stdio') {
        servers[name] = { type: 'remote', url: server.url, headers: server.headers };
        return;
      }
      if (!launchable(description, server)) {
        process.stderr.write(`${description.root}: mcp.json: server ${JSON.stringify(name)} skipped, `
          + 'OpenCode adapter cannot launch a command containing "="\n');
        return;
      }
      servers[name] = { type: 'local', command: [writeLauncher(description, name, server, out, index, bash, env)] };
    });
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

main(process.argv[2], process.argv[3]);
