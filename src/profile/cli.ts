/**
 * The picker's side of the profile in effect (resolve.ts).
 *
 * Usage: node cli.ts resolve INFO_JSON [PROFILE]
 *        node cli.ts list INFO_JSON MENU_JSON [--json]
 *
 * INFO_JSON is the launcher's build-time `Info` (lib/picker.nix). `resolve`
 * prints the resolved profile as JSON, for the picker to hand its launcher in
 * AGENT_DISTRO_PROFILE; PROFILE is the picker's positional selector. `list`
 * prints `--list` from the menu (src/listing.ts): with `--json`, the menu with
 * the profile in effect added; without, a line naming that profile and where
 * it came from, then one `harness title version` line per harness.
 */
import { readFileSync } from 'node:fs';
import { sourceText, type Listing } from '../listing.ts';
import { LaunchError, printable } from '../plugin/launch.ts';
import { isSystemError } from '../util.ts';
import { resolveProfile, select, workingDirectory, type Info, type Resolved } from './resolve.ts';

function inEffect(info: Info, positional: string | undefined): Resolved {
  return resolveProfile(info, select(positional, workingDirectory(), process.env, info), process.env);
}

function run(argv: string[]): number {
  const [command, infoPath, ...rest] = argv;
  const info: Info = JSON.parse(readFileSync(infoPath, 'utf8'));
  if (command === 'resolve') {
    process.stdout.write(JSON.stringify(inEffect(info, rest[0] || undefined)) + '\n');
    return 0;
  }
  if (command !== 'list') throw new Error(`unknown command: ${command}`);
  const [menu, format] = rest;
  const listing: Listing = JSON.parse(menu);
  const { name, description, source, origin } = inEffect(info, undefined);
  if (format === '--json') {
    process.stdout.write(JSON.stringify({ ...listing, profile: { name, description, source, origin } }) + '\n');
    return 0;
  }
  const lines = [`${name} · ${description} · ${sourceText({ source, origin })}`,
    ...listing.profiles[0].harnesses.map((h) => `${h.name} ${h.title} ${h.version}`)];
  process.stdout.write(printable(lines.join('\n')) + '\n');
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof LaunchError) && !isSystemError(error)) throw error;
    process.stderr.write(`agent-distro: ${printable((error as Error).message)}\n`);
    process.exitCode = 1;
  }
}
