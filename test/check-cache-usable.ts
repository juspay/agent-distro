// Usage: node check-cache-usable.ts SRC
import assert from 'node:assert/strict';
import { join } from 'node:path';

const { cacheUsable } = await import(join(process.argv[2], 'update/cache.ts'));

function check(label: string, expected: 'usable' | 'unusable', trusted: boolean, substituters: string, keys: string, url: string, key: string) {
  assert.equal(cacheUsable(trusted, substituters, keys, url, key) ? 'usable' : 'unusable', expected, label);
}

const url = 'https://cache.example/oss';
const key = 'oss:abc=';
check('trusted needs no system config', 'usable', true, '', '', url, key);
check('untrusted, nothing configured', 'unusable', false, '', '', url, key);
check('untrusted, listed with key', 'usable', false, `https://cache.nixos.org ${url}`, `cache.nixos.org-1:x ${key}`, url, key);
check('untrusted, url without key', 'unusable', false, url, 'cache.nixos.org-1:x', url, key);
check('untrusted, key without url', 'unusable', false, 'https://cache.nixos.org', key, url, key);
check('system url has trailing slash', 'usable', false, `${url}/`, key, url, key);
check('module url has trailing slash', 'usable', false, url, key, `${url}/`, key);
check('prefix of another url is not a match', 'unusable', false, `${url}/extra`, key, url, key);
check('longer url is not a match', 'unusable', false, url, key, `${url}-other`, key);
