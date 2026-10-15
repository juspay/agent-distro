/**
 * `agent-distro --list --json` without a VM: it is a `Listing`, it is the
 * menu the picker is handed (the profile in effect is added to it), `--list`
 * prints the same rows, and each version is the one the package records in
 * `share/agent-distro/versions`, without its `+` suffix.
 *
 * The package carries no profile, so a run from the build directory — no
 * AI_PROFILE, no repository — has none in effect, and `--list --json` is
 * `{harnesses}` alone. A profile in effect is covered by check-profile.ts
 * (resolution) and test-profiles.nix (a launch).
 *
 * Usage: node check-list-json.ts SRC AGENT_DISTRO PACKAGE
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Erased at run time; the module itself comes from SRC.
import type { Listing } from '../src/listing.ts';

const [src, agentDistro, pkg] = process.argv.slice(2);
const { parseListing } = await import(join(src, 'listing.ts'));
const run = (...args: string[]) => execFileSync(agentDistro, args, { encoding: 'utf8' });

const listing: Listing = parseListing(JSON.parse(run('--list', '--json')));
// Exactly these fields, in this order, as Kolu reads them.
assert.deepEqual(Object.keys(listing), ['harnesses']);
assert.equal(listing.profile, undefined);

// Both sides come from one Nix string, so equality only guards the shell
// quoting; what matters is that the chooser's copy is a valid Listing too.
const script = readFileSync(agentDistro, 'utf8');
const quoted = script.match(/picker\/choose\.ts ((?:'[^']*'|\\')+)/);
assert.ok(quoted, 'agent-distro passes the chooser no quoted menu');
const menu = quoted[1].replace(/'([^']*)'|\\'/g, (_: string, text?: string) => text ?? "'");
assert.deepEqual(parseListing(JSON.parse(menu)), listing);

// With no profile in effect, `--list` is the harness rows alone.
assert.equal(run('--list'), listing.harnesses.map((h) => `${h.name} ${h.title} ${h.version}\n`).join(''));
// Anything after --list [--json] is an error, not ignored.
for (const args of [['--list', '--bogus'], ['--list', '--json', 'extra'], ['--list', 'claude']]) {
  const result = spawnSync(agentDistro, args, { encoding: 'utf8' });
  assert.equal(result.status, 2, args.join(' '));
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage: agent-distro --list \[--json\]/);
}

// The package records its launchers' own versions, and the listing shows them
// without the `+` revision suffix (lib/picker.nix strips it).
const recorded = readFileSync(`${pkg}/share/agent-distro/versions`, 'utf8').trimEnd().split('\n').map((line) => line.split('\t'));
assert.deepEqual(listing.harnesses.map((h) => [h.name, h.title]), recorded.map(([name, title]) => [name, title]));
recorded.forEach(([, , version], i) => {
  assert.equal(listing.harnesses[i].version, version.split('+')[0],
    `${listing.harnesses[i].name}: ${listing.harnesses[i].version} is not ${version} without its revision`);
  assert.ok(!listing.harnesses[i].version.includes('+'),
    `${listing.harnesses[i].name}: the + of ${version} survived`);
});

// What the type rejects, each naming the field.
const harness = { name: 'x', title: 'X', tagline: '', version: '1' };
const of = (...harnesses: object[]) => ({ harnesses });
for (const [bad, message] of [
  [{}, /listing\.harnesses is missing/],
  [of(), /listing\.harnesses is empty/],
  [of(harness, harness), /harnesses names x twice/],
  [of({ ...harness, name: '' }), /harnesses\[0\]\.name is empty/],
  [of({ ...harness, name: 'x/y' }), /contains whitespace or \//],
  [of({ ...harness, name: 'x y' }), /contains whitespace or \//],
  [of({ ...harness, version: '1+2' }), /\+ suffix/],
  [of({ ...harness, version: undefined }), /version is missing/],
  [of({ ...harness, tagline: null }), /tagline is not a string/],
  [of({ ...harness, extra: 1 }), /unknown field extra/],
  [{ ...of(harness), profiles: [] }, /listing has unknown field profiles/],
  [{ ...of(harness), profile: { name: 'a', description: '', source: 'builtin', origin: 'a' } }, /listing\.profile\.source is not positional/],
  [{ ...of(harness), profile: { name: 'a', description: '', source: 'variable' } }, /listing\.profile\.origin is missing/],
  [{ ...of(harness), profile: { name: 'a', description: '', source: 'variable', origin: 'a', reference: 'a' } }, /listing\.profile has unknown field reference/],
  [{ ...of(harness), profile: [] }, /listing\.profile is not an object/],
  [{ ...of(harness), profile: { name: 'a', description: '', source: 'repository', origin: 'a', over: { name: 'b', source: 'variable', origin: 'b' } } },
    /listing\.profile\.over\.description is missing/],
] as const) {
  assert.throws(() => parseListing(structuredClone(bad)), message, JSON.stringify(bad));
}
// A repository's profile composed over AI_PROFILE names it.
const over = { name: 'b', description: '', source: 'variable', origin: 'b' };
assert.deepEqual(
  parseListing({ ...of(harness), profile: { name: 'a', description: '', source: 'repository', origin: 'a', over } }).profile?.over,
  over,
);
console.log(`--list --json: ${listing.harnesses.length} harnesses, no profile in effect`);
