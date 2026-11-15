/**
 * What `agent-distro --models HARNESS` prints: the models that harness offers
 * from here, and how a launch is given one. Each harness says both in its own
 * adapter (`models` in src/harness/<harness>.ts); src/models-cli.ts asks the
 * harness, through its launcher, so the profile in effect decides the
 * providers exactly as it would for a launch from the same directory.
 *
 *   { "launch": { "kind": "flag", "flag": "--model" },
 *     "models": { "kind": "listed", "ids": ["anthropic/claude-fable-5", "litellm/open-large"] } }
 *
 *   { "launch": { "kind": "flag", "flag": "--model" },
 *     "models": { "kind": "unlisted" } }
 *
 * `listed` is what the harness listed — possibly nothing, when it has no
 * models to offer. `unlisted` is a harness with no command that lists its
 * models: a model is still passed the same way, but it is whatever the user
 * names. A harness whose list command fails is neither: the command exits
 * non-zero with the harness's own words, and prints nothing on stdout.
 *
 * An id is exactly what the launch takes, so the same model name under two
 * providers is two ids (`anthropic/claude-fable-5`, `litellm/claude-fable-5`).
 */

/** How a launch is given a model. */
export type ModelLaunch =
  /** `<harness> <flag> <id>`. */
  | { kind: 'flag'; flag: string }
  /** `<variable>='{"<key>":"<id>"}' <harness>`: a config layer in the environment. */
  | { kind: 'config'; variable: string; key: string };

/** The models a harness offers, or that it has no way to list them. */
export type ModelList = { kind: 'listed'; ids: string[] } | { kind: 'unlisted' };

export type Models = { launch: ModelLaunch; models: ModelList };

/**
 * What a harness's adapter says about its models: how a launch takes one, and
 * the arguments that make the harness print them with the reader of what it
 * printed, or `null` when the harness has no such command.
 */
export type ModelSource = {
  launch: ModelLaunch;
  list: { args: string[]; read: (stdout: string) => string[] } | null;
};

/** An id is one shell word: no whitespace, not empty. */
export const isModelId = (value: unknown): value is string => typeof value === 'string' && /^\S+$/.test(value);

/** A shell variable's name. */
const isVariable = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

/**
 * The environment and arguments a launch of the harness takes for `id`, in
 * that order before anything else the launch is given. The one place the
 * `launch` word is spelled out, so no consumer re-derives it.
 */
export function launchWords(launch: ModelLaunch, id: string): { env: Record<string, string>; args: string[] } {
  if (!isModelId(id)) throw new Error(`model ${JSON.stringify(id)} is empty or contains whitespace`);
  if (launch.kind === 'flag') return { env: {}, args: [launch.flag, id] };
  return { env: { [launch.variable]: JSON.stringify({ [launch.key]: id }) }, args: [] };
}

/** An object that is not an array: every value here is one or a refusal. */
function plain(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`);
  return value as Record<string, unknown>;
}

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  const fields = plain(value, path);
  for (const key of keys) if (fields[key] === undefined) throw new Error(`${path}.${key} is missing`);
  const extra = Object.keys(fields).find((key) => !keys.includes(key));
  if (extra !== undefined) throw new Error(`${path} has unknown field ${extra}`);
  return fields;
}

/** The `kind` an object at `path` is tagged with; its other fields are its arm's to check. */
function kindOf(value: unknown, path: string): unknown {
  const { kind } = plain(value, path) as { kind?: unknown };
  if (kind === undefined) throw new Error(`${path}.kind is missing`);
  return kind;
}

function parseLaunch(value: unknown): ModelLaunch {
  const kind = kindOf(value, 'models.launch');
  if (kind === 'flag') {
    const { flag } = object(value, 'models.launch', ['kind', 'flag']);
    if (typeof flag !== 'string' || !/^-\S+$/.test(flag)) throw new Error('models.launch.flag is not an option');
    return { kind, flag };
  }
  if (kind === 'config') {
    const { variable, key } = object(value, 'models.launch', ['kind', 'variable', 'key']);
    if (!isVariable(variable)) throw new Error('models.launch.variable is not a variable name');
    if (typeof key !== 'string' || !key) throw new Error('models.launch.key is empty or not a string');
    return { kind, variable, key };
  }
  throw new Error('models.launch.kind is not flag or config');
}

/** Check that `ids` are model ids, each once; throws naming the first bad one. */
function checkIds(ids: unknown, path: string): string[] {
  if (!Array.isArray(ids)) throw new Error(`${path} is not an array`);
  ids.forEach((id, i) => {
    if (!isModelId(id)) throw new Error(`${path}[${i}] is empty or contains whitespace`);
  });
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new Error(`${path} names ${duplicate} twice`);
  return ids;
}

function parseList(value: unknown): ModelList {
  const kind = kindOf(value, 'models.models');
  if (kind === 'unlisted') {
    object(value, 'models.models', ['kind']);
    return { kind };
  }
  if (kind === 'listed') {
    const { ids } = object(value, 'models.models', ['kind', 'ids']);
    return { kind, ids: checkIds(ids, 'models.models.ids') };
  }
  throw new Error('models.models.kind is not listed or unlisted');
}

/** Check a parsed `--models` value against `Models`; throws naming the first bad field. */
export function parseModels(value: unknown): Models {
  const { launch, models } = object(value, 'models', ['launch', 'models']);
  return { launch: parseLaunch(launch), models: parseList(models) };
}
