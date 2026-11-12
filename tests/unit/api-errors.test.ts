import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/types.ts';

const changes = vi.hoisted(() => ({ read: async (): Promise<never> => { throw new Error('not set'); } }));
vi.mock('../../server/inspect.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/inspect.ts')>(),
  getChanges: () => changes.read(),
}));

let home: string;
let server: Server;
let base: string;
let sandbox: typeof import('../../server/sandbox.ts');

beforeEach(async () => {
  vi.resetModules();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-api-errors-'));
  vi.stubEnv('LONCA_HOME', home);
  const store = await import('../../server/store.ts');
  const { createApi } = await import('../../server/api.ts');
  sandbox = await import('../../server/sandbox.ts');
  store.state.workspaces.push({ id: 'w1', projectId: 'p1', name: 'amman', status: 'ready', sandboxName: 'lonca-app-amman' } as Workspace);
  const app = express();
  app.use('/api', createApi({ name: 'Me', machine: 'Me’s Mac' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it('answers 504 when a sandbox doesn’t answer in time, and logs one line saying where', async () => {
  changes.read = async () => { throw new sandbox.SandboxTimeoutError('Timed out running bash in the workspace’s sandbox', 'lonca-app-amman'); };
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await fetch(`${base}/api/workspaces/w1/changes?fresh=1`);
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ error: 'Timed out running bash in the workspace’s sandbox' });
  expect(logged.mock.calls).toEqual([['GET /api/workspaces/w1/changes: Timed out running bash in the workspace’s sandbox (lonca-app-amman)']]);
});

it('names the workspace’s sandbox when what timed out doesn’t know it', async () => {
  changes.read = async () => { throw new sandbox.SandboxTimeoutError('sbx ls took too long'); };
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await fetch(`${base}/api/workspaces/w1/changes`);
  expect(response.status).toBe(504);
  expect(logged.mock.calls).toEqual([['GET /api/workspaces/w1/changes: sbx ls took too long (lonca-app-amman)']]);
});

it('still logs anything else that fails with its stack', async () => {
  const bug = new Error('something broke');
  changes.read = async () => { throw bug; };
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await fetch(`${base}/api/workspaces/w1/changes`);
  expect(response.status).toBe(500);
  expect(logged.mock.calls).toEqual([[bug]]);
});
