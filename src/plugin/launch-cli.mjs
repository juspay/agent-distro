/**
 * The command a launcher runs when AGENT_DISTRO_PLUGINS is set; see launch.ts.
 *
 * Usage: node launch-cli.mjs ARGS_JSON [BASE]
 *
 * The one runtime module that is JavaScript rather than TypeScript, because it
 * runs before anything is cached: it turns on Node's compile cache under
 * agent-distro's cache directory and only then imports the TypeScript, so a
 * launch whose plugins are all translated already costs about a Node start-up
 * rather than type-stripping every module again. A cache directory launch.ts
 * would refuse is left alone here, for it to report.
 */
import { enableCompileCache } from 'node:module';
import { isAbsolute, join } from 'node:path';

const env = process.env;
const base = env.XDG_CACHE_HOME || (env.HOME ? join(env.HOME, '.cache') : '');
if ((env.AGENT_DISTRO_PLUGINS ?? '').replaceAll(':', '') && isAbsolute(base)) {
  enableCompileCache(join(base, 'agent-distro', 'node-compile-cache'));
}
const { main } = await import('./launch.ts');
process.exitCode = await main(process.argv[2], process.argv.slice(3));
