/**
 * What `agent-distro --list --json` prints, and what the picker draws: one
 * value computed in lib/picker.nix, so the two cannot drift, with the profile
 * in effect resolved at launch (src/profile/resolve.ts).
 *
 *   { "profiles": [ { "description": "…",
 *                     "harnesses": [ { "name": "claude", "tagline": "…",
 *                                      "title": "Claude Code", "version": "2.1.291" } ],
 *                     "name": "vanilla" } ],
 *     "profile": { "description": "…", "name": "ekala",
 *                  "origin": "/home/me/ekala/agent-distro.nix", "source": "repository" } }
 *
 * `profiles` is the launcher's built-in profile; `harnesses` is in menu order.
 * `version` is the display version, without the package's `+` revision
 * suffix. `profile` is the one a launch from here uses, and where it came
 * from: `source` is `positional` (`agent-distro <reference>`), `repository`
 * (the `agent-distro.nix` found from the working directory up to the git
 * root), `variable` (AI_PROFILE) or `builtin`, and `origin` is that reference,
 * the path to that `agent-distro.nix`, or the built-in name. The picker's own
 * menu has no `profile`; `--list --json` always does.
 *
 * A profile's bundle is self-describing, so a consumer reads files rather than
 * running its picker: `share/agent-distro/profile.json` is a `ProfileFile`,
 * from the same profile attributes as this listing's `name` and `description`,
 *
 *   { "description": "…", "name": "juspay" }
 *
 * and `share/agent-distro/versions` has one `name\ttitle\tversion` line per
 * harness, in menu order, each version as packaged (`+` suffix and all).
 */

export type Harness = {
  /** The command name, and the `AI_HARNESS` value. */
  name: string;
  title: string;
  tagline: string;
  version: string;
};

export type Profile = {
  /** The built-in profile's name, an `AI_PROFILE` value. */
  name: string;
  description: string;
  harnesses: Harness[];
};

export type Source = 'positional' | 'repository' | 'variable' | 'builtin';

/** The profile in effect, and where it came from. */
export type InEffect = {
  name: string;
  description: string;
  source: Source;
  /** The reference, the path to the `agent-distro.nix`, or the built-in name. */
  origin: string;
};

export type Listing = {
  /** The launcher's built-in profile. */
  profiles: Profile[];
  profile?: InEffect;
};

/** Where the profile in effect came from, in a few words. */
export function sourceText({ source, origin }: Pick<InEffect, 'source' | 'origin'>): string {
  if (source === 'positional') return `chosen as ${origin}`;
  if (source === 'repository') return `from ${origin}`;
  if (source === 'variable') return `from AI_PROFILE=${origin}`;
  return 'built in';
}

/** A bundle's `share/agent-distro/profile.json`. */
export type ProfileFile = Pick<Profile, 'name' | 'description'>;

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
    if (type === 'source' && !['positional', 'repository', 'variable', 'builtin'].includes(field)) {
      throw new Error(`${at} is not positional, repository, variable or builtin`);
    }
    // Names are selectors, joined as `profile/harness` and listed space-separated.
    if (type === 'name' && !/^[^\s/]+$/.test(field)) throw new Error(`${at} is empty or contains whitespace or /`);
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
  const listing = record(value, 'listing', { profiles: 'list', profile: 'object' }, ['profile']) as Listing;
  if (listing.profile !== undefined) {
    record(listing.profile, 'listing.profile', { name: 'name', description: 'string', source: 'source', origin: 'string' });
  }
  listing.profiles.forEach((profile, i) => {
    record(profile, `profiles[${i}]`, { name: 'name', description: 'string', harnesses: 'list' });
    profile.harnesses.forEach((harness, j) => {
      const path = `profiles[${i}].harnesses[${j}]`;
      record(harness, path, { name: 'name', title: 'string', tagline: 'string', version: 'string' });
      if (harness.version.includes('+')) throw new Error(`${path}.version keeps a + suffix`);
    });
    unique(profile.harnesses.map((h) => h.name), `profiles[${i}].harnesses`);
  });
  unique(listing.profiles.map((p) => p.name), 'profiles');
  return listing;
}

/** Parse a bundle's `profile.json` as a `ProfileFile`; throws naming the first bad field. */
export function parseProfileFile(text: string): ProfileFile {
  return record(JSON.parse(text), 'profile', { name: 'name', description: 'string' }) as ProfileFile;
}
