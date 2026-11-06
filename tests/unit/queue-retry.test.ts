import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/types.ts';

let home: string;
let runner: typeof import('../../server/agents/runner.ts');
let store: typeof import('../../server/store.ts');
let agent: Session;
const retryId = 'a'.repeat(32);

beforeEach(async () => {
  vi.resetModules();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-queue-retry-')));
  vi.stubEnv('LONCA_HOME', home);
  store = await import('../../server/store.ts');
  runner = await import('../../server/agents/runner.ts');
  // Accept messages without starting a CLI; the Docker test covers actual execution and replay.
  const workspace = { id: 'workspace', projectId: 'project', name: 'prague', status: 'creating', title: 'Work' } as Workspace;
  store.state.workspaces.push(workspace);
  agent = runner.createSession(workspace, { role: 'agent', work: { job: 'implement' } });
  await runner.sendMessage(agent.id, 'Queued work.', [], { from: 'lead' });
  runner.persistSession(agent, { held: true, lastOutcome: 'stopped' });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.flushTranscripts();
  store.flushState();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function saved(): Session {
  return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).sessions.find((entry: Session) => entry.id === agent.id);
}

it('saves a queued retry receipt together with the queue release', async () => {
  const queue = [...agent.queue];
  await runner.flushQueue(agent.id, retryId);
  expect(saved()).toMatchObject({ held: false, queue, queueRetryIds: [retryId] });
});

it('keeps the retry available and the queue held when saving its release fails', async () => {
  const rename = fs.renameSync;
  const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === path.join(home, 'state.json')) throw new Error('state write failed');
    rename(from, to);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(runner.flushQueue(agent.id, retryId)).rejects.toThrow('state write failed');
  expect(agent.held).toBe(true);
  expect(agent.queueRetryIds).toBeUndefined();
  expect(saved()).toMatchObject({ held: true, queue: agent.queue });
  expect(saved().queueRetryIds).toBeUndefined();
  fail.mockRestore();
  await runner.flushQueue(agent.id, retryId);
  expect(saved()).toMatchObject({ held: false, queueRetryIds: [retryId] });
});

it('does not release a later user stop when an earlier retry is replayed', async () => {
  await runner.flushQueue(agent.id, retryId);
  runner.persistSession(agent, { held: true });
  await runner.flushQueue(agent.id, 'b'.repeat(32));
  runner.persistSession(agent, { held: true, userStopped: true });
  await runner.flushQueue(agent.id, retryId);
  expect(saved()).toMatchObject({ held: true, userStopped: true, queueRetryIds: [retryId, 'b'.repeat(32)] });
});
