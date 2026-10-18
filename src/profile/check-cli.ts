/**
 * Whether a profile's packages are in the binary cache, for this machine: the
 * launcher's no-compile policy (resolve.ts) run ahead of time.
 *
 * Usage: node check-cli.ts INFO_JSON CACHES_JSON [profile]
 *
 * INFO_JSON is the launcher's build-time `Info` (lib/picker.nix); CACHES_JSON
 * is `{ substituters, trustedPublicKeys }`, the caches the answer is about
 * (lib/cache.nix), whatever the machine's own nix configuration says. The
 * profile defaults to the working directory, and may name a directory holding
 * an `agent-distro.nix` or a `plugin.json`, or one of those two files.
 * One line per package; exits 1 if any is not cached or cannot be told, 2 on
 * bad arguments or a missing profile.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from '../log.ts';
import { cacheRoot, LaunchError, printable } from '../plugin/launch.ts';
import { wouldCompile } from '../update/update.ts';
import { isSystemError } from '../util.ts';
import { FILE, findProfile, MANIFEST, nixEnvironment, profileValue, type Info } from './resolve.ts';

type Caches = { substituters: string[]; trustedPublicKeys: string[] };

const USAGE = `usage: check-profile [DIR|FILE]`;

function run(argv: string[]): number {
  const [infoPath, cachesPath, ...rest] = argv;
  if (rest.length > 1) {
    log.profile.error(USAGE);
    return 2;
  }
  const given = resolve(rest[0] ?? '.');
  const what = printable(rest[0] ?? '.');
  const at = findProfile(given, what);
  if (at === null) {
    log.profile.error(`no ${FILE} or ${MANIFEST} at ${given}\n${USAGE}`);
    return 2;
  }
  const info: Info = JSON.parse(readFileSync(infoPath, 'utf8'));
  const caches: Caches = JSON.parse(readFileSync(cachesPath, 'utf8'));
  const options = ['--option', 'substituters', caches.substituters.join(' '),
    '--option', 'trusted-public-keys', caches.trustedPublicKeys.join(' ')];

  const { packages } = profileValue(at, info, cacheRoot(process.env, what), what);
  if (packages.length === 0) {
    process.stdout.write(`${what}: no packages\n`);
    return 0;
  }
  let failed = false;
  for (const { name, drvPath } of packages) {
    const plan = wouldCompile('nix', `${drvPath}^*`, options, nixEnvironment());
    if ('unknown' in plan) {
      process.stdout.write(`${what}: cannot tell whether package ${name} is in the binary cache (${plan.unknown})\n`);
      failed = true;
    } else if (plan.names) {
      process.stdout.write(`${what}: package ${name} is not in the binary cache (would build ${plan.names})\n`);
      failed = true;
    } else {
      process.stdout.write(`${name}: cached\n`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof LaunchError) && !isSystemError(error)) throw error;
    log.profile.error((error as Error).message);
    process.exitCode = 1;
  }
}
