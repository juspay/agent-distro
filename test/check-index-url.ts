/*
 * The index (src/update/ca-index.ts), without a store or a network: the URL
 * built from a configured base — `caIndex` is a config value, so only an https
 * base without credentials, query or fragment may become a request, and the
 * revision and system must not be able to move it — and which systems take a
 * content-addressed package at all (not macOS, where the rewrite leaves a
 * Mach-O that arm64 kills). The entry's name is the attribute the updater's
 * config names, `default` unless it says otherwise.
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
const { indexEntryUrl, takesContentAddressed, ATTRIBUTE } = await import(join(src, 'update/ca-index.ts'));

const revision = 'a'.repeat(40);
const href = (base: string, over: { revision?: string; system?: string; attribute?: string } = {}) =>
  indexEntryUrl(base, over.revision ?? revision, over.system ?? 'x86_64-linux', over.attribute ?? ATTRIBUTE)?.href ?? null;
assert.equal(ATTRIBUTE, 'default', 'the index names one attribute, the one package');

// The base lib/ca-index.nix states, as mkUpdater writes it into the config.
assert.equal(href('https://raw.githubusercontent.com/juspay/agent-distro/ca-index'),
  `https://raw.githubusercontent.com/juspay/agent-distro/ca-index/${revision}/x86_64-linux/default.json`);
// A trailing slash does not double, and a base with a path keeps it.
assert.equal(href('https://cache.example/ca-index/'),
  `https://cache.example/ca-index/${revision}/x86_64-linux/default.json`);
assert.equal(href('https://distro.example/some/where'),
  `https://distro.example/some/where/${revision}/x86_64-linux/default.json`);
// Another host is allowed: a distribution's index is its own, and the config,
// not the host, is the trust boundary.
assert.equal(href('https://other.example/index'),
  `https://other.example/index/${revision}/x86_64-linux/default.json`);
// A config naming another attribute (lib/mk-updater.nix's `attribute`) fetches
// that entry, not the constant: the alias the transition window publishes, or
// a distribution's own name for its package.
assert.equal(href('https://distro.example/i', { attribute: 'other' }),
  `https://distro.example/i/${revision}/x86_64-linux/other.json`);
assert.equal(href('https://distro.example/i', { attribute: 'vanilla' }),
  `https://distro.example/i/${revision}/x86_64-linux/vanilla.json`);

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

// The revision and system are segments: an escape attempt stays one segment of
// the base's path, and a dot segment — which would collapse that path — is
// refused outright.
assert.equal(href('https://cache.example/i', { revision: '../../evil' }),
  'https://cache.example/i/..%2F..%2Fevil/x86_64-linux/default.json');
for (const over of [{ revision: '..' }, { revision: '.' }, { system: '..' }, { system: '.' }]) {
  assert.equal(href('https://cache.example/i', over), null, JSON.stringify(over));
}
assert.equal(href('https://cache.example/i', { system: 'x86_64 linux' }),
  `https://cache.example/i/${revision}/x86_64%20linux/default.json`);
assert.equal(href('https://cache.example/i', { revision: 'r', system: 's' }),
  'https://cache.example/i/r/s/default.json');
// A dot inside a segment is ordinary — a version, a host triple.
assert.equal(href('https://cache.example/i', { revision: 'v1.2' }),
  `https://cache.example/i/v1.2/x86_64-linux/default.json`);

// macOS never takes a rewritten package: its entries name the signed one, and an
// older entry that still names a `ca` must not be fetched either.
assert.equal(takesContentAddressed('x86_64-linux'), true);
assert.equal(takesContentAddressed('aarch64-linux'), true);
assert.equal(takesContentAddressed('aarch64-darwin'), false);
assert.equal(takesContentAddressed('x86_64-darwin'), false);
