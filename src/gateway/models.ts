/**
 * Cache bounded gateway model discovery for config-based adapters.
 *
 * Usage: node models.ts BASE CACHE CURL KEY_ENV SHAPE
 *
 * Adds the gateway's served models to BASE's provider, writes the result to
 * CACHE, and prints the config to use: CACHE, or BASE when discovery has never
 * succeeded. SHAPE (a JSON file) says where the provider, its URL and its
 * models live in this harness's config.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeUtf8, isFile, isSystemError, writeTemporary } from '../util.ts';

/** A profile's gateway, as profile.nix declares it. */
export type Gateway = {
  url: string;
  keyEnv: string;
  models: { large: string; small: string } & Record<string, string>;
  keyHint?: string;
};

export type Shape = {
  provider: string[];
  url: string[];
  models: 'map' | 'list';
  label: string;
};

type Json = any;

/** The gateway did not answer usefully; launch with what we have. */
class Unavailable extends Error {}

const atPath = (value: Json, path: string[]) => path.reduce((node, key) => node[key], value);

function addModel(models: Json, name: string, shape: Shape) {
  if (shape.models === 'list') {
    if (!models.some((model: { id: string }) => model.id === name)) models.push({ id: name });
  } else {
    models[name] = { name };
  }
}

/** The ids the gateway serves, from its OpenAI-style /models listing. */
function served(curl: string, url: string, keyEnv: string): string[] {
  const key = process.env[keyEnv];
  if (key === undefined) throw new Unavailable(`${keyEnv} is not set`);
  let header = 'Authorization: Bearer ' + key;
  if (header.includes('\r') || header.includes('\n')) throw new Unavailable('invalid gateway key');
  // curl's config quoting keeps credentials off the process command line.
  header = header.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const response = spawnSync(curl,
    ['--fail', '--silent', '--show-error', '--connect-timeout', '2', '--max-time', '5', '--config', '-', url + '/models'],
    { input: `header = "${header}"\n`, maxBuffer: Infinity });
  if (response.error) throw response.error;
  if (response.status !== 0) throw new Unavailable(`curl exited with ${response.status ?? response.signal}`);
  let text: string;
  try {
    text = decodeUtf8(response.stdout);
  } catch {
    throw new Unavailable('the model list is not UTF-8');
  }
  const models = JSON.parse(text)?.data;
  if (!Array.isArray(models)) throw new Unavailable('models data is not a list');
  return models.map((model) => {
    const name = typeof model === 'object' && model !== null ? model.id : undefined;
    if (typeof name !== 'string' || !name) throw new Unavailable('model id is not a nonempty string');
    // As an object key it would set the prototype instead of adding a model.
    if (name === '__proto__') throw new Unavailable('model id `__proto__` cannot be represented');
    return name;
  });
}

export function main(base: string, cache: string, curl: string, keyEnv: string, shapeSource: string | Shape) {
  const config = JSON.parse(readFileSync(base, 'utf8'));
  const shape: Shape = typeof shapeSource === 'string' ? JSON.parse(readFileSync(shapeSource, 'utf8')) : shapeSource;
  const provider = atPath(config, shape.provider);
  const url = atPath(provider, shape.url);
  try {
    for (const name of served(curl, url, keyEnv)) addModel(provider.models, name, shape);
    mkdirSync(dirname(cache), { recursive: true });
    // Concurrent launches must never see a partially written config.
    const temporary = writeTemporary(dirname(cache), '.models-', JSON.stringify(config, null, 2));
    try {
      renameSync(temporary, cache);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    // Only an unreachable or unhelpful gateway, or a cache we cannot write,
    // falls back; anything else is a bug and stops the launch.
    if (!(error instanceof Unavailable || error instanceof SyntaxError || isSystemError(error))) throw error;
    const fallback = isFile(cache) ? cache : base;
    const source = fallback === cache ? 'cached model list' : 'two profile aliases';
    process.stderr.write(`${shape.label}: gateway model discovery failed; using ${source} from ${fallback}\n`);
  }
  process.stdout.write((isFile(cache) ? cache : base) + '\n');
}

if (import.meta.main) {
  const [base, cache, curl, keyEnv, shape] = process.argv.slice(2);
  main(base, cache, curl, keyEnv, shape);
}
