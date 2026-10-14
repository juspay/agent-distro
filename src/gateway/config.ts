/**
 * The profile's gateway as a harness config, written at launch.
 *
 * Usage: node config.ts opencode GATEWAY_JSON CACHE BASE PLUGIN
 *        node config.ts pi GATEWAY_JSON CACHE
 *
 * GATEWAY_JSON is the gateway in effect, as src/plugin/launch.ts prints it.
 * For OpenCode the result is BASE, the session config, with the gateway as its
 * provider and PLUGIN, the vendored opencode-plugin-litellm directory, as the
 * plugin that discovers the models it serves. For Pi it is what merge-state
 * adds; models.ts then extends it with the served models, whose list the
 * launcher caches in CACHE/<name of that file>. Either is written under
 * CACHE/gateway by its contents and its path printed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayConfig } from '../harness/pi.ts';
import { withGateway } from '../harness/opencode.ts';
import { writeAddressed } from '../plugin/launch.ts';
import type { Gateway } from './models.ts';

const [kind, gatewayJson, cache, base, plugin = ''] = process.argv.slice(2);
const gateway: Gateway = JSON.parse(gatewayJson);
if (kind === 'opencode' && plugin === '') throw new Error('opencode needs the plugin directory');
const config = kind === 'pi' ? gatewayConfig(gateway)
  : kind === 'opencode' ? withGateway(JSON.parse(readFileSync(base, 'utf8')), gateway, plugin)
  : undefined;
if (config === undefined) throw new Error(`unknown config: ${kind}`);
process.stdout.write(writeAddressed(join(cache, 'gateway'), config) + '\n');
