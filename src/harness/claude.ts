/**
 * Translate one plugin description into a Claude Code plugin directory, at
 * launch: src/plugin/launch.ts uses `adapter` to write that root into the
 * cache of a plugin on AGENT_DISTRO_PLUGINS.
 *
 * Each part reads the validated description, never the plugin's own JSON, so a
 * Claude Code format change touches this file and a spec change none. Skills are
 * only the discovered ones, with only their in-root files, materialized: Claude
 * rejects component symlinks outside its root.
 *
 * Claude Code runs a plugin's stdio server in its own launch directory and
 * applies its own variable expansion, neither of which is the Agent Plugins
 * contract. So each stdio server gets a launcher script that sets up the spec's
 * environment, working directory and placeholders itself, and Claude Code is
 * handed only that script. Remote servers cannot be wrapped and are mapped to
 * Claude Code's transport names.
 *
 * The launcher (harnesses/claude/default.nix) also runs this module as
 * `claude.ts settings`, for the `--settings` this session asks Claude Code
 * for: `SESSION_DEFAULTS`, minus whatever the user has decided themselves.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.ts';
import type { Adapter, Report } from '../plugin/launch.ts';
import { launcher, shellQuote } from '../plugin/launcher.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, fileName, launchable } from '../plugin/resources.ts';
import { workingDirectory } from '../profile/resolve.ts';
import { decodeUtf8 } from '../util.ts';

const MANIFEST_FIELDS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
const TRANSPORTS = { 'streamable-http': 'http', sse: 'sse' } as const;

type ClaudeServer =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string };

type Inputs = { bash: string; env: string };

/** Write `description` as a Claude Code plugin root at `out`. */
export function writePlugin(description: Description, out: string, { bash, env }: Inputs, report: Report) {
  mkdirSync(join(out, '.claude-plugin'), { recursive: true });
  const manifest: Record<string, unknown> = {};
  for (const key of MANIFEST_FIELDS) {
    if (description.manifest[key] != null) manifest[key] = description.manifest[key];
  }
  writeFileSync(join(out, '.claude-plugin/plugin.json'), JSON.stringify(manifest, null, 2));
  mkdirSync(join(out, 'skills'));
  copySkills(description, join(out, 'skills'));
  const servers: Record<string, ClaudeServer> = {};
  Object.entries(description.mcpServers).forEach(([name, server], index) => {
    if (server.type !== 'stdio') {
      const headers = Object.keys(server.headers).length ? { headers: server.headers } : {};
      servers[name] = { type: TRANSPORTS[server.type], url: server.url, ...headers };
      return;
    }
    if (!launchable(description, server)) {
      report(`mcp.json: server ${JSON.stringify(name)} skipped, `
        + 'Claude Code adapter cannot launch a command containing "="');
      return;
    }
    const script = join(out, 'mcp-launchers', `${index}-${fileName(name)}`);
    mkdirSync(join(out, 'mcp-launchers'), { recursive: true });
    // Owner bits suffice: Nix canonicalizes store files to 0555/0444 on
    // registration, so the launcher is executable by every user.
    writeFileSync(script, launcher(description, name, server, bash, env, 'CLAUDE_PLUGIN_DATA'),
      { flag: 'wx', mode: 0o700 });
    servers[name] = { type: 'stdio', command: script };
  });
  if (Object.keys(servers).length) {
    writeFileSync(join(out, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  }
}

/** One setting this launch asks for, and what means the user has decided it. */
type SessionDefault = {
  /** What it is called in a log line. */
  name: string;
  /** The settings fragment, merged into the flag when it stands. */
  settings: Record<string, unknown>;
  /** Settings keys of the user's that leave the decision to them. */
  decidedBy: string[];
};

/**
 * What a session of ours settles that the user has not: one row per setting,
 * so the next one is a row rather than another flag.
 */
const SESSION_DEFAULTS: SessionDefault[] = [
  // Claude Code ends the commit messages it writes with a `Co-Authored-By:
  // Claude …` trailer and pull request descriptions with a line of its own.
  // Empty text is how it is told to write neither. `includeCoAuthoredBy` is
  // what said this before Claude Code 2.1.319's `attribution` replaced it.
  {
    name: 'attribution',
    settings: { attribution: { commit: '', pr: '' } },
    decidedBy: ['attribution', 'includeCoAuthoredBy'],
  },
];

/**
 * The settings files Claude Code reads for this launch that are the user's:
 * their own, and the launch directory's project and local ones. A managed
 * policy is not among them, since it outranks the flag in any case.
 */
function userSettings(env: NodeJS.ProcessEnv, cwd: string | undefined): string[] {
  const config = env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : undefined);
  return [
    ...(config ? [join(config, 'settings.json')] : []),
    ...(cwd ? [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')] : []),
  ];
}

/**
 * Every settings key the user has set, and the first file that set it. A file
 * Claude Code cannot read sets nothing, there as here.
 */
function decidedKeys(env: NodeJS.ProcessEnv, cwd: string | undefined): Map<string, string> {
  const owners = new Map<string, string>();
  for (const path of userSettings(env, cwd)) {
    let settings: unknown;
    try {
      settings = JSON.parse(decodeUtf8(readFileSync(path)));
    } catch {
      continue;
    }
    if (typeof settings !== 'object' || settings === null) continue;
    for (const key of Object.keys(settings)) if (!owners.has(key)) owners.set(key, path);
  }
  return owners;
}

/**
 * The `--settings` words for this session: every default the user has left
 * absent, in one flag, and no words at all when they have decided them all. A
 * default fills what the user did not say, as every other harness's does; the
 * flag outranks every settings file, which is why a decided one is left to
 * decide rather than overruled. Claude Code keeps only the last `--settings`,
 * so one of the user's own — the launcher puts theirs after this one —
 * replaces this whole flag, defaults and all.
 */
export function settingsArguments(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string | undefined = workingDirectory(),
  defaults: SessionDefault[] = SESSION_DEFAULTS,
): string[] {
  const owners = decidedKeys(env, cwd);
  const settings: Record<string, unknown> = {};
  for (const { name, settings: fragment, decidedBy } of defaults) {
    const decided = decidedBy.map((key) => owners.get(key)).find((path) => path !== undefined);
    if (decided) {
      log.claude.debug(`${name} is ${decided}'s to decide`);
      continue;
    }
    log.claude.debug(`${name}: this session's default`);
    Object.assign(settings, fragment);
  }
  if (!Object.keys(settings).length) return [];
  return ['--settings', shellQuote(JSON.stringify(settings))];
}

/**
 * At launch: the `--plugin-dir` arguments for every plugin, as shell words. A
 * plugin of a profile, or of the variable, is one more session-only plugin
 * directory.
 */
export const adapter: Adapter<Inputs, Inputs> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, inputs, report) => writePlugin(description, out, inputs, report),
  launch: ({ plugins }) => plugins.map((plugin) => plugin.translation)
    .flatMap((dir) => ['--plugin-dir', shellQuote(dir)]).join(' '),
};

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  if (mode !== 'settings') throw new Error(`usage: claude.ts settings (not ${JSON.stringify(mode)})`);
  process.stdout.write(settingsArguments().join(' ') + '\n');
}
