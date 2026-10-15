/**
 * What `agent-distro --list --json` prints, and what the picker draws: one
 * value computed in lib/picker.nix from the versions the package ships
 * (lib/mk-launchers.nix), with the profile in effect resolved at launch
 * (src/profile/resolve.ts).
 *
 *   { "harnesses": [ { "name": "claude", "tagline": "…",
 *                      "title": "Claude Code", "version": "2.1.291" } ],
 *     "profile": { "description": "…", "name": "ekala",
 *                  "origin": "/home/me/ekala/agent-distro.nix", "source": "repository",
 *                  "over": { "description": "…", "name": "juspay",
 *                            "origin": "github:juspay/skills", "source": "variable" } } }
 *
 * `harnesses` is what the package carries, in menu order. `version` is the
 * display version, without the package's `+` revision suffix. `profile` is the
 * one a launch from here uses, and where it came from: `source` is
 * `positional` (`agent-distro <reference>`), `repository` (the
 * `agent-distro.nix` found from the working directory up to the git root) or
 * `variable` (AI_PROFILE), and `origin` is that reference or the path to that
 * `agent-distro.nix`. `over`, when present, is the profile it is composed
 * over, in the same shape: a repository's over your AI_PROFILE, each entry
 * over the one before. A launch with no profile at all — nothing set, and no
 * repository — has no `profile` here.
 */

export type Harness = {
  /** The command name, and the `AI_HARNESS` value. */
  name: string;
  title: string;
  tagline: string;
  version: string;
};

/** Where the profile in effect came from, first to last in precedence. */
export const SOURCES = ['positional', 'repository', 'variable'] as const;
export type Source = typeof SOURCES[number];

/** The profile in effect, and where it came from. */
export type InEffect = {
  name: string;
  description: string;
  source: Source;
  /** The reference, or the path to the `agent-distro.nix`. */
  origin: string;
  /** The profile this one is composed over, if any. */
  over?: InEffect;
};

export type Listing = {
  /** The harnesses the package carries, in menu order. */
  harnesses: Harness[];
  /** The profile in effect for a launch from the same directory and environment. */
  profile?: InEffect;
};

/** Names are selectors: one shell word, no `/`. */
export const isName = (value: unknown): value is string => typeof value === 'string' && /^[^\s/]+$/.test(value);

/** The profile in effect's name, then those it is composed over: `juspay + repo`. */
export function nameText({ name, over }: Pick<InEffect, 'name' | 'over'>): string {
  return over ? `${nameText(over)} + ${name}` : name;
}

/** Where the profile in effect came from, in a few words, then what it is composed over. */
export function sourceText(profile: Pick<InEffect, 'source' | 'origin' | 'over'>): string {
  if (profile.source === 'positional') return `chosen as ${profile.origin}`;
  const where = ({ source, origin, over }: Pick<InEffect, 'source' | 'origin' | 'over'>): string =>
    `${source === 'variable' ? 'AI_PROFILE=' : ''}${origin}${over ? ` over ${where(over)}` : ''}`;
  return `from ${where(profile)}`;
}

type Field = 'string' | 'name' | 'list' | 'source' | 'object';

function record(value: unknown, path: string, keys: Record<string, Field>, optional: string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`);
  const fields = value as Record<string, unknown>;
  for (const [key, type] of Object.entries(keys)) {
    const field = fields[key];
    const at = `${path}.${key}`;
    if (field === undefined && optional.includes(key)) continue;
    if (field === undefined) throw new Error(`${at} is missing`);
    if (type === 'list') {
      if (!Array.isArray(field)) throw new Error(`${at} is not an array`);
      if (!field.length) throw new Error(`${at} is empty`);
      continue;
    }
    // Checked by the caller, against its own fields.
    if (type === 'object') continue;
    if (typeof field !== 'string') throw new Error(`${at} is not a string`);
    if (type === 'source' && !(SOURCES as readonly string[]).includes(field)) {
      throw new Error(`${at} is not ${SOURCES.join(', ')}`);
    }
    if (type === 'name' && !isName(field)) throw new Error(`${at} is empty or contains whitespace or /`);
  }
  const extra = Object.keys(fields).filter((key) => !(key in keys));
  if (extra.length) throw new Error(`${path} has unknown field ${extra[0]}`);
  return fields;
}

function unique(names: string[], path: string) {
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) throw new Error(`${path} names ${duplicate} twice`);
}

/** Check a parsed `--list --json` value against `Listing`; throws naming the first bad field. */
export function parseListing(value: unknown): Listing {
  const listing = record(value, 'listing', { harnesses: 'list', profile: 'object' }, ['profile']) as Listing;
  const inEffect = (value: unknown, path: string) => {
    const profile = record(value, path, { name: 'name', description: 'string', source: 'source', origin: 'string', over: 'object' }, ['over']);
    if (profile.over !== undefined) inEffect(profile.over, `${path}.over`);
  };
  if (listing.profile !== undefined) inEffect(listing.profile, 'listing.profile');
  listing.harnesses.forEach((harness, i) => {
    const path = `harnesses[${i}]`;
    record(harness, path, { name: 'name', title: 'string', tagline: 'string', version: 'string' });
    if (harness.version.includes('+')) throw new Error(`${path}.version keeps a + suffix`);
  });
  unique(listing.harnesses.map((h) => h.name), 'harnesses');
  return listing;
}
