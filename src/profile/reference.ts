/**
 * What a profile reference names, and how a flake reference is fetched — the
 * rules every reader of a reference shares, with no file system or process of
 * their own: the launch (src/profile/resolve.ts) and any program that builds
 * profiles ahead of a launch (kolu) take them from here.
 *
 * A reference is a path — absolute, `~/`, or relative (`./`, `../`, `.`,
 * `..`) to a working directory — or, containing `/` or `:`, a flake reference
 * such as `github:owner/repo?dir=sub`. Anything else names nothing.
 */

/** What a reference names: a path (as written, joined to `home` or `cwd`;
 *  not made real) or a flake reference. */
export type Reference = { path: string } | { flake: string };

function join(base: string, rest: string) {
  if (rest === '') return base;
  let end = base.length;
  while (end > 0 && base[end - 1] === '/') end--;
  return `${base.slice(0, end)}/${rest}`;
}

/**
 * What `reference` names, or null when it names nothing — a word with no `/`
 * or `:`, a `~/` path with no `home`, or a relative path with no `cwd` (a
 * program with no working directory of the user's has none to read it
 * against).
 */
export function classifyReference(
  reference: string,
  where: { home?: string; cwd?: string },
): Reference | null {
  if (reference.startsWith('/')) return { path: reference };
  if (reference === '.' || reference === '..' || reference.startsWith('./') || reference.startsWith('../')) {
    return where.cwd === undefined ? null : { path: join(where.cwd, reference) };
  }
  if (reference.startsWith('~/')) return where.home ? { path: join(where.home, reference.slice(2)) } : null;
  if (/[/:]/.test(reference)) return { flake: reference };
  return null;
}

/**
 * The `nix` arguments that fetch a flake reference and print where it landed.
 * Nix downloads the global flake registry before fetching any reference, so
 * without network even a git+file: one would fail; only an indirect reference
 * (no `scheme:`, such as `nixpkgs/nixos-unstable`) is looked up in it, so the
 * others skip it.
 */
export function prefetchArgs(flake: string): string[] {
  const registry = /^[a-z][a-z0-9+.-]*:/i.test(flake) ? ['--option', 'flake-registry', ''] : [];
  return ['flake', 'prefetch', ...registry, '--json', flake];
}

/**
 * What `nix flake prefetch --json` answered: the reference's directory in the
 * store — the fetched tree, and its `dir` within it — that `dir`, when it has
 * one, and the revision it was locked to, when it has one. Null for an answer
 * that names no store path. Nix never looks for `dir` in the tree, so `path`
 * may name nothing.
 */
export function prefetchedTree(answer: unknown): { path: string; dir?: string; rev?: string } | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const value = answer as {
    storePath?: unknown;
    locked?: { dir?: unknown; rev?: unknown };
    original?: { dir?: unknown };
  };
  if (typeof value.storePath !== 'string' || !value.storePath.startsWith('/')) return null;
  const dir = value.locked?.dir ?? value.original?.dir;
  const rev = value.locked?.rev;
  const within = typeof dir === 'string' && dir !== '';
  return {
    path: within ? join(value.storePath, dir) : value.storePath,
    ...(within ? { dir } : {}),
    ...(typeof rev === 'string' ? { rev } : {}),
  };
}
