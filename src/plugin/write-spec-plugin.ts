/**
 * Write one plugin as an Agent Plugins directory whose stdio servers run
 * through generated launchers.
 *
 * Usage: node write-spec-plugin.ts OUT ARGS_JSON
 *
 * ARGS_JSON is `{ bash, env, description }`, as the adapters' own CLIs take it.
 * This is the build-time half of what the OMP and Codex adapters translate at
 * launch: a plugin compiled into a distribution is materialized the same way,
 * so a built-in plugin's servers run in the launch directory too.
 */
import { readFileSync } from 'node:fs';
import { log } from '../log.ts';
import { readDescription, writeSpecPlugin } from './resources.ts';

if (import.meta.main) {
  const [out, argsPath] = process.argv.slice(2);
  const args: { bash: string; env: string; description: string } = JSON.parse(readFileSync(argsPath, 'utf8'));
  const description = readDescription(args.description);
  writeSpecPlugin(description, out, args, (message) => log.plugin.warn(`${description.root}: ${message}`));
}
