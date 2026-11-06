import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/types.ts';

let home: string;
let runner: typeof import('../../server/agents/runner.ts');
let team: typeof import('../../server/agents/team.ts');
let store: typeof import('../../server/store.ts');
let agent: Session;

beforeEach(async () => {
  vi.resetModules();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-agent-stop-'));
  vi.stubEnv('LONCA_HOME', home);
  store = await import('../../server/store.ts');
  runner = await import('../../server/agents/runner.ts');
  team = await import('../../server/agents/team.ts');
  // A message accepted before recovery has reached the old process must also release its saved
  // queue hold. Keeping the workspace in creation leaves launching to the integration tests.
  const workspace = { id: 'workspace', projectId: 'project', name: 'prague', status: 'creating', title: 'Work' } as Workspace;
  store.state.workspaces.push(workspace);
  agent = runner.createSession(workspace, { role: 'agent', work: { job: 'implement' } });
  Object.assign(agent, { status: 'running', activeRunId: 'old-run', stopRequested: { holdQueue: true }, held: false });
});

afterEach(() => {
  store.flushTranscripts();
  store.flushState();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function saved(): Session {
  return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).sessions.find((entry: Session) => entry.id === agent.id);
}

it('lets a Lead message release a Lead stop before the old process has finished', async () => {
  await runner.sendMessage(agent.id, 'Continue after stopping.', [], { from: 'lead', keepHeld: true });
  expect(saved()).toMatchObject({ held: false, stopRequested: { holdQueue: false }, queue: [expect.any(String)] });
});

it.each(['stopped', 'limit'] as const)('keeps a user stop through a Lead message even when the last outcome is %s', async (outcome) => {
  agent.lastOutcome = outcome;
  agent.held = true;
  team.holdWhenStopped(agent);
  await runner.sendMessage(agent.id, 'Continue regardless.', [], { from: 'lead', keepHeld: true });
  expect(saved()).toMatchObject({ held: true, userStopped: true, stopRequested: { holdQueue: true }, queue: [expect.any(String)] });
});

it.each(['message', 'flush'] as const)('releases a user stop durably when the user chooses %s', async (action) => {
  team.holdWhenStopped(agent);
  await runner.sendMessage(agent.id, 'Waiting for the user.', [], { from: 'lead', keepHeld: true });
  if (action === 'message') await runner.sendMessage(agent.id, 'Continue.', []);
  else await runner.flushQueue(agent.id);
  expect(saved()).toMatchObject({ held: false, stopRequested: { holdQueue: false } });
  expect(saved().userStopped).toBeFalsy();
});

it.each(['limit', 'failed'] as const)('queues a Lead message behind a %s pause until an explicit retry', async (outcome) => {
  Object.assign(agent, { status: 'idle', activeRunId: null, stopRequested: undefined, held: true, lastOutcome: outcome });
  await runner.sendMessage(agent.id, 'When you can continue.', [], { from: 'lead', keepHeld: true });
  expect(saved()).toMatchObject({ held: true, queue: [expect.any(String)] });
  expect(saved().userStopped).toBeFalsy();
  await runner.flushQueue(agent.id);
  expect(saved().held).toBe(false);
});
