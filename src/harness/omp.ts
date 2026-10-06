/**
 * Add absent wrapper defaults to OMP's config.yml without replacing the user's
 * own settings.
 *
 * Usage: node omp.ts CONFIG LAYER...
 *
 * OMP loads an Agent Plugins directory itself, so `adapter`, which
 * src/plugin/launch.ts runs for AGENT_DISTRO_PLUGINS, only validates a plugin
 * and passes its root as one more `-e`.
 *
 * Layers are YAML files applied in order: a later one adds only keys the
 * earlier ones (and the user) left absent, so each default has one home. The
 * config goes through yaml's Document API so comments and quoting survive. A
 * config that cannot be written only warns; invalid YAML stops the launch
 * without a write.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Document, isAlias, isMap, isScalar, isSeq, parse, parseDocument, type YAMLMap } from 'yaml';
import type { Adapter, ProfileEntry } from '../plugin/launch.ts';
import { shellQuote } from '../plugin/launcher.ts';
import { decodeUtf8, isSystemError, realpath, writeTemporary } from '../util.ts';

type Defaults = Record<string, unknown>;

// Match ruamel.yaml's round-trip output, which earlier versions of this
// wrapper wrote: block sequences sit at their key's indentation and flow
// collections have no inner padding.
const FORMAT = { indentSeq: false, flowCollectionPadding: false, lineWidth: 0 } as const;

const isPlainObject = (value: unknown): value is Defaults =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resolve = (document: Document, node: unknown) => (isAlias(node) ? node.resolve(document) : node);

/**
 * The value `key` has in `map` as OMP reads it, or undefined when the user
 * has not set it. Besides the map's own keys this sees what `<<` merge keys
 * bring in, so a default never shadows a merged-in value, and it follows
 * aliases, so filling a section fills the anchored mapping it names.
 */
function lookup(document: Document, map: YAMLMap, key: string): { value: unknown } | undefined {
  const own = map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
  if (own) return { value: resolve(document, own.value) };
  for (const pair of map.items) {
    if (!isScalar(pair.key) || pair.key.value !== '<<') continue;
    const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
    for (const source of sources) {
      const merged = resolve(document, source);
      const found = isMap(merged) ? lookup(document, merged, key) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}

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
    const found = lookup(document, target, key);
    if (!found) {
      target.set(key, document.createNode(value));
      added += 1;
    } else if (isPlainObject(value)) {
      // A section the user set to something else is a config error, not a
      // default to skip: OMP would read past it and silently run without
      // the settings under it — the roles among them.
      if (!isMap(found.value)) throw new Error(`${where} must be a YAML mapping`);
      added += fillAbsent(document, found.value, value, `${where}.`);
    }
  }
  return added;
}

/** Fill absent keys from each layer, writing the config at most once. */
export function fillDefaults(configPath: string, layers: Defaults[]) {
  // Follow a user's config symlink rather than replacing it.
  const config = realpath(configPath);
  const exists = existsSync(config);
  // Strict, so a file that is not UTF-8 stops the launch instead of being
  // rewritten with replacement characters.
  const original = exists ? decodeUtf8(readFileSync(config)) : '';
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
  const temporary = writeTemporary(dirname(config), '.config-', preamble + document.toString(FORMAT));
  try {
    chmodSync(temporary, mode);
    renameSync(temporary, config);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** At launch: every plugin's `-e` root, as shell words, replacing the launcher's own. */
export const adapter: Adapter<{ profile: (ProfileEntry & { dir: string })[] }, ProfileEntry & { dir: string }> = {
  translationInputs: () => null,
  translate: () => {},
  launch: ({ kept, plugins }) => [
    ...kept.map((plugin) => plugin.entry.dir),
    ...plugins.map((plugin) => plugin.description.root),
  ].flatMap((dir) => ['-e', shellQuote(dir)]).join(' '),
};

if (import.meta.main) {
  const [config, ...sources] = process.argv.slice(2);
  try {
    const layers = sources.map((source) => parse(decodeUtf8(readFileSync(source))) ?? {});
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
