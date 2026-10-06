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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isFile, temporaryPath } from '../util.ts';

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

const atPath = (value: Json, path: string[]) => path.reduce((node, key) => node[key], value);

function addModel(models: Json, name: string, shape: Shape) {
  if (shape.models === 'list') {
    if (!models.some((model: { id: string }) => model.id === name)) models.push({ id: name });
  } else {
    models[name] = { name };
  }
}

export function main(base: string, cache: string, curl: string, keyEnv: string, shapeSource: string | Shape) {
  const config = JSON.parse(readFileSync(base, 'utf8'));
  const shape: Shape = typeof shapeSource === 'string' ? JSON.parse(readFileSync(shapeSource, 'utf8')) : shapeSource;
  const provider = atPath(config, shape.provider);
  const url = atPath(provider, shape.url);
  try {
    const key = process.env[keyEnv];
    if (key === undefined) throw new Error(`${keyEnv} is not set`);
    let header = 'Authorization: Bearer ' + key;
    if (header.includes('\r') || header.includes('\n')) throw new Error('invalid gateway key');
    // curl's config quoting keeps credentials off the process command line.
    header = header.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const response = spawnSync(curl,
      ['--fail', '--silent', '--show-error', '--connect-timeout', '2', '--max-time', '5', '--config', '-', url + '/models'],
      { input: `header = "${header}"\n`, encoding: 'utf8' });
    if (response.error) throw response.error;
    if (response.status !== 0) throw new Error(`curl exited with ${response.status ?? response.signal}`);
    const models = JSON.parse(response.stdout).data;
    if (!Array.isArray(models)) throw new Error('models data is not a list');
    for (const model of models) {
      const name = model.id;
      if (typeof name !== 'string' || !name) throw new Error('model id is not a nonempty string');
      addModel(provider.models, name, shape);
    }
    mkdirSync(dirname(cache), { recursive: true });
    // Concurrent launches must never see a partially written config.
    const temporary = temporaryPath(dirname(cache), '.models-');
    try {
      writeFileSync(temporary, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, cache);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
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
