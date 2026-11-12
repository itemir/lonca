import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../server/ssh-agent.ts', () => ({ emptyAgent: async () => '' }));
let root: string;
let sandbox: typeof import('../../server/sandbox.ts');

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-timeout-test-'));
  vi.stubEnv('LONCA_HOME', root);
  vi.stubEnv('LONCA_SBX', path.join(root, 'sbx'));
  // Docker Sandboxes never answers, as it can't while the computer sleeps.
  fs.writeFileSync(path.join(root, 'sbx'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
  sandbox = await import('../../server/sandbox.ts');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it('gives up on a command its sandbox doesn’t answer, saying which sandbox it was', async () => {
  const failure = sandbox.exec('lonca-app-amman', ['bash', '-c', 'true'], { timeoutMs: 1000 }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  const error = await failure;
  expect(error).toBeInstanceOf(sandbox.SandboxTimeoutError);
  expect(error).toMatchObject({ status: 504, sandbox: 'lonca-app-amman', message: 'Timed out running bash in the workspace’s sandbox' });
});

it('gives up on an sbx command that doesn’t answer', async () => {
  const failure = sandbox.isSandboxRunning('lonca-app-amman').catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(61_000);
  const error = await failure;
  expect(error).toBeInstanceOf(sandbox.SandboxTimeoutError);
  expect(error).toMatchObject({ status: 504, message: 'sbx ls took too long' });
});
