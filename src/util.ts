/** Filesystem and quoting helpers every runtime module shares. */
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/** Like Python's os.path.realpath: resolves what exists, keeps the rest. */
export function realpath(path: string, depth = 0): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    if (absolute === '/' || depth > 40) return absolute;
    const parent = realpath(dirname(absolute), depth + 1);
    const joined = resolve(parent, basename(absolute));
    // A dangling link still names where it points.
    const link = lstatSync(joined, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) {
      try {
        return realpath(resolve(parent, readlinkSync(joined)), depth + 1);
      } catch {
        return joined;
      }
    }
    return joined;
  }
}

export function lexists(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

function stat(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

export const isFile = (path: string) => stat(path)?.isFile() ?? false;
export const isDirectory = (path: string) => stat(path)?.isDirectory() ?? false;

/** An operating-system error (Python's OSError), as opposed to a bad value. */
export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string';
}

/** JSON as Python's json.dumps writes it in messages: ASCII-only. */
export function pyJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** A string as Python's repr() writes it. */
export function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return quote + (quote === "'" ? escaped.replace(/'/g, "\\'") : escaped) + quote;
}

/** A list of strings as Python's repr() writes it. */
export const pyList = (values: string[]) => '[' + values.map(pyRepr).join(', ') + ']';

/** One shell word, as Python's shlex.quote writes it. */
export function shellQuote(value: string): string {
  if (!value) return "''";
  if (!/[^\w@%+=:,./-]/.test(value)) return value;
  return "'" + value.replace(/'/g, `'"'"'`) + "'";
}

/** A fresh name in `directory` for a file that is renamed into place. */
export const temporaryPath = (directory: string, prefix: string) =>
  join(directory, prefix + randomBytes(6).toString('hex'));
