/**
 * `agent-distro --launch HARNESS`: how a launch of HARNESS takes a model, as
 * one line of JSON (`Launch`, src/models.ts).
 *
 * Usage: node model-launch-cli.ts HARNESS
 *
 * It reads the harness's adapter and nothing else: no launcher, no profile, no
 * harness process. So it answers wherever the package is installed, whether
 * or not the harness could list its models from here (`--models`), which is
 * what lets a consumer start a harness on a model it already has without
 * depending on a list that may be failing today.
 */
import { parseLaunchAnswer, type ModelSource } from './models.ts';

const [harness] = process.argv.slice(2);
// The harness is the argument, as src/models-cli.ts loads its adapter.
const { models } = await import(`./harness/${harness}.ts`) as { models: ModelSource };
// Checked against its own type before it is printed, as `--models` is.
process.stdout.write(JSON.stringify(parseLaunchAnswer({ model: models.launch })) + '\n');
