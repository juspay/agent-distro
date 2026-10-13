/** Agent Plugins stdio environment and placeholder contract. */
import type { Description, StdioServer } from './read.ts';

/**
 * One POSIX shell word, quoted only when it needs to be. Generated launchers
 * are byte-identical to the ones earlier releases wrote with Python's
 * shlex.quote, whose rules these are.
 */
export function shellQuote(value: string): string {
  if (!value) return "''";
  if (!/[^\w@%+=:,./-]/.test(value)) return value;
  return "'" + value.replace(/'/g, `'"'"'`) + "'";
}

/** One bash word: the two placeholders expand once, all else is literal. */
export function word(value: string): string {
  const parts = value.split(/(\$\{PLUGIN_(?:ROOT|DATA)\})/);
  const quoted = parts.map((part, i) =>
    !part ? '' : i % 2 ? (part === '${PLUGIN_ROOT}' ? '"$root"' : '"$data"') : shellQuote(part));
  return quoted.join('') || "''";
}

export function launcher(
  description: Description, name: string, server: StdioServer, bash: string, env: string, dataEnv?: string,
): string {
  const plugin = description.manifest.name;
  const command = server.command;
  // A bare name is left to PATH lookup at launch; `./` is plugin-relative.
  const executable = command.startsWith('./') ? '"$root"' + shellQuote(command.slice(1)) : shellQuote(command);
  const data = '${XDG_DATA_HOME:-$HOME/.local/share}/agent-distro/plugins/' + plugin;
  const lines = [
    `#!${bash}`,
    `# ${plugin}: MCP server ${JSON.stringify(name)}, launched per Agent Plugins ${description.version}.`,
    'set -euo pipefail',
    `root=$(cd -- ${shellQuote(description.root)} && pwd -P)`,
    'data=' + (dataEnv ? '${' + dataEnv + ':-' + data + '}' : data),
    'mkdir -p -- "$data"',
    'data=$(cd -- "$data" && pwd -P)',
  ];
  if (server.cwd !== undefined) {
    const cwd = server.cwd;
    const target = cwd.startsWith('./') ? '"$root"/' + word(cwd.slice(2)) : word(cwd);
    const base = server.cwdBase === 'root' ? '"$root"' : '"$data"';
    lines.push(
      `cd -- ${target}`,
      `case "$(pwd -P)/" in ${base}/*) ;; *)`,
      `  echo ${shellQuote(`${plugin}: MCP server ${name}: cwd escapes its root`)} >&2; exit 1 ;;`,
      'esac',
    );
  } else {
    // The launch directory, not the plugin root: the spec's default is the
    // plugin root (§7.2.1), which for a plugin named by a flake reference is a
    // directory under /nix/store — and `nix run github:…` cannot run from
    // there at all. AGENT_DISTRO_CWD is the directory the harness was launched
    // in, exported by launch.ts; a wrapper run outside a launch keeps the
    // spec's answer. A plugin's own `cwd` is its author's instruction and is
    // untouched above.
    lines.push('cd -- "${AGENT_DISTRO_CWD:-$root}"');
  }
  // Configured env overlays the inherited environment, then PLUGIN_ROOT and
  // PLUGIN_DATA are set last (§9.1). `env` accepts names bash cannot export.
  const assignments = Object.entries(server.env).map(([key, value]) => shellQuote(key + '=') + word(value));
  assignments.push('"PLUGIN_ROOT=$root"', '"PLUGIN_DATA=$data"');
  lines.push(['exec', shellQuote(env), '--', ...assignments, executable, ...server.args.map(word)].join(' '));
  return lines.join('\n') + '\n';
}
