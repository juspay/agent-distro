/**
 * The session config OpenCode reads, with the profile's `settings.opencode`.
 *
 * Usage: node opencode-settings.ts BASE SETTINGS_JSON DIRECTORY
 *
 * BASE is the session config the launcher wrote (session config, plus the
 * plugins of this launch). SETTINGS_JSON is the profile's `settings.opencode`,
 * exactly as src/plugin/launch.ts printed it for this launch, and may be `{}`.
 * The result is written under DIRECTORY by its contents, and its path printed
 * for OPENCODE_CONFIG.
 *
 * The merge is key-wise for objects and concatenating for arrays, so a
 * profile's `plugins` come after the session config's — the vendored
 * opencode-plugin-litellm among them — and its `providers` merge into the
 * document OpenCode reads rather than replacing it. `skills` and
 * `mcp.servers` are the launcher's own: they name what this launch's plugins
 * resolved to, so the profile's are ignored.
 */
import { readFileSync } from 'node:fs';
import { writeAddressed } from '../plugin/launch.ts';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `upper` over `lower`: objects key-wise, arrays concatenated, anything else replaced. */
function merge(lower: unknown, upper: unknown): unknown {
  if (Array.isArray(lower) && Array.isArray(upper)) return [...lower, ...upper];
  if (!isObject(lower) || !isObject(upper)) return upper;
  const merged: Json = { ...lower };
  for (const [key, value] of Object.entries(upper)) merged[key] = key in merged ? merge(merged[key], value) : value;
  return merged;
}

/** `settings` without the keys the launcher's session config owns. */
function withoutLauncherKeys(settings: Json): Json {
  const rest: Json = { ...settings };
  delete rest.skills;
  if (isObject(rest.mcp)) {
    const mcp: Json = { ...rest.mcp };
    delete mcp.servers;
    if (Object.keys(mcp).length) rest.mcp = mcp;
    else delete rest.mcp;
  }
  return rest;
}

if (import.meta.main) {
  const [base, settingsJson, directory] = process.argv.slice(2);
  const config: unknown = JSON.parse(readFileSync(base, 'utf8'));
  if (!isObject(config)) throw new Error(`${base} is not an OpenCode session config`);
  const settings: unknown = JSON.parse(settingsJson);
  if (!isObject(settings)) throw new Error('settings.opencode is not an object');
  process.stdout.write(writeAddressed(directory, merge(config, withoutLauncherKeys(settings))) + '\n');
}
