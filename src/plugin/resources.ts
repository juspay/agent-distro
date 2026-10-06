/** Materialize reader-approved resources shared by the adapters. */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Description, StdioServer } from './read.ts';
import { launcher } from './launcher.ts';

export function readDescription(path: string): Description {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Copy each approved skill file, links followed; the directory, or null if none. */
export function copySkills(description: Description, skills: string): string | null {
  for (const [name, files] of Object.entries(description.skills)) {
    for (const file of files) {
      const target = join(skills, name, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(description.root, 'skills', name, file), target);
    }
  }
  return Object.keys(description.skills).length ? skills : null;
}

/** A server name as a file name. */
export const fileName = (name: string) => name.replace(/[^A-Za-z0-9._-]/gu, '_');

/** `env` reads its first argument without "=" as the command. */
export const launchable = (description: Description, server: StdioServer) =>
  !server.command.includes('=') && !description.root.includes('=');

export function writeLauncher(
  description: Description, name: string, server: StdioServer, root: string, index: number, bash: string, env: string,
): string {
  const script = join(root, 'bin', `${description.manifest.name}-${index}-${fileName(name)}`);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, launcher(description, name, server, bash, env));
  chmodSync(script, 0o700);
  return script;
}
