/**
 * Add absent wrapper defaults to OMP's config.yml without replacing the user's
 * own settings.
 *
 * Usage: node omp.ts CONFIG LAYER...
 *
 * Layers are YAML files applied in order: a later one adds only keys the
 * earlier ones (and the user) left absent, so each default has one home. The
 * config goes through yaml's Document API so comments and quoting survive. A
 * config that cannot be written only warns; invalid YAML stops the launch
 * without a write.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Document, isMap, isScalar, parse, parseDocument, type YAMLMap } from 'yaml';
import { isSystemError, realpath, temporaryPath } from '../util.ts';

type Defaults = Record<string, unknown>;

// Match ruamel.yaml's round-trip output, which earlier versions of this
// wrapper wrote: block sequences sit at their key's indentation and flow
// collections have no inner padding.
const FORMAT = { indentSeq: false, flowCollectionPadding: false } as const;

const isPlainObject = (value: unknown): value is Defaults =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Add every default the user has not set, recursing into shared mappings.
 *
 * A key the user set is never replaced, mappings included: the recursion only
 * reaches below it, and only for keys the user left out. So a config that
 * already names every role and every display setting is not rewritten at all,
 * while one that never mentioned them gets them back on the next launch.
 */
function fillAbsent(document: Document, target: YAMLMap, defaults: Defaults, path = ''): number {
  let added = 0;
  for (const [key, value] of Object.entries(defaults)) {
    const where = path + key;
    if (!target.has(key)) {
      target.set(key, document.createNode(value));
      added += 1;
    } else if (isPlainObject(value)) {
      // A section the user set to something else is a config error, not a
      // default to skip: OMP would read past it and silently run without
      // the settings under it — the roles among them.
      const section = target.get(key, true);
      if (!isMap(section)) throw new Error(`${where} must be a YAML mapping`);
      added += fillAbsent(document, section, value, `${where}.`);
    }
  }
  return added;
}

/** Fill absent keys from each layer, writing the config at most once. */
export function fillDefaults(configPath: string, layers: Defaults[]) {
  // Follow a user's config symlink rather than replacing it.
  const config = realpath(configPath);
  const exists = existsSync(config);
  const original = exists ? readFileSync(config, 'utf8') : '';
  let document = parseDocument(original);
  if (document.errors.length) throw document.errors[0];
  let preamble = '';
  const contents = document.contents;
  if (contents === null || (isScalar(contents) && contents.value === null)) {
    // A comments-only document has no YAML node to retain its comments.
    if (original.split('\n').every((line) => !line.trim() || line.trimStart().startsWith('#'))) {
      preamble = original && !original.endsWith('\n') ? original + '\n' : original;
    }
    document = new Document({});
  }
  if (!isMap(document.contents)) throw new Error('config must be a YAML mapping');
  let added = 0;
  for (const layer of layers) added += fillAbsent(document, document.contents, layer);
  if (!added) return;
  mkdirSync(dirname(config), { recursive: true });
  const mode = exists ? statSync(config).mode & 0o7777 : 0o600;
  const temporary = temporaryPath(dirname(config), '.config-');
  try {
    writeFileSync(temporary, preamble + document.toString(FORMAT), { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, mode);
    renameSync(temporary, config);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (import.meta.main) {
  const [config, ...sources] = process.argv.slice(2);
  try {
    const layers = sources.map((source) => parse(readFileSync(source, 'utf8')) ?? {});
    if (!layers.every(isPlainObject)) throw new Error('every defaults layer must be a YAML mapping');
    fillDefaults(config, layers);
  } catch (error) {
    if (isSystemError(error)) {
      // The defaults are a convenience; an agent directory the wrapper cannot
      // write must not stop the harness from launching.
      process.stderr.write(`omp: warning: cannot fill config defaults in ${config}: ${error.message}\n`);
    } else {
      process.stderr.write(`omp: cannot fill config defaults in ${config}: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}
