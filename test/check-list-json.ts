/**
 * `agent-distro --list --json` without a VM: it is a `Listing`, it is the
 * menu the picker is handed with the profile in effect added, `--list` prints
 * the same rows under that profile, and each version is the launcher's
 * without its `+` suffix; each bundle's `profile.json` names its profile as
 * the listing does. Outside any repository and without AI_PROFILE, the
 * profile in effect is the built-in one.
 *
 * Usage: node check-list-json.ts SRC AGENT_DISTRO PROFILE=BUNDLE...
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Erased at run time; the module itself comes from SRC.
import type { Listing } from '../src/listing.ts';

const [src, agentDistro, ...bundles] = process.argv.slice(2);
const { parseListing, parseProfileFile } = await import(join(src, 'listing.ts'));
const run = (...args: string[]) => execFileSync(agentDistro, args, { encoding: 'utf8' });

const listing: Listing = parseListing(JSON.parse(run('--list', '--json')));
assert.deepEqual(Object.keys(listing), ['profiles', 'profile']);
assert.deepEqual(listing.profile, {
  name: listing.profiles[0].name, description: listing.profiles[0].description, source: 'builtin', origin: listing.profiles[0].name,
});
// Exactly these fields, in this order, as Kolu reads them.
assert.deepEqual(Object.keys(listing.profile!), ['name', 'description', 'source', 'origin']);

// Both sides come from one Nix string, so equality only guards the shell
// quoting; what matters is that the chooser's copy is a valid Listing too.
const script = readFileSync(agentDistro, 'utf8');
const quoted = script.match(/picker\/choose\.ts ((?:'[^']*'|\\')+)/);
assert.ok(quoted, 'agent-distro passes the chooser no quoted menu');
const menu = quoted[1].replace(/'([^']*)'|\\'/g, (_: string, text?: string) => text ?? "'");
const { profile: _, ...withoutProfile } = listing;
assert.deepEqual(parseListing(JSON.parse(menu)), withoutProfile);

const [builtIn] = listing.profiles;
assert.equal(
  run('--list'),
  `${builtIn.name} · ${builtIn.description} · built in\n` + builtIn.harnesses.map((h) => `${h.name} ${h.title} ${h.version}\n`).join(''),
);
// Anything after --list [--json] is an error, not ignored.
for (const args of [['--list', '--bogus'], ['--list', '--json', 'extra'], ['--list', 'claude']]) {
  const result = spawnSync(agentDistro, args, { encoding: 'utf8' });
  assert.equal(result.status, 2, args.join(' '));
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage: agent-distro --list \[--json\]/);
}

// Each bundle records its launchers' own versions, suffix and all.
let suffixed = 0;
assert.deepEqual(bundles.map((b) => b.split('=')[0]), listing.profiles.map((p) => p.name));
for (const entry of bundles) {
  const [name, bundle] = entry.split('=');
  const profile = listing.profiles.find((p) => p.name === name)!;
  // The bundle names its profile as the listing does.
  assert.deepEqual(parseProfileFile(readFileSync(`${bundle}/share/agent-distro/profile.json`, 'utf8')), {
    name: profile.name,
    description: profile.description,
  });
  const recorded = readFileSync(`${bundle}/share/agent-distro/versions`, 'utf8').trimEnd().split('\n').map((line) => line.split('\t'));
  assert.deepEqual(profile.harnesses.map((h) => [h.name, h.title]), recorded.map(([n, title]) => [n, title]));
  recorded.forEach(([, , version], i) => {
    if (version.includes('+')) suffixed++;
    assert.equal(profile.harnesses[i].version, version.split('+')[0]);
  });
}
// Stripping is only tested while some pinned harness carries a suffix (OpenCode does).
assert.ok(suffixed > 0, 'no pinned version has a + suffix, so stripping goes untested');

// What the type rejects, each naming the field.
const harness = { name: 'x', title: 'X', tagline: '', version: '1' };
const profile = (extra: object = {}) => ({ name: 'a', description: '', harnesses: [harness], ...extra });
for (const [bad, message] of [
  [{}, /listing\.profiles is missing/],
  [{ profiles: [] }, /listing\.profiles is empty/],
  [{ profiles: [profile({ harnesses: [] })] }, /profiles\[0\]\.harnesses is empty/],
  [{ profiles: [profile({ name: '' })] }, /profiles\[0\]\.name is empty/],
  [{ profiles: [profile({ name: 'a/b' })] }, /contains whitespace or \//],
  [{ profiles: [profile({ name: 'a b' })] }, /contains whitespace or \//],
  [{ profiles: [profile(), profile()] }, /profiles names a twice/],
  [{ profiles: [profile({ harnesses: [harness, harness] })] }, /profiles\[0\]\.harnesses names x twice/],
  [{ profiles: [profile({ harnesses: [{ ...harness, name: 'x/y' }] })] }, /harnesses\[0\]\.name/],
  [{ profiles: [profile({ harnesses: [{ ...harness, version: '1+2' }] })] }, /\+ suffix/],
  [{ profiles: [profile({ harnesses: [{ ...harness, version: undefined }] })] }, /version is missing/],
  [{ profiles: [profile({ harnesses: [{ ...harness, tagline: null }] })] }, /tagline is not a string/],
  [{ profiles: [profile({ extra: 1 })] }, /unknown field extra/],
  [{ default: 'a', profiles: [profile()] }, /unknown field default/],
  [{ profiles: [profile()], profile: { name: 'a', description: '', source: 'built-in', origin: 'a' } }, /listing\.profile\.source is not positional/],
  [{ profiles: [profile()], profile: { name: 'a', description: '', source: 'builtin' } }, /listing\.profile\.origin is missing/],
  [{ profiles: [profile()], profile: { name: 'a', description: '', source: 'builtin', origin: 'a', reference: 'a' } }, /listing\.profile has unknown field reference/],
  [{ profiles: [profile()], profile: [] }, /listing\.profile is not an object/],
] as const) {
  assert.throws(() => parseListing(structuredClone(bad)), message, JSON.stringify(bad));
}
assert.deepEqual(parseProfileFile('{"name": "a", "description": ""}'), { name: 'a', description: '' });
for (const [bad, message] of [
  ['[]', /profile is not an object/],
  ['{"description": ""}', /profile\.name is missing/],
  ['{"name": "a"}', /profile\.description is missing/],
  ['{"name": 1, "description": ""}', /profile\.name is not a string/],
  ['{"name": "a", "description": null}', /profile\.description is not a string/],
  ['{"name": "a b", "description": ""}', /contains whitespace or \//],
  ['{"name": "a", "description": "", "harnesses": []}', /unknown field harnesses/],
] as const) {
  assert.throws(() => parseProfileFile(bad), message, bad);
}
console.log(`--list --json: ${listing.profiles.length} profiles, ${suffixed} suffixed versions stripped`);
