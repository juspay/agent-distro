/*
 * The index URL built from a configured base (src/update/ca-index.ts), without
 * a store or a network: `caIndex` is a config value, so only an https base
 * without credentials, query or fragment may become a request, and the
 * revision, system and profile must not be able to move it.
 *
 * Usage: node check-index-url.ts SRC
 *
 * SRC is the tree to check — `runtime.tree/src` under nix, a store path known
 * only when this runs — so the module is imported at run time, as the checks
 * beside this one do.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';

const [src] = process.argv.slice(2);
const { indexEntryUrl } = await import(join(src, 'update/ca-index.ts'));

const revision = 'a'.repeat(40);
const href = (base: string, over: { revision?: string; system?: string; profile?: string } = {}) =>
  indexEntryUrl(base, over.revision ?? revision, over.system ?? 'x86_64-linux', over.profile ?? 'vanilla')?.href ?? null;

// The base lib/ca-index.nix states, as mkUpdater writes it into the config.
assert.equal(href('https://raw.githubusercontent.com/juspay/agent-distro/ca-index'),
  `https://raw.githubusercontent.com/juspay/agent-distro/ca-index/${revision}/x86_64-linux/vanilla.json`);
// A trailing slash does not double, and a base with a path keeps it.
assert.equal(href('https://cache.example/ca-index/'),
  `https://cache.example/ca-index/${revision}/x86_64-linux/vanilla.json`);
assert.equal(href('https://distro.example/some/where'),
  `https://distro.example/some/where/${revision}/x86_64-linux/vanilla.json`);
// Another host is allowed: a distribution's index is its own, and the config,
// not the host, is the trust boundary.
assert.equal(href('https://other.example/index'),
  `https://other.example/index/${revision}/x86_64-linux/vanilla.json`);

// Refused: no other scheme, no credentials, no query, no fragment, no relative
// path, nothing unparseable. Each of these must not be fetched at all.
for (const base of [
  'http://cache.example/ca-index',
  'file:///tmp/ca-index',
  'ftp://cache.example/ca-index',
  'ssh://git@cache.example/index',
  'https://user:pw@cache.example/ca-index',
  'https://user@cache.example/ca-index',
  'https://cache.example/ca-index?token=1',
  'https://cache.example/ca-index#frag',
  'ca-index',
  '/tmp/ca-index',
  './ca-index',
  '',
  'https://',
]) {
  assert.equal(href(base), null, base);
}

// The revision, system and profile are segments: an escape attempt stays one
// segment of the base's path, and a dot segment — which would collapse that
// path — is refused outright.
assert.equal(href('https://cache.example/i', { revision: '../../evil' }),
  'https://cache.example/i/..%2F..%2Fevil/x86_64-linux/vanilla.json');
for (const over of [{ revision: '..' }, { revision: '.' }, { system: '..' }, { profile: '.' }]) {
  assert.equal(href('https://cache.example/i', over), null, JSON.stringify(over));
}
assert.equal(href('https://cache.example/i', { system: 'x86_64 linux', profile: 'p/q' }),
  `https://cache.example/i/${revision}/x86_64%20linux/p%2Fq.json`);
assert.equal(href('https://cache.example/i', { revision: 'r', system: 's', profile: 'v' }),
  'https://cache.example/i/r/s/v.json');
// A dot inside a segment is ordinary — a version, a host triple.
assert.equal(href('https://cache.example/i', { profile: 'v1.2' }),
  `https://cache.example/i/${revision}/x86_64-linux/v1.2.json`);
