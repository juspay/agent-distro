/**
 * Whether a content-addressed package can be installed on this system at all.
 *
 * No, on macOS: the rewrite edits every Mach-O in the closure that embeds a
 * store path, which invalidates its ad-hoc signature, and arm64 then kills the
 * binary on exec. An entry for such a system publishes the signed package only,
 * and the updater takes its ordinary skip there — even where an older entry
 * still names a `ca`, which is what the index carried before this was known.
 */
export function takesContentAddressed(system: string): boolean {
  return !system.endsWith('-darwin');
}

/**
 * The flake attribute the index names, and the updater builds, when the
 * updater's own config names none: the one package
 * (`packages.<system>.default`). CI publishes each entry under the attribute
 * it published (`.github/workflows/cache.yml`), so the file is this name;
 * `mkUpdater`'s `attribute` is that same name for a build that names another.
 * The callers resolve a config's `attribute` against this once
 * (src/update/update.ts), and hand `indexEntryUrl` the result.
 */
export const ATTRIBUTE = 'default';

/**
 * Where one content-addressed index entry is, from the configured base.
 *
 * `caIndex` is untrusted input to this process: it arrives in the updater's
 * config file, which this repository's build writes from lib/ca-index.nix —
 * but a distribution's own `services.agent-distro.caIndex` is that
 * distribution's to name, and it decides which index its users read. So the
 * base is parsed here, once, and refused unless it is an `https:` URL with no
 * credentials, query or fragment; the revision and the system go in as path
 * segments, encoded, so neither can move the request to another host or out of
 * the base's path.
 *
 * There is deliberately no allowlist of hosts: a distribution's index is its
 * own, and the trust boundary is that this config is a file the build wrote
 * (or the user set), not something fetched.
 *
 * Null is "do not fetch": the caller warns and the update takes its ordinary
 * skip.
 */
export function indexEntryUrl(base: string, revision: string, system: string, attribute: string): URL | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  // A dot segment would collapse the base's path when the URL is serialized —
  // the parser reads a percent-encoded `.` as a dot too — so those are refused
  // rather than encoded: no revision or system is one.
  if ([revision, system].some((value) => /^\.{1,2}$/.test(value))) return null;
  const segments = [revision, system, attribute].map(encodeURIComponent);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${segments.join('/')}.json`;
  return url;
}
