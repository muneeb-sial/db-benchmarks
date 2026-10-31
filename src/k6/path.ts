/**
 * Finds the k6 binary. PATH first, but a process only reads PATH when it
 * starts: a terminal (or editor) opened before k6 was installed won't see it.
 * So also check K6_PATH and the standard install locations.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const K6_MISSING =
  'k6 not found (not on PATH, K6_PATH unset, not in the standard install locations). ' +
  'Install it: https://grafana.com/docs/k6/latest/set-up/install-k6/ -- or set K6_PATH to the k6 binary.';

function candidates(): string[] {
  const env = process.env;
  if (process.platform === 'win32') {
    return [
      env.ProgramFiles && join(env.ProgramFiles, 'k6', 'k6.exe'),
      env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'k6', 'k6.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'k6.exe'),
      env.USERPROFILE && join(env.USERPROFILE, 'scoop', 'shims', 'k6.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\k6.exe',
    ].filter((p): p is string => Boolean(p));
  }
  return ['/usr/local/bin/k6', '/opt/homebrew/bin/k6', '/usr/bin/k6', '/snap/bin/k6'];
}

/** The k6 binary, or null if it can't be found. Looked up on every call, so installing k6 needs no server restart. */
export function findK6(): string | null {
  const explicit = process.env.K6_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  return Bun.which('k6') ?? candidates().find((p) => existsSync(p)) ?? null;
}
