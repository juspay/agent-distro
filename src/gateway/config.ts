/**
 * The profile's gateway as a harness config, written at launch.
 *
 * Usage: node config.ts opencode-v1|opencode-v2 GATEWAY_JSON CACHE BASE
 *        node config.ts pi GATEWAY_JSON CACHE
 *
 * GATEWAY_JSON is the gateway in effect, as src/plugin/launch.ts prints it.
 * For OpenCode the result is BASE, the session config, with the gateway as its
 * provider; for Pi it is what merge-state adds. Either is written under
 * CACHE/gateway by its contents and its path printed: the BASE models.ts
 * extends, whose model list the launcher caches in CACHE/<name of that file>.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayConfig } from '../harness/pi.ts';
import { withGateway } from '../harness/opencode.ts';
import { writeAddressed } from '../plugin/launch.ts';
import type { Gateway } from './models.ts';

const [kind, gatewayJson, cache, base] = process.argv.slice(2);
const gateway: Gateway = JSON.parse(gatewayJson);
const config = kind === 'pi' ? gatewayConfig(gateway)
  : kind === 'opencode-v1' || kind === 'opencode-v2'
    ? withGateway(JSON.parse(readFileSync(base, 'utf8')), kind.slice('opencode-'.length), gateway)
    : undefined;
if (config === undefined) throw new Error(`unknown config: ${kind}`);
process.stdout.write(writeAddressed(join(cache, 'gateway'), config) + '\n');
