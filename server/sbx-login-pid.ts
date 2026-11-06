import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LONCA_HOME } from './config.ts';
import { errorMessage } from './util.ts';

// `sbx login` waits for its code to be used, and outlives a server that's killed outright, with a
// code that could still sign the computer in. So which one it is gets written down, and the next
// server ends it. A pid can be reused by then, so it's only ended if it's still the same process:
// the same command, started at the same moment. The server that started it is noted the same way,
// so that Lonca started a second time, which fails to get its port, leaves the first one's alone.

export const SBX_LOGIN_RECORD = path.join(LONCA_HOME, 'sbx-login.json');

interface LoginRecord {
  pid: number;
  /** What its command line ends with: the sbx it ran, and `login`. */
  command: string;
  /** When it started, as `ps` says it. */
  started: string;
  /** The server that started it, and when that started. */
  owner: number;
  ownerStarted: string;
}

/** `ps` reads the same on macOS and Linux, and says nothing for a process that's gone. */
function ps(pid: number, field: 'lstart' | 'command'): string | null {
  try {
    return execFileSync('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

function isSame(record: LoginRecord): boolean {
  return ps(record.pid, 'lstart') === record.started && Boolean(ps(record.pid, 'command')?.endsWith(record.command));
}

function ownerRunning(record: LoginRecord): boolean {
  return ps(record.owner, 'lstart') === record.ownerStarted;
}

export function recordSbxLogin(pid: number, command: string, file = SBX_LOGIN_RECORD, owner = process.pid): void {
  const started = ps(pid, 'lstart');
  const ownerStarted = ps(owner, 'lstart');
  if (!started || !ownerStarted) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ pid, command, started, owner, ownerStarted } satisfies LoginRecord), { mode: 0o600 });
  } catch (error) {
    console.error('could not note the pid of sbx login:', errorMessage(error));
  }
}

/** Once it's exited. A newer one's record stays. */
export function forgetSbxLogin(pid: number, file = SBX_LOGIN_RECORD): void {
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as LoginRecord).pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // Nothing there, or nothing worth keeping.
  }
}

/** At startup: ends an `sbx login` that the last server left waiting. */
export function reapSbxLogin(file = SBX_LOGIN_RECORD): void {
  let record: LoginRecord;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8')) as LoginRecord;
  } catch {
    return;
  }
  const valid = Number.isInteger(record.pid) && record.pid > 1 && typeof record.command === 'string' && record.command !== ''
    && typeof record.started === 'string' && Number.isInteger(record.owner) && typeof record.ownerStarted === 'string';
  // Still that server's to end, or to forget when it exits.
  if (valid && ownerRunning(record)) return;
  fs.rmSync(file, { force: true });
  if (!valid || !isSame(record)) return;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    return;
  }
  // As when it's cancelled: asked first, then made to.
  setTimeout(() => {
    if (!isSame(record)) return;
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, 5000).unref();
}
