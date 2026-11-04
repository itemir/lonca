import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
const servers: net.Server[] = [];
const temporaryDirs = new Set<string>();

beforeEach(() => {
  vi.resetModules();
  root = fs.realpathSync(fs.mkdtempSync('/tmp/lonca-ssh-test-'));
  vi.stubEnv('LONCA_HOME', root);
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'host-agent.sock'));
  vi.stubEnv('LONCA_SBX', path.join(root, 'sbx'));
  vi.stubEnv('LONCA_TEST_SBX_CALLS', path.join(root, 'calls'));
  // Exercise the actual CLI launch paths without running a user's sandbox or SSH agent.
  fs.writeFileSync(path.join(root, 'sbx'), '#!/bin/sh\nprintf "%s\\n" "$SSH_AUTH_SOCK" >> "$LONCA_TEST_SBX_CALLS"\nprintf "[]\\n"\n', { mode: 0o700 });
  const createServer = net.createServer;
  vi.spyOn(net, 'createServer').mockImplementation((...args: Parameters<typeof net.createServer>) => {
    const server = createServer(...args);
    servers.push(server);
    server.on('listening', () => {
      const address = server.address();
      if (typeof address === 'string' && !address.startsWith(`${root}/`)) temporaryDirs.add(path.dirname(address));
    });
    return server;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
  temporaryDirs.clear();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function runCommands(): Promise<PromiseSettledResult<unknown>[]> {
  const { isSandboxRunning, sandboxExec, sandboxStream, sandboxTty } = await import('../../server/sandbox.ts');
  return Promise.allSettled([
    isSandboxRunning('test'),
    sandboxExec('test', ['true']),
    sandboxStream('test', ['true']).then(async (stream) => {
      stream.stdout.resume();
      stream.stderr.resume();
      await stream.finished;
    }),
    sandboxTty('test', ['true'], {}).then(async (tty) => {
      tty.stream.resume();
      await tty.exitCode();
    }),
  ]);
}

describe('sandbox commands require the protective SSH agent', () => {
  it.each(['preparation', 'listen event', 'listen call', 'permissions'] as const)('blocks every CLI path after a %s failure and recovers on retry', async (phase) => {
    // Load config before injecting filesystem failures meant for the socket startup.
    const { emptyAgent } = await import('../../server/ssh-agent.ts');
    const error = new Error(`injected ${phase} failure`);
    const fault = phase === 'preparation'
      ? vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw error; })
      : phase === 'permissions'
        ? vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw error; })
        : vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server) {
          if (phase === 'listen call') throw error;
          queueMicrotask(() => this.emit('error', error));
          return this;
        });

    const failed = await runCommands();
    expect(failed.map((result) => result.status)).toEqual(Array(4).fill('rejected'));
    for (const result of failed) {
      if (result.status === 'rejected') expect(result.reason.message).toMatch(/SSH agent.*injected/);
    }
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
    expect(servers.every((server) => !server.listening)).toBe(true);

    fault.mockRestore();
    const retried = await runCommands();
    expect(retried.map((result) => result.status)).toEqual(Array(4).fill('fulfilled'));
    const agent = await emptyAgent();
    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n')).toEqual(Array(4).fill(agent));
    expect(fs.statSync(agent).isSocket()).toBe(true);
    expect(fs.statSync(agent).mode & 0o777).toBe(0o600);
    expect(servers.filter((server) => server.listening)).toHaveLength(1);
  });

  it.each([false, true])('uses a byte-safe socket path with a multibyte home (long TMPDIR: %s)', async (longTmpdir) => {
    const home = path.join(root, '界'.repeat(24));
    const preferred = path.join(home, 'no-keys-agent.sock');
    expect(preferred.length).toBeLessThan(100);
    expect(Buffer.byteLength(preferred)).toBeGreaterThan(100);
    vi.stubEnv('LONCA_HOME', home);
    if (longTmpdir) {
      const tmpdir = path.join(root, 'tmp'.repeat(40));
      fs.mkdirSync(tmpdir);
      vi.stubEnv('TMPDIR', tmpdir);
    }
    const results = await runCommands();
    expect(results.map((result) => result.status)).toEqual(Array(4).fill('fulfilled'));
    const { emptyAgent } = await import('../../server/ssh-agent.ts');
    const agent = await emptyAgent();
    expect(agent).toBeTruthy();
    expect(Buffer.byteLength(agent)).toBeLessThanOrEqual(100);
    expect(fs.statSync(agent).isSocket()).toBe(true);
    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n')).toEqual(Array(4).fill(agent));
  });
});
