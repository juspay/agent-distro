/**
 * The picker's side of the profile in effect (resolve.ts).
 *
 * Usage: node cli.ts resolve INFO_JSON [PROFILE]
 *        node cli.ts list INFO_JSON MENU_JSON [--json]
 *
 * INFO_JSON is the launcher's build-time `Info` (lib/picker.nix). `resolve`
 * prints the resolved profile as JSON, for the picker to hand its launcher in
 * AGENT_DISTRO_PROFILE, and prints nothing when there is no profile in effect
 * at all; PROFILE is the picker's positional selector. `list` prints `--list`
 * from the menu (src/listing.ts): with `--json`, the menu with the profile in
 * effect added; without, a line naming that profile, those it is composed
 * over, and where they came from, then one `harness title version` line per
 * harness.
 */
import { readFileSync } from 'node:fs';
import { nameText, sourceText, type InEffect, type Listing } from '../listing.ts';
import { log } from '../log.ts';
import { LaunchError, printable } from '../plugin/launch.ts';
import { isSystemError } from '../util.ts';
import { resolveProfile, select, workingDirectory, type Info, type Resolved } from './resolve.ts';

/** The profile in effect here, or null when nothing chose one. */
function inEffect(info: Info, positional: string | undefined): Resolved | null {
  return resolveProfile(info, select(positional, workingDirectory(), process.env), process.env);
}

/**
 * A resolved profile as the listing carries it: `InEffect`'s fields, without
 * the plugins, env, settings and paths only a launch needs.
 */
function listingProfile({ name, description, source, origin, over }: Resolved): InEffect {
  return { name, description, source, origin, ...(over && { over }) };
}

function run(argv: string[]): number {
  const [command, infoPath, ...rest] = argv;
  const info: Info = JSON.parse(readFileSync(infoPath, 'utf8'));
  if (command === 'resolve') {
    const profile = inEffect(info, rest[0] || undefined);
    // No output is no profile: the launcher resolves the same way, and adds
    // nothing to the harness.
    if (profile) process.stdout.write(JSON.stringify(profile) + '\n');
    return 0;
  }
  if (command !== 'list') throw new Error(`unknown command: ${command}`);
  const [menu, format] = rest;
  const listing: Listing = JSON.parse(menu);
  const profile = inEffect(info, undefined);
  if (format === '--json') {
    process.stdout.write(JSON.stringify({
      ...listing,
      ...(profile ? { profile: listingProfile(profile) } : {}),
    }) + '\n');
    return 0;
  }
  const lines = [
    ...(profile ? [`${nameText(profile)} · ${profile.description} · ${sourceText(profile)}`] : []),
    ...listing.harnesses.map((h) => `${h.name} ${h.title} ${h.version}`),
  ];
  process.stdout.write(printable(lines.join('\n')) + '\n');
  return 0;
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
