/**
 * `agent-distro --models HARNESS`: the models HARNESS offers from here, and
 * how a launch takes one, as one line of JSON (src/models.ts).
 *
 * Usage: node models-cli.ts HARNESS LAUNCHER
 *
 * LAUNCHER is the harness's own launcher (lib/picker.nix passes it), so the
 * list command runs with the profile in effect here, its providers, env and
 * settings, exactly as a launch from this directory would. Its stdin is not a
 * terminal, so a secret the profile still needs fails the listing rather than
 * waiting for someone to type it.
 *
 * A harness with no list command answers `unlisted` without running anything.
 * A list command that fails, or prints what its reader does not recognize,
 * fails this command: exit 1, nothing on stdout, and on stderr the command
 * that failed followed by everything it printed there — never an empty list.
 */
import { spawnSync } from 'node:child_process';
import { log } from './log.ts';
import { parseModels, type ModelSource, type Models } from './models.ts';

/** The answer for `harness`, or a thrown Error whose message is the failure's words. */
export function listModels(harness: string, launcher: string, source: ModelSource): Models {
  const { launch, list } = source;
  if (!list) return { harness, launch, models: { kind: 'unlisted' } };
  const command = [harness, ...list.args].join(' ');
  const result = spawnSync(launcher, list.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  const said = result.stderr.trimEnd();
  if (result.status !== 0) {
    const how = result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`;
    throw new Error(`${command} ${how}${said ? `:\n${said}` : ''}`);
  }
  let ids: string[];
  try {
    ids = list.read(result.stdout);
  } catch (error) {
    throw new Error(`${command} printed what agent-distro cannot read: ${(error as Error).message}`);
  }
  // The answer is checked against its own type before it is printed, so what
  // a consumer parses is never something this command would refuse.
  return parseModels({ harness, launch, models: { kind: 'listed', ids } });
}

if (import.meta.main) {
  const [harness, launcher] = process.argv.slice(2);
  // The harness is the argument, as src/plugin/launch.ts loads its adapter.
  const { models } = await import(`./harness/${harness}.ts`) as { models: ModelSource };
  try {
    process.stdout.write(JSON.stringify(listModels(harness, launcher, models)) + '\n');
  } catch (error) {
    log.harness(harness).error(`cannot list its models: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
