/** Filesystem, process and quoting helpers every runtime module shares. */
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * Resolve `path` one component at a time on disk, following each symlink
 * before the components after it, so `link/..` is the parent of the link's
 * target, not of the link. Components that do not exist are kept as written.
 * Plugin-root containment depends on this: Node's path.resolve and
 * fs.realpathSync collapse `..` textually first, which the shell running a
 * launcher does not.
 */
export function realpath(path: string): string {
  // A stack of components still to resolve, the next one last.
  const pending = (path.startsWith('/') ? path : process.cwd() + '/' + path).split('/').reverse();
  let resolved = '';
  let links = 0;
  while (pending.length) {
    const part = pending.pop()!;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved = resolved.slice(0, resolved.lastIndexOf('/'));
      continue;
    }
    const next = resolved + '/' + part;
    let target: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch {
      target = undefined;
    }
    // A link loop resolves no further, like any path that does not exist.
    if (target === undefined || ++links > 40) {
      resolved = next;
      continue;
    }
    if (target.startsWith('/')) resolved = '';
    pending.push(...target.split('/').reverse());
  }
  return resolved || '/';
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

/** An operating-system error, as opposed to a bad value. */
export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string';
}

/** UTF-8 text, refusing bytes that are not UTF-8 rather than replacing them. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Control characters escaped, so cached or plugin-chosen text cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu,
    (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/**
 * Write `data` to a new file in `directory`, for a rename into place. The file
 * is removed if writing it fails, so a full disk leaves nothing behind.
 */
export function writeTemporary(directory: string, prefix: string, data: string): string {
  const path = join(directory, prefix + randomBytes(6).toString('hex'));
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  return path;
}

/**
 * What tells process `pid` apart from a later one given the same pid — its
 * start time — or null when no such process runs.
 */
export function processIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  try {
    // Linux: the 22nd field of /proc/<pid>/stat, counted after the command's `)`.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    const ps = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return ps.status === 0 ? ps.stdout.trim() : null;
  }
}

