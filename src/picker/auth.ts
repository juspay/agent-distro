/**
 * Presence probes for the picker's auth column: whether a harness can start
 * without a login step. Presence only — no network, no token validation, no
 * expiry checks. Each probe reads only what the harness itself reads, honouring
 * its relocation variables; a source that cannot be read or parsed is
 * "unknown" (undefined), and a probe never throws.
 *
 * Each harness's scheme comes from its meta.nix through lib/picker.nix: the
 * ones with a login of their own (Claude Code, Codex) name it, and the rest
 * are `secrets` — the `secret` variables of the profile's `env`, then the
 * harness's own store, which `spec` fills in from the profile in effect.
 * `AGENT_DISTRO_SETTINGS` is read here, at launch, so a harness whose
 * profile's environment is off falls back to its own provider.
 *
 * Checked against the pinned sources: Claude Code 2.1.292, Codex 0.160.1,
 * oh-my-pi 18.7.0, Pi 1.0.4 and OpenCode 2.0.29.
 */

import { log } from '../log.ts';
import type { ProfileEnv } from '../profile/resolve.ts';

export type Env = NodeJS.ProcessEnv;

/** A harness's auth scheme, as its meta.nix declares it. */
export type Scheme = 'anthropic' | 'openai' | 'secrets';

/** One harness's probe spec, for the profile in effect. */
export type Spec = {
  scheme: Scheme;
  /** secrets: the profile's `secret` variables, in the order the profile declares them. */
  secrets?: string[];
  /** secrets: the harness whose own store to read, beside them or alone. */
  provider?: string;
};

/**
 * A row's auth status: `text` is the one-line form the fallback list prints,
 * and `items` are the panel's lines — the profile's secrets first, then the
 * provider ids. An empty list is "not signed in"; unknown is no status at all.
 */
export type Status = { text: string; items: string[] };

/**
 * The I/O a probe reads through, injected so the unit check runs on fixtures
 * and the picker supplies the real files. Each reader returns `undefined` when
 * its source is missing, and throws when it exists but cannot be read. The
 * SQLite seam is generic — each harness's schema stays with its own probe.
 */
export type Io = {
  /** A file's text. */
  read: (path: string) => string | undefined;
  /** The rows of `sql` in the SQLite database at `path`. */
  sqlite: (path: string, sql: string) => unknown[] | undefined;
};

export const NOT_SIGNED_IN = 'not signed in';

/**
 * The probe for `harness`: one with a login of its own is that scheme alone,
 * otherwise the profile's `secret` variables and the harness's own store.
 */
export function spec(scheme: Scheme, harness: string, env: ProfileEnv): Spec {
  if (scheme !== 'secrets') return { scheme };
  const secrets = Object.entries(env).filter(([, value]) => typeof value !== 'string').map(([name]) => name);
  return { scheme: 'secrets', secrets, provider: harness };
}

/** A source's content, or why there is none: missing is "not signed in", unreadable is unknown. */
type Source<T> = { value: T } | { missing: true } | { unreadable: true };

const SIGNED_OUT: Status = { text: NOT_SIGNED_IN, items: [] };
const signedIn = (items: string[]): Status => ({ text: items.join(', '), items });
const home = (env: Env) => env.HOME ?? '';

/** Nothing usable was found: an unreadable source is unknown, anything else is "not signed in". */
const absent = (source: Source<unknown>): Status | undefined => ('unreadable' in source ? undefined : SIGNED_OUT);

/**
 * Status text comes from the user's own files, so control and format
 * characters must not reach the frame; runs of whitespace collapse too.
 */
const sanitize = (text: string) => text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function json(path: string, io: Io): Source<unknown> {
  let text: string | undefined;
  try {
    text = io.read(path);
  } catch (error) {
    log.picker.debug(`auth probe: cannot read ${path}: ${(error as Error).message}`);
    return { unreadable: true };
  }
  if (text === undefined) return { missing: true };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    log.picker.debug(`auth probe: ${path} is not JSON: ${(error as Error).message}`);
    return { unreadable: true };
  }
}

/**
 * A JSON object of provider id to credential (Pi and OpenCode `auth.json`); an
 * entry counts only when it is an object, so an empty file has none.
 */
function jsonIds(path: string, io: Io): Source<string[]> {
  const source = json(path, io);
  if (!('value' in source)) return source;
  const entries = record(source.value);
  return { value: entries ? Object.keys(entries).filter((id) => record(entries[id])) : [] };
}

/**
 * OMP stores every provider credential in the `auth_credentials` table of
 * `<agent-dir>/agent.db` (`provider` is the credential-pool key); there is no
 * JSON mirror. `PI_CODING_AGENT_DIR` names the agent dir; otherwise XDG
 * flattens the `agent/` prefix to `$XDG_DATA_HOME/omp/agent.db` once that
 * directory exists (packages/utils/src/dirs.ts:366-384 and :410, reached by
 * getAgentDbPath at :911-912), else `~/.omp/agent/agent.db`. The OMP launcher
 * (harnesses/omp/default.nix:40) knows only `PI_CODING_AGENT_DIR`/`HOME`.
 *
 * The schema — the table, the column, the disabled filter — lives here with
 * the rest of OMP's policy, not in the generic SQLite reader: it is what OMP's
 * daily updates change.
 */
function ompStore(env: Env, io: Io): Source<string[]> {
  const paths = env.PI_CODING_AGENT_DIR
    ? [`${env.PI_CODING_AGENT_DIR}/agent.db`]
    : [
      ...(env.XDG_DATA_HOME ? [`${env.XDG_DATA_HOME}/omp/agent.db`] : []),
      `${home(env)}/.omp/agent/agent.db`,
    ];
  let unreadable = false;
  for (const path of paths) {
    try {
      // Only credentials OMP has not disabled count, as its own active-credential
      // reads filter `disabled_cause IS NULL` (sqlite-credential-store.ts:418).
      const rows = io.sqlite(path, 'SELECT provider FROM auth_credentials WHERE disabled_cause IS NULL');
      if (rows !== undefined) return { value: providerNames(rows) };
    } catch (error) {
      // A store OMP has not written a credential to yet is "not signed in".
      if (error instanceof Error && error.message.includes('no such table')) return { value: [] };
      log.picker.debug(`auth probe: cannot read ${path}: ${(error as Error).message}`);
      unreadable = true;
    }
  }
  return unreadable ? { unreadable: true } : { missing: true };
}

/** The `provider` column of the rows OMP's query returns. */
function providerNames(rows: unknown[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const provider = record(row)?.provider;
    if (typeof provider === 'string') names.push(provider);
  }
  return names;
}

/** Where each harness without a login of its own keeps its credentials. */
const STORES: Record<string, (env: Env, io: Io) => Source<string[]>> = {
  omp: ompStore,
  pi: (env, io) => jsonIds(`${env.PI_CODING_AGENT_DIR ?? `${home(env)}/.pi/agent`}/auth.json`, io),
  opencode: (env, io) => jsonIds(`${env.XDG_DATA_HOME ?? `${home(env)}/.local/share`}/opencode/auth.json`, io),
};

/**
 * The common provider API-key variables the harnesses document (Pi's
 * providers.md, OMP's catalog), each under the id the harness reports. The
 * auth file is the full source of truth; this covers a key kept only in the
 * environment.
 */
const ENV_PROVIDERS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  GEMINI_API_KEY: 'google',
  XAI_API_KEY: 'xai',
  OPENROUTER_API_KEY: 'openrouter',
  DEEPSEEK_API_KEY: 'deepseek',
  GROQ_API_KEY: 'groq',
  MISTRAL_API_KEY: 'mistral',
  CEREBRAS_API_KEY: 'cerebras',
  TOGETHER_API_KEY: 'together',
  FIREWORKS_API_KEY: 'fireworks',
  HF_TOKEN: 'huggingface',
};

/**
 * Claude Code: `oauthAccount.emailAddress` in `$CLAUDE_CONFIG_DIR/.claude.json`
 * (default `~/.claude.json`; on macOS the tokens live in the keychain, so this
 * file is the cross-platform signal), or `ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN` in the environment. That file grows with use — a
 * machine that has run Claude Code for a while has hundreds of KB — so parsing
 * it on every start is the cost of the cross-platform signal.
 */
function anthropic(env: Env, io: Io): Status | undefined {
  const path = env.CLAUDE_CONFIG_DIR ? `${env.CLAUDE_CONFIG_DIR}/.claude.json` : `${home(env)}/.claude.json`;
  const file = json(path, io);
  const account = 'value' in file ? record(record(file.value)?.oauthAccount) : undefined;
  const email = account?.emailAddress;
  if (typeof email === 'string' && email) return signedIn([email]);
  const variable = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].find((name) => env[name]);
  if (variable) return signedIn([variable]);
  return absent(file);
}

/**
 * Codex: `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) with a `tokens`
 * object, or a non-null `OPENAI_API_KEY` in it, or `OPENAI_API_KEY` in the
 * environment. `tokens.id_token` is an OpenID JWT whose payload carries the
 * account `email` (codex-rs/login/src/token_data.rs:29, decoded at :129-140);
 * it is decoded without checking the signature — this is presence, not
 * authentication. `tokens` is null after `codex login --with-api-key`.
 */
function openai(env: Env, io: Io): Status | undefined {
  const file = json(`${env.CODEX_HOME ?? `${home(env)}/.codex`}/auth.json`, io);
  if ('value' in file) {
    const auth = record(file.value);
    const tokens = record(auth?.tokens);
    if (tokens) return signedIn([idTokenEmail(tokens.id_token) ?? 'ChatGPT']);
    if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) return signedIn(['OPENAI_API_KEY']);
  }
  const variable = env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : undefined;
  if (variable) return signedIn([variable]);
  return absent(file);
}

/** The `email` claim of an OpenID `id_token`, or undefined when it is absent or the token does not decode. */
function idTokenEmail(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return undefined;
  try {
    const claims = record(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    const email = claims?.email;
    return typeof email === 'string' && email ? email : undefined;
  } catch (error) {
    log.picker.debug(`auth probe: the id_token does not decode: ${(error as Error).message}`);
    return undefined;
  }
}

/** The provider ids a harness has credentials for, and the store they came from. */
function providerIds(harness: string, env: Env, io: Io): { ids: string[]; source: Source<string[]> } {
  const source = STORES[harness]?.(env, io) ?? { missing: true };
  const ids = 'value' in source ? [...source.value] : [];
  for (const [variable, id] of Object.entries(ENV_PROVIDERS)) if (env[variable] && !ids.includes(id)) ids.push(id);
  return { ids: [...new Set(ids)].sort(), source };
}

/** Every provider a harness has credentials for, in its own ids. */
function provider(harness: string, env: Env, io: Io): Status | undefined {
  const { ids, source } = providerIds(harness, env, io);
  if (ids.length) return signedIn(ids);
  return absent(source);
}

/**
 * A harness without a login of its own: the profile's `secret` variables are
 * the login the launch will ask for, and the harness's own providers work
 * beside them. One the profile declares but the environment does not set is a
 * login step still to come, so the row is not signed in. With
 * `AGENT_DISTRO_SETTINGS=0` the launch exports nothing, leaving its own
 * providers alone.
 */
function secrets(spec: Spec, env: Env, io: Io): Status | undefined {
  if (!spec.provider) return undefined;
  if (env.AGENT_DISTRO_SETTINGS === '0') return provider(spec.provider, env, io);
  const { ids, source } = providerIds(spec.provider, env, io);
  const names = spec.secrets ?? [];
  if (names.some((name) => !env[name])) return absent(source);
  return names.length || ids.length ? signedIn([...names, ...ids]) : absent(source);
}

/** `spec`'s status, or undefined for unknown; never throws. */
export function probe(spec: Spec, env: Env, io: Io): Status | undefined {
  let status: Status | undefined;
  try {
    switch (spec.scheme) {
      case 'anthropic':
        status = anthropic(env, io);
        break;
      case 'openai':
        status = openai(env, io);
        break;
      case 'secrets':
        status = secrets(spec, env, io);
        break;
    }
  } catch (error) {
    log.picker.debug(`auth probe ${spec.scheme} failed: ${(error as Error).message}`);
    return undefined;
  }
  // Once, for every scheme: the items are drawn on the terminal as they are.
  if (!status) return undefined;
  const items = status.items.map(sanitize).filter(Boolean);
  return items.length ? signedIn(items) : SIGNED_OUT;
}
