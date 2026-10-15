/**
 * A package's `share/agent-distro/versions` — one `name\ttitle\tversion` line
 * per harness, in menu order (lib/mk-launchers.nix writes it) — and what
 * changed between two of them, in the words the history log records
 * (`updated: Claude Code 2.0.1 → 2.0.3, Pi added 0.4`). No file I/O.
 */

/** One harness a package carries. */
export type Version = {
  /** The command name (`claude`). */
  name: string;
  /** How people know it (`Claude Code`). */
  title: string;
  version: string;
};

/** Where a package lists its harnesses, relative to the package. */
export const VERSIONS_FILE = 'share/agent-distro/versions';

/**
 * A versions file's text. A version may itself contain tabs. Throws on a line
 * without the three fields, naming it.
 */
export function parseVersions(text: string): Version[] {
  return text.split('\n').filter((line) => line !== '').map((line) => {
    const [name, title, ...version] = line.split('\t');
    if (!name || title === undefined || version.length === 0) {
      throw new Error(`versions line is not name\\ttitle\\tversion: ${JSON.stringify(line)}`);
    }
    return { name, title, version: version.join('\t') };
  });
}

/**
 * What changed between two packages: `previous` is null when nothing was
 * installed before (every harness is named with its version), `next` null when
 * the new package records no versions.
 */
export function changes(previous: Version[] | null, next: Version[] | null): string {
  if (next === null) return 'versions not recorded by this package';
  const before = new Map(previous?.map((v) => [v.name, v]));
  const result: string[] = [];
  for (const { name, title, version } of next) {
    const old = before.get(name);
    if (previous === null) result.push(`${title} ${version}`);
    else if (old === undefined) result.push(`${title} added ${version}`);
    else if (old.version !== version) result.push(`${title} ${old.version} → ${version}`);
  }
  const after = new Set(next.map((v) => v.name));
  for (const { name, title } of previous ?? []) {
    if (!after.has(name)) result.push(`${title} removed`);
  }
  return result.join(', ') || 'no harness version changed';
}
