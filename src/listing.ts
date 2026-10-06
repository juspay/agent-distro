/**
 * What `agent-distro --list --json` prints, and what the picker draws: one
 * value computed in lib/picker.nix, so the two cannot drift.
 *
 *   { "profiles": [ { "description": "…",
 *                     "harnesses": [ { "name": "claude", "tagline": "…",
 *                                      "title": "Claude Code", "version": "2.1.291" } ],
 *                     "name": "juspay" } ] }
 *
 * The first profile is the default; `harnesses` is in menu order. `version`
 * is the display version, without the package's `+` revision suffix.
 */

export type Harness = {
  /** The command name, and the `AI_HARNESS` value. */
  name: string;
  title: string;
  tagline: string;
  version: string;
};

export type Profile = {
  /** The `AI_PROFILE` value. */
  name: string;
  description: string;
  harnesses: Harness[];
};

export type Listing = {
  /** The default profile first. */
  profiles: Profile[];
};

type Field = 'string' | 'name' | 'list';

function record(value: unknown, path: string, keys: Record<string, Field>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`);
  const fields = value as Record<string, unknown>;
  for (const [key, type] of Object.entries(keys)) {
    const field = fields[key];
    const at = `${path}.${key}`;
    if (field === undefined) throw new Error(`${at} is missing`);
    if (type === 'list') {
      if (!Array.isArray(field)) throw new Error(`${at} is not an array`);
      if (!field.length) throw new Error(`${at} is empty`);
      continue;
    }
    if (typeof field !== 'string') throw new Error(`${at} is not a string`);
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
  const listing = record(value, 'listing', { profiles: 'list' }) as Listing;
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
