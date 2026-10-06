/**
 * What `agent-distro --list --json` prints, and what the picker draws: one
 * value computed in lib/picker.nix, so the two cannot drift.
 *
 *   { "default": "juspay",
 *     "profiles": [ { "name": "juspay", "description": "…",
 *                     "harnesses": [ { "name": "claude", "title": "Claude Code",
 *                                      "tagline": "…", "version": "2.1.291" } ] } ] }
 *
 * `profiles` starts with the default; `harnesses` is in menu order. `version`
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
  /** The profile the registry names; always `profiles[0].name`. */
  default: string;
  profiles: Profile[];
};

function fields(value: unknown, path: string, keys: Record<string, 'string' | 'array'>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`);
  const record = value as Record<string, unknown>;
  for (const [key, type] of Object.entries(keys)) {
    const field = record[key];
    if (type === 'array' ? !Array.isArray(field) : typeof field !== type) {
      throw new Error(`${path}.${key} is not ${type === 'array' ? 'an array' : 'a string'}`);
    }
  }
  const extra = Object.keys(record).filter((key) => !(key in keys));
  if (extra.length) throw new Error(`${path} has unknown field ${extra[0]}`);
  return record;
}

/** Check a parsed `--list --json` value against `Listing`; throws naming the first bad field. */
export function parseListing(value: unknown): Listing {
  const listing = fields(value, 'listing', { default: 'string', profiles: 'array' }) as Listing;
  if (!listing.profiles.length) throw new Error('listing.profiles is empty');
  listing.profiles.forEach((profile, i) => {
    fields(profile, `profiles[${i}]`, { name: 'string', description: 'string', harnesses: 'array' });
    profile.harnesses.forEach((harness, j) => {
      const path = `profiles[${i}].harnesses[${j}]`;
      fields(harness, path, { name: 'string', title: 'string', tagline: 'string', version: 'string' });
      if (harness.version.includes('+')) throw new Error(`${path}.version keeps a + suffix`);
    });
  });
  if (listing.profiles[0].name !== listing.default) throw new Error('listing.profiles does not start with the default');
  return listing;
}
