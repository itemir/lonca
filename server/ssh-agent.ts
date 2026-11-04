import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LONCA_HOME } from './config.ts';

// Docker Sandboxes 0.50 gives a sandbox the SSH agent of whoever last ran a command in it, and the
// sandbox keeps it, even across restarts. So someone running `sbx exec` from a terminal would
// leave their keys there for agents to sign with. Every command Lonca runs in a sandbox brings
// this agent instead, which has no keys, and that takes the sandbox's agent back. 0.51 doesn't
// lend keys this way, but forwarding is still on by default and sbx versions aren't pinned.

const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const FAILURE = 5;
const MAX_MESSAGE_BYTES = 256 * 1024;
// The longest path a Unix socket can have is just over 100 bytes on macOS.
const MAX_SOCKET_PATH = 100;

/** The reply to one request: an empty list of keys, and a refusal for anything else. */
export function emptyAgentReply(type: number): Buffer {
  return type === REQUEST_IDENTITIES
    ? Buffer.from([0, 0, 0, 5, IDENTITIES_ANSWER, 0, 0, 0, 0])
    : Buffer.from([0, 0, 0, 1, FAILURE]);
}

function serve(socket: net.Socket): void {
  let pending = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length === 0 || length > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      if (pending.length < 4 + length) break;
      socket.write(emptyAgentReply(pending[4]));
      pending = pending.subarray(4 + length);
    }
  });
}

function socketPath(): { file: string; temporaryDir?: string } {
  const preferred = path.join(LONCA_HOME, 'no-keys-agent.sock');
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return { file: preferred };
  // TMPDIR can be long too. A private directory under /tmp also works on macOS and Linux.
  const root = Buffer.byteLength(path.join(os.tmpdir(), 'lonca-XXXXXX', 'agent.sock')) <= MAX_SOCKET_PATH
    ? os.tmpdir() : '/tmp';
  const temporaryDir = fs.mkdtempSync(path.join(root, 'lonca-'));
  return { file: path.join(temporaryDir, 'agent.sock'), temporaryDir };
}

async function startAgent(): Promise<string> {
  const { file, temporaryDir } = socketPath();
  let server: net.Server | undefined;
  try {
    fs.rmSync(file, { force: true });
    const listener = server = net.createServer(serve);
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(file, resolve);
    });
    fs.chmodSync(file, 0o600);
    server.unref();
    return file;
  } catch (error) {
    const listener = server;
    if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
    if (temporaryDir) {
      try { fs.rmSync(temporaryDir, { recursive: true, force: true }); } catch { /* Keep the startup error. */ }
    }
    throw error;
  }
}

let starting: Promise<string> | null = null;

/** A command must wait for this agent; a failed startup blocks it and lets the next call retry. */
export function emptyAgent(): Promise<string> {
  starting ??= startAgent().catch((error: unknown) => {
    starting = null;
    throw new Error(`Could not start the SSH agent that keeps keys out of sandboxes: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
  return starting;
}
