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
 * `claude.ts attribution`, for the `--settings` that leaves Claude Code's own
 * attribution out of the commits and pull requests of that session.
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

/**
 * Attribution text Claude Code adds nothing to: empty hides the trailer it
 * ends a commit message with and the line it ends a pull request description
 * with (Claude Code 2.1.319 `attribution`, which replaced `includeCoAuthoredBy`).
 */
const NO_ATTRIBUTION = { attribution: { commit: '', pr: '' } };

/** A settings key that means attribution is the user's own decision. */
const ATTRIBUTION_KEYS = ['attribution', 'includeCoAuthoredBy'];

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

/** Whether `path` decides attribution; one Claude Code cannot read decides nothing. */
function decidesAttribution(path: string): boolean {
  let settings: unknown;
  try {
    settings = JSON.parse(decodeUtf8(readFileSync(path)));
  } catch {
    return false;
  }
  return typeof settings === 'object' && settings !== null
    && ATTRIBUTION_KEYS.some((key) => key in settings);
}

/**
 * The `--settings` words that leave Claude Code's own attribution out of the
 * commits and pull requests of this session, and none at all when a settings
 * file of the user's already decides attribution: a default fills what the
 * user left absent, as every other harness's does. The flag outranks every
 * settings file, which is why a file that decides is left to it rather than
 * overruled. Claude Code keeps only the last `--settings`, so one of the
 * user's own — the launcher puts theirs after this one — replaces this whole
 * flag, attribution and all.
 */
export function attributionArguments(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string | undefined = workingDirectory(),
): string[] {
  const decided = userSettings(env, cwd).find(decidesAttribution);
  if (decided) {
    log.claude.debug(`attribution is ${decided}'s to decide`);
    return [];
  }
  log.claude.debug('attribution: none of Claude Code\'s own, for this session');
  return ['--settings', shellQuote(JSON.stringify(NO_ATTRIBUTION))];
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
  if (mode !== 'attribution') throw new Error(`usage: claude.ts attribution (not ${JSON.stringify(mode)})`);
  process.stdout.write(attributionArguments().join(' ') + '\n');
}
