/**
 * The Antigravity CLI's side of a launch's plugins, run by src/plugin/launch.ts.
 *
 * `agy` has no flag that loads a plugin for one launch: it reads every plugin
 * folder in `~/.gemini/config/plugins/`, the directory the Antigravity desktop
 * app and IDE read too. So `translate` writes each plugin as an Antigravity
 * plugin folder — `plugin.json`, `skills/`, and `mcp_config.json`, whose stdio
 * servers run through generated launchers (src/plugin/resources.ts) — and
 * `launch` links each into that directory under its name, recording what it
 * linked in RECORD beside it. The next launch takes back whatever is still as
 * recorded before linking its own, so a plugin stays until the next `agy`
 * launch, however much later that is. An entry the launcher did not link is
 * never altered or removed: a plugin whose name one already holds is skipped,
 * with a word. A home that is unset or cannot be written skips the links,
 * with a word, and `agy` still starts.
 *
 * The record is written before any link is made, and again once they are, so
 * an interrupted launch leaves nothing the next one would take for the user's.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from '../log.ts';
import { LaunchError, type Adapter, type Report } from '../plugin/launch.ts';
import type { ModelSource } from '../models.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, launchable, writeLauncher, type Inputs } from '../plugin/resources.ts';
import { isSystemError, lexists, writeTemporary } from '../util.ts';

/** Antigravity's own manifest schema: the folder is an Antigravity plugin, not an Agent Plugins one. */
const SCHEMA = 'https://antigravity.google/schemas/v1/plugin.json';

/** Beside the plugins directory, not in it, so no loader takes it for a plugin. */
export const RECORD = '.agent-distro-launch.json';

/** Plugin name → the translation linked under it. */
type Links = Record<string, string>;

const logger = log.harness('agy');

/** `~/.gemini/config/plugins`, or null without a home. */
export const pluginsDirectory = (env: NodeJS.ProcessEnv = process.env) =>
  env.HOME ? join(env.HOME, '.gemini', 'config', 'plugins') : null;

/**
 * One plugin as an Antigravity plugin folder at `out`. Its manifest fields are
 * all Antigravity's too; an SSE server is skipped, since Antigravity's remote
 * servers are Streamable HTTP only.
 */
export function writeAntigravityPlugin(description: Description, out: string, { bash, env }: Inputs, report: Report) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'plugin.json'), JSON.stringify({ ...description.manifest, $schema: SCHEMA }, null, 2) + '\n');
  copySkills(description, join(out, 'skills'));
  const servers: Record<string, unknown> = {};
  Object.entries(description.mcpServers).forEach(([name, server], index) => {
    let reason: string | null = null;
    if (server.type === 'sse') {
      reason = 'Antigravity does not support SSE';
    } else if (server.type === 'stdio') {
      if (!launchable(description, server)) {
        reason = 'the adapter cannot launch a command containing "="';
      } else {
        servers[name] = { command: writeLauncher(description, name, server, out, index, bash, env), args: [] };
      }
    } else {
      servers[name] = { serverUrl: server.url, headers: server.headers };
    }
    if (reason) report(`mcp.json: server ${JSON.stringify(name)} skipped, ${reason}`);
  });
  if (Object.keys(servers).length) {
    writeFileSync(join(out, 'mcp_config.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
  }
}

/** The record at `path`: what the last launch linked. */
function readRecord(path: string): Links {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isSystemError(error)) throw error;
    value = undefined;
  }
  const links = (value as { links?: unknown } | undefined)?.links;
  if (typeof links !== 'object' || links === null || Array.isArray(links)
    || Object.values(links).some((target) => typeof target !== 'string')) {
    throw new LaunchError(`${path} is not agent-distro's launch record; remove it to launch again`);
  }
  return links as Links;
}

function writeRecord(path: string, links: Links) {
  if (!Object.keys(links).length) {
    rmSync(path, { force: true });
    return;
  }
  const temporary = writeTemporary(dirname(path), '.agy-', JSON.stringify({ links }, null, 2) + '\n');
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Where `path` links to, or null when it is not a link (or not there). */
function linkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Link `wanted` into `directory`, taking back what the record at `recordPath`
 * says the last launch linked and is still as it left it. Returns what is
 * linked now. Throws a system error when the directory cannot be written.
 */
export function link(directory: string, recordPath: string, wanted: Links, report: Report): Links {
  const previous = readRecord(recordPath);
  // Only what is still exactly as the last launch left it is ours to touch.
  const ours: Links = {};
  for (const [name, target] of Object.entries(previous)) {
    if (linkTarget(join(directory, name)) === target) ours[name] = target;
  }
  const claimed: Links = {};
  for (const [name, target] of Object.entries(wanted)) {
    if (Object.hasOwn(ours, name) || !lexists(join(directory, name))) claimed[name] = target;
    else report(`plugin ${JSON.stringify(name)} skipped: ${join(directory, name)} is not agent-distro's`);
  }
  if (!Object.keys(ours).length && !Object.keys(claimed).length) {
    if (Object.keys(previous).length) writeRecord(recordPath, {});
    return {};
  }
  mkdirSync(directory, { recursive: true });
  // Everything this launch may leave behind, before any of it is there.
  writeRecord(recordPath, { ...ours, ...claimed });
  for (const [name, target] of Object.entries(ours)) {
    if (claimed[name] !== target) rmSync(join(directory, name));
  }
  const linked: Links = {};
  for (const [name, target] of Object.entries(claimed)) {
    const path = join(directory, name);
    if (ours[name] !== target) {
      try {
        symlinkSync(target, path);
      } catch (error) {
        // Something of the user's appeared there since it was looked at.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        report(`plugin ${JSON.stringify(name)} skipped: ${path} is not agent-distro's`);
        continue;
      }
    }
    linked[name] = target;
  }
  writeRecord(recordPath, linked);
  return linked;
}

/**
 * `agy models`: one model a line, its slug and then its name, as Google
 * documents it (`gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)`). The
 * slug is what `--model` takes. Any other line is refused, not guessed at.
 */
const MODEL_LINE = /^([a-z0-9][a-z0-9._-]*)\s{2,}\S/;

export const models: ModelSource = {
  launch: { kind: 'flag', flag: '--model' },
  list: {
    args: ['models'],
    read: (stdout) => {
      const lines = stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean);
      if (!lines.length) throw new Error('no models, and no word why');
      return lines.map((line) => {
        const match = MODEL_LINE.exec(line);
        if (!match) throw new Error(`${JSON.stringify(line)}, not a model's slug and name`);
        return match[1];
      });
    },
  },
};

/** At launch: every plugin linked for `agy` to read; nothing on its command line. */
export const adapter: Adapter<Inputs, Inputs> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, inputs, report) => writeAntigravityPlugin(description, out, inputs, report),
  launch: ({ plugins, report }) => {
    const directory = pluginsDirectory();
    if (!directory) {
      if (plugins.length) logger.warn('HOME is unset; skipping plugin links');
      return '';
    }
    const wanted: Links = Object.fromEntries(plugins.map((plugin) => [plugin.name, plugin.translation]));
    try {
      link(directory, join(dirname(directory), RECORD), wanted, report);
    } catch (error) {
      if (!isSystemError(error)) throw error;
      logger.warn(`${directory} cannot be written; skipping plugin links: ${error.message}`);
    }
    return '';
  },
};
