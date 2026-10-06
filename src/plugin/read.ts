/**
 * Read one Agent Plugins 1.0.0 directory into a harness-independent description.
 *
 * Usage: node read.ts PLUGIN_DIR > description.json
 *
 * The description holds what a harness adapter needs and nothing it must
 * re-validate: the filesystem-resolved root, the manifest's known fields, the
 * discovered skills with the files each may use, the valid MCP server entries,
 * and a report for everything skipped or ignored. Reports also go to stderr, so
 * they appear in the build log. A fatal manifest violation exits non-zero with
 * a message naming the field. `description.schema.json` describes the output.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUtf8, isDirectory, isFile, lexists, realpath } from '../util.ts';

export type Author = { name?: string; email?: string; url?: string };

/** The manifest fields Agent Plugins 1.0.0 defines; unknown ones are dropped. */
export type Manifest = {
  $schema: string;
  name: string;
  version?: string;
  description?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  author?: Author;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
};

export type StdioServer = {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Which directory `cwd` must stay inside, checked again at launch. */
  cwdBase?: 'root' | 'data';
};

export type RemoteServer = {
  type: 'streamable-http' | 'sse';
  url: string;
  headers: Record<string, string>;
};

export type McpServer = StdioServer | RemoteServer;

export type Description = {
  root: string;
  version: string;
  manifest: Manifest;
  /** Skill name → its in-root regular files, relative to `skills/<name>`. */
  skills: Record<string, string[]>;
  mcpServers: Record<string, McpServer>;
  reports: string[];
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Report = (message: string) => void;

// Canonical identifier → Agent Plugins version. Adding a compatible release is
// one entry here; nothing else keys off the identifier.
export const PLUGIN_SCHEMAS: Record<string, string> = {
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json': '1.0.0',
};
export const MCP_SCHEMAS: Record<string, string> = {
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json': '1.0.0',
};

const NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const STRING_FIELDS = ['version', 'description', 'homepage', 'repository', 'license'];
const MANIFEST_FIELDS = new Set(['$schema', 'name', 'author', 'keywords', 'extensions', ...STRING_FIELDS]);
const SERVER_FIELDS: Record<string, Set<string>> = {
  stdio: new Set(['type', 'command', 'args', 'env', 'cwd']),
  'streamable-http': new Set(['type', 'url', 'headers']),
  sse: new Set(['type', 'url', 'headers']),
};
const CWD_FORM = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// RFC 9110 field-value: visible ASCII, obs-text, and inner spaces or tabs.
const HEADER_VALUE = /^(?:[!-~\x80-\xff](?:[ \t!-~\x80-\xff]*[!-~\x80-\xff])?)?$/;
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

// Assigning this name to a JavaScript object sets its prototype instead of
// adding the entry, so it would vanish from the description without a word.
const UNREPRESENTABLE = 'the name `__proto__` cannot be represented';

class Fatal extends Error {}
class Invalid extends Error {}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (object: object, key: string) => Object.hasOwn(object, key);

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/');
}

/** Strict UTF-8 JSON, so undecodable bytes are an error rather than U+FFFD. */
function readJson(path: string): Json {
  return JSON.parse(decodeUtf8(readFileSync(path)));
}

function readManifest(root: string, report: Report): Manifest {
  const path = join(root, 'plugin.json');
  if (!lexists(path)) throw new Fatal('plugin.json is missing');
  const resolved = realpath(path);
  if (!within(resolved, root)) throw new Fatal('plugin.json resolves outside the plugin root');
  if (!isFile(resolved)) throw new Fatal('plugin.json is not a regular file');
  let manifest: Json;
  try {
    manifest = readJson(resolved);
  } catch (error) {
    throw new Fatal(`plugin.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(manifest)) throw new Fatal('plugin.json must contain a JSON object');

  if (!has(manifest, '$schema')) throw new Fatal('`$schema` is missing');
  const schema = manifest.$schema;
  if (typeof schema !== 'string' || !has(PLUGIN_SCHEMAS, schema)) {
    throw new Fatal(`\`$schema\` ${JSON.stringify(schema)} is not a supported Agent Plugins version`);
  }
  if (!has(manifest, 'name')) throw new Fatal('`name` is missing');
  const name = manifest.name;
  if (typeof name !== 'string' || name.length < 1 || [...name].length > 64 || !NAME.test(name)) {
    throw new Fatal(`\`name\` ${JSON.stringify(name)} must be 1-64 characters of a-z, 0-9, "-" and ".", `
      + 'start and end alphanumeric, and contain no "--" or ".."');
  }
  for (const field of STRING_FIELDS) {
    if (has(manifest, field) && typeof manifest[field] !== 'string') throw new Fatal(`\`${field}\` must be a string`);
  }
  if (has(manifest, 'author')) {
    const author = manifest.author;
    if (!isObject(author)) throw new Fatal('`author` must be an object');
    for (const [key, value] of Object.entries(author)) {
      if (!['name', 'email', 'url'].includes(key)) throw new Fatal(`\`author.${key}\` is not an allowed field`);
      if (typeof value !== 'string') throw new Fatal(`\`author.${key}\` must be a string`);
    }
  }
  if (has(manifest, 'keywords')) {
    const keywords = manifest.keywords;
    if (!Array.isArray(keywords) || !keywords.every((k) => typeof k === 'string')) {
      throw new Fatal('`keywords` must be an array of strings');
    }
  }

  const result: JsonObject = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (MANIFEST_FIELDS.has(key) && key !== 'extensions') result[key] = value;
  }
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(field)) report(`plugin.json: ignored unknown field \`${field}\``);
  }
  if (has(manifest, 'extensions')) {
    const extensions = manifest.extensions;
    if (!isObject(extensions)) {
      report('plugin.json: ignored `extensions`, which is not an object');
    } else {
      // Values are opaque to clients that do not implement the namespace,
      // but the schema still requires each one to be an object (§5.2).
      for (const [namespace, value] of Object.entries(extensions)) {
        if (!isObject(value)) throw new Fatal(`\`extensions.${namespace}\` must be an object`);
      }
      result.extensions = extensions;
    }
  }
  return result as Manifest;
}

/** The resolved fixed location, or null when absent or unusable (§6.2). */
function component(root: string, location: string, kind: 'directory' | 'regular file', report: Report): string | null {
  const path = join(root, location);
  if (!lexists(path)) return null;
  const resolved = realpath(path);
  if (!within(resolved, root)) {
    report(`${location}: ignored, it resolves outside the plugin root`);
    return null;
  }
  if (!(kind === 'directory' ? isDirectory : isFile)(resolved)) {
    report(`${location}: ignored, it is not a ${kind}`);
    return null;
  }
  return resolved;
}

const sorted = (names: string[]) => names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Every regular file of a skill that stays inside the plugin root (§4.1). */
function skillFiles(root: string, skill: string, report: Report): string[] {
  const files: string[] = [];
  const walk = (relative: string, ancestors: Set<string>) => {
    const directory = join(root, 'skills', skill, relative);
    for (const entry of sorted(readdirSync(directory))) {
      const path = relative ? join(relative, entry) : entry;
      const resolved = realpath(join(directory, entry));
      const label = `skills/${skill}/${path}`;
      if (!within(resolved, root)) {
        report(`${label}: skipped, it resolves outside the plugin root`);
      } else if (isDirectory(resolved)) {
        if (ancestors.has(resolved)) {
          report(`${label}: skipped, it links back to its own ancestor`);
        } else {
          walk(path, new Set([...ancestors, resolved]));
        }
      } else if (isFile(resolved)) {
        files.push(path);
      } else {
        report(`${label}: skipped, it is not a regular file or directory`);
      }
    }
  };
  walk('', new Set([realpath(join(root, 'skills', skill))]));
  return files;
}

function readSkills(root: string, report: Report): Record<string, string[]> {
  const skillsDir = component(root, 'skills', 'directory', report);
  if (skillsDir === null) return {};
  const skills: Record<string, string[]> = {};
  for (const entry of sorted(readdirSync(skillsDir))) {
    const child = realpath(join(root, 'skills', entry));
    if (!within(child, root)) {
      report(`skills/${entry}: skipped, it resolves outside the plugin root`);
      continue;
    }
    // Exactly `SKILL.md`, even on a case-insensitive filesystem (§7.1).
    if (!isDirectory(child) || !readdirSync(child).includes('SKILL.md')) continue;
    if (entry === '__proto__') {
      report(`skills/${entry}: skipped, ${UNREPRESENTABLE}`);
      continue;
    }
    const skillMd = realpath(join(child, 'SKILL.md'));
    if (!within(skillMd, root)) {
      report(`skills/${entry}: skipped, its SKILL.md resolves outside the plugin root`);
    } else if (isFile(skillMd)) {
      skills[entry] = skillFiles(root, entry, report);
    }
  }
  return skills;
}

function checkProcessString(value: Json | undefined, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Invalid(`\`${field}\` must be a string`);
  // A process argument or environment entry cannot carry NUL.
  if (value.includes('\0')) throw new Invalid(`\`${field}\` contains a NUL character`);
}

function readStdio(server: JsonObject, root: string): StdioServer {
  const command = server.command;
  checkProcessString(command, 'command');
  if (!command) throw new Invalid('`command` is empty');
  if (command.startsWith('./')) {
    // Concatenated, not joined: join() would collapse `link/..` before the
    // link is followed.
    if (!within(realpath(root + '/' + command), root)) throw new Invalid('`command` resolves outside the plugin root');
  } else if (command.includes('/')) {
    throw new Invalid('`command` must be a bare executable name or a path beginning with "./"');
  }

  const args = has(server, 'args') ? server.args : [];
  if (!Array.isArray(args)) throw new Invalid('`args` must be an array of strings');
  for (const arg of args) checkProcessString(arg, 'args[]');

  const env = has(server, 'env') ? server.env : {};
  if (!isObject(env)) throw new Invalid('`env` must be an object of strings');
  for (const [key, value] of Object.entries(env)) {
    if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') {
      throw new Invalid(`\`env\` must not set ${key}; the client supplies it`);
    }
    // POSIX environment names cannot be empty or contain "=" or NUL.
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new Invalid(`\`env\` name ${JSON.stringify(key)} cannot be an environment variable`);
    }
    checkProcessString(value, `env.${key}`);
  }

  const result: StdioServer = {
    type: 'stdio', command, args: args as string[], env: env as Record<string, string>,
  };
  if (has(server, 'cwd')) {
    const cwd = server.cwd;
    checkProcessString(cwd, 'cwd');
    if (!CWD_FORM.test(cwd)) throw new Invalid('`cwd` must begin with "./", "${PLUGIN_ROOT}" or "${PLUGIN_DATA}"');
    const base = cwd.startsWith('${PLUGIN_DATA}') ? 'data' : 'root';
    // PLUGIN_DATA is known only at launch, where the launcher checks
    // containment again; a root-based cwd is checked here too (§7.2.1).
    if (base === 'root' && !cwd.includes('${PLUGIN_DATA}')) {
      const expanded = cwd.replaceAll('${PLUGIN_ROOT}', root);
      const target = cwd.startsWith('./') ? root + '/' + expanded : expanded;
      if (!within(realpath(target), root)) throw new Invalid('`cwd` resolves outside the plugin root');
    }
    result.cwd = cwd;
    result.cwdBase = base;
  }
  return result;
}

function isLoopback(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIPv4(host)) return LOOPBACK.check(host, 'ipv4');
  if (isIPv6(host)) return LOOPBACK.check(host, 'ipv6');
  return false;
}

function readRemote(server: JsonObject, kind: RemoteServer['type']): RemoteServer {
  const url = server.url;
  if (typeof url !== 'string' || !url) throw new Invalid('`url` must be a non-empty string');
  if ([...url].some((c) => /\s/u.test(c) || c < ' ' || c === '\x7f')) {
    throw new Invalid('`url` contains whitespace or control characters');
  }
  // The platform's URL parser decides validity; what the spec forbids is
  // checked on the text as written, which the parser would normalize away.
  const parsed = URL.parse(url);
  if (!parsed) throw new Invalid('`url` is not a valid URL');
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url)?.[1];
  if (!['http:', 'https:'].includes(parsed.protocol) || !authority || !parsed.hostname) {
    throw new Invalid('`url` must be an absolute http or https URL');
  }
  if (authority.includes('@')) throw new Invalid('`url` must not contain user information');
  if (url.includes('#')) throw new Invalid('`url` must not contain a fragment');
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname.replace(/^\[(.*)\]$/, '$1'))) {
    throw new Invalid('`url` must use https unless its host is localhost or a loopback address');
  }

  const headers = has(server, 'headers') ? server.headers : {};
  if (!isObject(headers)) throw new Invalid('`headers` must be an object of strings');
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new Invalid(`header name ${JSON.stringify(name)} is not a valid HTTP field name`);
    if (seen.has(name.toLowerCase())) throw new Invalid(`header ${JSON.stringify(name)} is repeated under different casing`);
    seen.add(name.toLowerCase());
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) {
      throw new Invalid(`header ${JSON.stringify(name)} does not have a valid HTTP field value`);
    }
  }
  return { type: kind, url, headers: headers as Record<string, string> };
}

function readMcp(root: string, version: string, report: Report): Record<string, McpServer> {
  const path = component(root, 'mcp.json', 'regular file', report);
  if (path === null) return {};
  let config: Json;
  try {
    config = readJson(path);
  } catch (error) {
    report(`mcp.json: MCP disabled, it is not valid JSON: ${(error as Error).message}`);
    return {};
  }
  let problem: string | null = null;
  const schema = isObject(config) ? config.$schema : undefined;
  const unknown = isObject(config) ? sorted(Object.keys(config).filter((k) => k !== '$schema' && k !== 'mcpServers')) : [];
  if (!isObject(config)) {
    problem = 'it is not a JSON object';
  } else if (typeof schema !== 'string' || !has(MCP_SCHEMAS, schema)) {
    problem = `\`$schema\` ${JSON.stringify(schema ?? null)} is not a supported Agent Plugins version`;
  } else if (MCP_SCHEMAS[schema] !== version) {
    problem = `it targets Agent Plugins ${MCP_SCHEMAS[schema]}, but plugin.json targets ${version}`;
  } else if (!isObject(config.mcpServers)) {
    problem = '`mcpServers` must be an object';
  } else if (unknown.length) {
    problem = `unknown top-level fields ${JSON.stringify(unknown)}`;
  }
  if (problem) {
    report(`mcp.json: MCP disabled, ${problem}`);
    return {};
  }

  const servers: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries((config as JsonObject).mcpServers as JsonObject)) {
    try {
      if (name === '__proto__') throw new Invalid(UNREPRESENTABLE);
      if (!isObject(server)) throw new Invalid('it is not an object');
      const kind = server.type;
      if (typeof kind !== 'string' || !has(SERVER_FIELDS, kind)) {
        throw new Invalid(`unknown \`type\` ${JSON.stringify(kind ?? null)}`);
      }
      const extra = sorted(Object.keys(server).filter((key) => !SERVER_FIELDS[kind].has(key)));
      if (extra.length) throw new Invalid(`unknown fields for type ${kind}: ${JSON.stringify(extra)}`);
      servers[name] = kind === 'stdio' ? readStdio(server, root) : readRemote(server, kind as RemoteServer['type']);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      report(`mcp.json: server ${JSON.stringify(name)} skipped, ${error.message}`);
    }
  }
  return servers;
}

/**
 * The description of `plugin`; throws Fatal for an invalid manifest. Each
 * report is also passed to `report` as it happens.
 */
export function readPlugin(plugin: string, report: Report = () => {}): Description {
  const reports: string[] = [];
  const note = (message: string) => {
    reports.push(message);
    report(message);
  };
  const root = realpath(plugin);
  if (!isDirectory(root)) throw new Fatal('the plugin is not a directory');
  const manifest = readManifest(root, note);
  const version = PLUGIN_SCHEMAS[manifest.$schema];
  return {
    root, version, manifest, skills: readSkills(root, note), mcpServers: readMcp(root, version, note), reports,
  };
}

if (import.meta.main) {
  const plugin = process.argv[2];
  try {
    const description = readPlugin(plugin, (message) => process.stderr.write(`${plugin}: ${message}\n`));
    process.stdout.write(JSON.stringify(description, null, 2) + '\n');
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    process.stderr.write(`${plugin}: invalid Agent Plugin: ${error.message}\n`);
    process.exitCode = 1;
  }
}
