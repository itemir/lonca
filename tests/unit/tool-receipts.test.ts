import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/types.ts';
import type { ToolCall } from '../../server/agents/process.ts';

let home: string;
let store: typeof import('../../server/store.ts');
let runner: typeof import('../../server/agents/runner.ts');
let team: typeof import('../../server/agents/team.ts');
let workspace: Workspace;
let lead: Session;
let agent: Session;
const call = (tool: string, args: Record<string, unknown>): ToolCall => ({ id: 'a'.repeat(32), tool, args });
const saved = (id: string): Session => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).sessions.find((entry: Session) => entry.id === id);

beforeEach(async () => {
  vi.resetModules();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-tool-receipts-')));
  vi.stubEnv('LONCA_HOME', home);
  store = await import('../../server/store.ts');
  runner = await import('../../server/agents/runner.ts');
  team = await import('../../server/agents/team.ts');
  // Keep accepted work queued; integration tests exercise real processes and server recovery.
  workspace = { id: 'workspace', projectId: 'project', name: 'prague', sandboxName: 'vm', status: 'creating', title: 'Work', steps: [] } as unknown as Workspace;
  store.state.workspaces.push(workspace);
  lead = runner.createLead(workspace);
  agent = runner.createSession(workspace, { role: 'agent', work: { job: 'analyze' } });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.flushTranscripts();
  store.flushState();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it('keeps cancelled messages and their old jobs cancelled across a reload and replay', async () => {
  runner.persistSession(agent, { held: true, userStopped: true });
  const request = call('message_agent', { id: agent.id, text: 'Implement the old plan.', job: 'implement' });
  const reply = await team.handleToolCall(lead, request);
  expect(reply.failed, reply.text).toBeUndefined();
  expect(saved(lead.id).toolReplies?.[request.id]).toEqual(reply);
  expect(saved(agent.id)).toMatchObject({ queue: [request.id], work: { job: 'implement' } });
  runner.cancelQueued(agent.id, request.id);
  runner.persistSession(agent, { work: { ...agent.work!, job: 'review' } });
  store.flushTranscripts();
  store.flushState();
  vi.resetModules();
  store = await import('../../server/store.ts');
  runner = await import('../../server/agents/runner.ts');
  team = await import('../../server/agents/team.ts');
  lead = store.getSession(lead.id)!;
  agent = store.getSession(agent.id)!;
  expect(await team.handleToolCall(lead, request)).toEqual(reply);
  expect(agent).toMatchObject({ queue: [], held: true, userStopped: true, work: { job: 'review' } });
});

it('does not recreate a spawned agent that the user deleted before receiving the tool reply', async () => {
  const request = call('spawn_agent', { label: 'Worker', task: 'Analyze this.', job: 'analyze', model: lead.model });
  const reply = await team.handleToolCall(lead, request);
  expect(reply.failed).toBeUndefined();
  const spawned = runner.agentsOf(workspace.id).find((entry) => entry.id !== agent.id)!;
  await runner.deleteSession(spawned.id);
  expect(await team.handleToolCall(lead, request)).toEqual(reply);
  expect(runner.agentsOf(workspace.id)).toEqual([agent]);
});

it('records an idle stop so its replay cannot target a newer run awaiting recovery', async () => {
  const request = call('stop_agent', { id: agent.id });
  const reply = await team.handleToolCall(lead, request);
  expect(reply.failed).toBeUndefined();
  expect(saved(lead.id).toolReplies?.[request.id]).toEqual(reply);
  runner.persistSession(agent, { status: 'running', activeRunId: 'new-run' });
  expect(await team.handleToolCall(lead, request)).toEqual(reply);
  expect(agent.stopRequested).toBeUndefined();
  expect(agent.activeRunId).toBe('new-run');
});

it.each(['message_agent', 'retry_agent'])('does not mistake an orphaned transcript item for an accepted %s call', async (tool) => {
  const request = call(tool, { id: agent.id, text: 'Work that was never accepted.' });
  const { transcriptFor } = await import('../../server/transcript.ts');
  // A crash between transcript flush and state rename leaves this item without a queue reservation.
  transcriptFor(agent.id).upsert({ id: request.id, type: 'user', ts: Date.now(), text: 'Work that was never accepted.', attachments: [], from: 'lead', queued: true });
  store.flushTranscripts();
  store.flushState();
  vi.resetModules();
  store = await import('../../server/store.ts');
  runner = await import('../../server/agents/runner.ts');
  team = await import('../../server/agents/team.ts');
  lead = store.getSession(lead.id)!;
  agent = store.getSession(agent.id)!;
  const reply = await team.handleToolCall(lead, request);
  expect(reply.failed).toBeUndefined();
  expect(saved(agent.id).queue).toEqual([request.id]);
  expect(saved(lead.id).toolReplies?.[request.id]).toEqual(reply);
});

it.each(['message_agent', 'retry_agent'])('keeps an accepted %s from an older server deduplicated after cancellation', async (tool) => {
  const request = call(tool, { id: agent.id, text: 'Already accepted.' });
  await runner.sendMessage(agent.id, 'Already accepted.', [], { id: request.id, from: 'lead' });
  runner.persistSession(agent, { held: true, lastOutcome: 'limit' });
  const reply = await team.handleToolCall(lead, request);
  expect(reply.failed).toBeUndefined();
  expect(saved(agent.id)).toMatchObject({ queue: [request.id], held: true });
  expect(saved(lead.id).toolReplies?.[request.id]).toEqual(reply);
  runner.cancelQueued(agent.id, request.id);
  expect(await team.handleToolCall(lead, request)).toEqual(reply);
  expect(agent).toMatchObject({ queue: [], held: true });
});

it('keeps a retry refused by a user stop refused after the user resumes', async () => {
  const request = call('retry_agent', { id: agent.id });
  runner.persistSession(agent, { held: true, userStopped: true });
  const reply = await team.handleToolCall(lead, request);
  expect(reply.text).toContain('stopped by the user');
  runner.persistSession(agent, { held: false, userStopped: undefined });
  expect(await team.handleToolCall(lead, request)).toEqual(reply);
  expect(agent.queue).toEqual([]);
});

it.each(['message_agent', 'retry_agent'])('rolls back the %s mutation and receipt together if saving fails', async (name) => {
  if (name === 'retry_agent') await runner.sendMessage(agent.id, 'Already queued.', [], { from: 'lead' });
  runner.persistSession(agent, { held: true, lastOutcome: 'limit' });
  const queue = [...agent.queue];
  const request = call(name, { id: agent.id, text: 'New work.', job: 'implement' });
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === path.join(home, 'state.json')) throw new Error('state write failed');
    rename(from, to);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(team.handleToolCall(lead, request)).rejects.toThrow('state write failed');
  expect(agent).toMatchObject({ held: true, queue, work: { job: 'analyze' } });
  expect(lead.toolReplies).toBeUndefined();
  expect(saved(agent.id)).toMatchObject({ held: true, queue, work: { job: 'analyze' } });
  expect(saved(lead.id).toolReplies).toBeUndefined();
  failure.mockRestore();
  const reply = await team.handleToolCall(lead, request);
  expect(reply.failed).toBeUndefined();
  expect(saved(lead.id).toolReplies?.[request.id]).toEqual(reply);
  expect(saved(agent.id)).toMatchObject(name === 'retry_agent'
    ? { held: false, queue, queueRetryIds: [request.id] }
    : { held: true, queue: [request.id], work: { job: 'implement' } });
});
