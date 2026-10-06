/**
 * `agent-distro --list --json` without a VM: it is a `Listing`, it is the
 * very menu the picker is handed, `--list` prints the same rows, and each
 * version is the launcher's without its `+` suffix.
 *
 * Usage: node check-list-json.ts SRC AGENT_DISTRO PROFILE=BUNDLE...
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Erased at run time; the module itself comes from SRC.
import type { Listing } from '../src/listing.ts';

const [src, agentDistro, ...bundles] = process.argv.slice(2);
const { parseListing } = await import(join(src, 'listing.ts'));
const run = (...args: string[]) => execFileSync(agentDistro, args, { encoding: 'utf8' });

const listing: Listing = parseListing(JSON.parse(run('--list', '--json')));

// The picker's MENU_JSON, as the generated script quotes it for the shell.
const script = readFileSync(agentDistro, 'utf8');
const quoted = script.match(/picker\/choose\.ts ((?:'[^']*'|\\')+)/);
assert.ok(quoted, 'agent-distro passes the chooser no quoted menu');
const menu = quoted[1].replace(/'([^']*)'|\\'/g, (_: string, text?: string) => text ?? "'");
assert.deepEqual(JSON.parse(menu), listing);

assert.equal(
  run('--list'),
  listing.profiles.flatMap((p) => p.harnesses.map((h) => `${p.name} ${h.name} ${h.title} ${h.version}\n`)).join(''),
);

// Each bundle records its launchers' own versions, suffix and all.
let suffixed = 0;
assert.deepEqual(bundles.map((b) => b.split('=')[0]), listing.profiles.map((p) => p.name));
for (const entry of bundles) {
  const [name, bundle] = entry.split('=');
  const profile = listing.profiles.find((p) => p.name === name)!;
  const recorded = readFileSync(`${bundle}/share/agent-distro/versions`, 'utf8').trimEnd().split('\n').map((line) => line.split('\t'));
  assert.deepEqual(profile.harnesses.map((h) => [h.name, h.title]), recorded.map(([n, title]) => [n, title]));
  recorded.forEach(([, , version], i) => {
    if (version.includes('+')) suffixed++;
    assert.equal(profile.harnesses[i].version, version.split('+')[0]);
  });
}
// Not vacuous while any pinned harness carries a suffix (OpenCode does).
console.log(`--list --json: ${listing.profiles.length} profiles, ${suffixed} suffixed versions stripped`);

// What the type rejects.
for (const [bad, message] of [
  [{ default: 'a', profiles: [] }, /empty/],
  [{ default: 'b', profiles: [{ name: 'a', description: '', harnesses: [] }] }, /start with the default/],
  [{ default: 'a', profiles: [{ name: 'a', description: '', harnesses: [{ name: 'x', title: 'X', tagline: '', version: '1+2' }] }] }, /\+ suffix/],
  [{ default: 'a', profiles: [{ name: 'a', description: '', harnesses: [{ name: 'x', title: 'X', tagline: '' }] }] }, /version is not a string/],
  [{ default: 'a', profiles: [{ name: 'a', description: '', harnesses: [], extra: 1 }] }, /unknown field extra/],
] as const) {
  assert.throws(() => parseListing(structuredClone(bad)), message);
}
