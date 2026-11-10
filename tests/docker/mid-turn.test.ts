import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppState, ChatItem, Project, ResultItem, Session, ToolItem, UserItem, Workspace } from '../../shared/types.ts';
import { Lonca, asRoot, makeFixtureRepo, sandboxExec, sleep, until } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

// The real Claude CLI in a real workspace, with only the model replaced. A message sent while it
// works goes through the turn's inbox and inbox.py, as in real use.

const lonca = new Lonca({ port: 48453, instance: 'mid-turn-test', firstWorkspacePort: 58600 });
let mock: MockLlm;
let fixture: string;
let project: Project;

const send = (id: string, text: string) => lonca.api<UserItem>('POST', `/sessions/${id}/messages`, { text, attachments: [] });
const users = (items: ChatItem[]) => items.filter((item): item is UserItem => item.type === 'user');
const results = (items: ChatItem[]) => items.filter((item): item is ResultItem => item.type === 'result');
const state = () => lonca.api<AppState>('GET', '/state');
// Claude Code refuses a long `sleep`, but not this.
const work = (seconds: number) => `RUN: python3 -c "import time; time.sleep(${seconds})"`;
/** Requests from the conversation itself, rather than the CLI naming it, which come with its tools. */
const turnsSince = (from: number) => mock.requests.slice(from)
  .filter((request) => request.path.endsWith('/messages') && (JSON.parse(request.body).tools ?? []).length > 0);
/** What the chat shows, in order: each message's and reply's words, and other items' kinds. */
const shown = (items: ChatItem[]) => items.map((item) => item.type === 'user' || item.type === 'text' ? item.text : item.type);

async function conversation(): Promise<{ workspace: Workspace; session: Session }> {
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  return { workspace: await lonca.waitForWorkspace(created.workspace.id), session: created.session };
}

async function commandRunning(sessionId: string): Promise<void> {
  await until('the command to start', async () => (await lonca.items(sessionId)).some((item) => item.type === 'tool' && item.status === 'running'));
}

async function passedOn(sessionId: string, itemId: string): Promise<void> {
  await until('the message to be passed on', async () => users(await lonca.items(sessionId)).find((item) => item.id === itemId)?.handoff);
}

/** Makes saving this file fail, as a full disk would, until the returned function is called. */
function failWrites(file: string): () => void {
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  let restored = false;
  return () => {
    if (restored) return;
    fs.rmdirSync(file);
    fs.renameSync(`${file}.saved`, file);
    restored = true;
  };
}

/** The turn's inbox in its VM, which inbox.py renames once it stops reading it. */
async function inbox(sessionId: string): Promise<string> {
  return `/var/tmp/lonca/agent-runs/${(await lonca.session(sessionId)).activeRunId}/inbox`;
}

beforeAll(async () => {
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', env: {
    ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock',
  } } });
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

it('reads a message sent while a command runs, in the same turn, where it read it', async () => {
  const { session } = await conversation();
  await send(session.id, work(6));
  await commandRunning(session.id);
  const before = mock.requests.length;
  const sent = await send(session.id, 'MID-TURN CORRECTION');
  expect(sent.queued).toBe(true);
  await passedOn(session.id, sent.id);
  // The agent may already be reading it.
  await expect(lonca.api('DELETE', `/sessions/${session.id}/queue/${sent.id}`)).rejects.toThrow(/409/);
  const items = await lonca.waitForIdle(session.id);
  expect(results(items)).toHaveLength(1);
  const read = users(items).find((item) => item.id === sent.id)!;
  expect(read).toMatchObject({ queued: false, midTurn: true });
  expect(read.handoff).toBeUndefined();
  const order = shown(items);
  expect(order.indexOf('MID-TURN CORRECTION')).toBeGreaterThan(order.indexOf('tool'));
  expect(order.at(-2)).toBe('The command finished.');
  expect(await lonca.session(session.id)).toMatchObject({ queue: [], lastOutcome: 'completed' });
  // The model was asked once more, with the command's result and the message together.
  expect(turnsSince(before).filter((request) => request.body.includes('MID-TURN CORRECTION'))).toHaveLength(1);
});

it('passes on messages sent while its turn starts, in the order they were sent', async () => {
  const { session } = await conversation();
  const before = mock.requests.length;
  // Before the turn has launched, and again straight after, without waiting.
  await send(session.id, work(6));
  const first = await send(session.id, 'FOLLOW-UP ONE');
  await commandRunning(session.id);
  const second = await send(session.id, 'FOLLOW-UP TWO');
  const items = await lonca.waitForIdle(session.id);
  expect(results(items)).toHaveLength(1);
  const read = users(items).filter((item) => item.midTurn).map((item) => item.id);
  expect(read).toEqual([first.id, second.id]);
  const request = turnsSince(before).find((entry) => entry.body.includes('FOLLOW-UP TWO'))!;
  expect(request.body.indexOf('FOLLOW-UP ONE')).toBeGreaterThan(-1);
  expect(request.body.indexOf('FOLLOW-UP ONE')).toBeLessThan(request.body.indexOf('FOLLOW-UP TWO'));
});

it('answers a message sent while it writes its final reply in another turn of the same run', async () => {
  const { session } = await conversation();
  const before = mock.requests.length;
  await send(session.id, 'SLOW FIRST REQUEST');
  await until('the model to be asked', () => turnsSince(before).some((request) => request.body.includes('SLOW FIRST REQUEST')));
  const sent = await send(session.id, 'WHILE IT REPLIES');
  const items = await lonca.waitForIdle(session.id, 150000);
  const runId = (results(items)[0]).runId;
  expect(results(items).map((item) => item.id)).toEqual([`${runId}:result`, `${runId}:result:2`]);
  expect(shown(items).slice(-6)).toEqual([
    'SLOW FIRST REQUEST', 'Mock Claude here. You said: SLOW FIRST REQUEST', 'result',
    'WHILE IT REPLIES', 'Mock Claude here. You said: WHILE IT REPLIES', 'result',
  ]);
  expect(users(items).find((item) => item.id === sent.id)).toMatchObject({ queued: false, midTurn: true });
  expect(await lonca.session(session.id)).toMatchObject({ queue: [], lastOutcome: 'completed' });
});

it('keeps a message the agent hadn\'t read when it was stopped, held for its next turn', async () => {
  const { session } = await conversation();
  await send(session.id, work(60));
  await commandRunning(session.id);
  const before = mock.requests.length;
  const sent = await send(session.id, 'SENT BEFORE STOP');
  await passedOn(session.id, sent.id);
  await lonca.api('POST', `/sessions/${session.id}/interrupt`);
  await until('the turn to stop', async () => (await lonca.session(session.id)).status === 'idle');
  expect(await lonca.session(session.id)).toMatchObject({ queue: [sent.id], held: true });
  const waiting = users(await lonca.items(session.id)).find((item) => item.id === sent.id)!;
  expect(waiting).toMatchObject({ queued: true });
  expect(waiting.handoff).toBeUndefined();
  expect(turnsSince(before).filter((request) => request.body.includes('SENT BEFORE STOP'))).toHaveLength(0);
  // It can be cancelled again, or sent: here, sent, and only once.
  await lonca.api('POST', `/sessions/${session.id}/queue/flush`);
  const items = await lonca.waitForIdle(session.id);
  expect(users(items).filter((item) => item.text === 'SENT BEFORE STOP')).toEqual([expect.objectContaining({ queued: false })]);
  expect(users(items).find((item) => item.id === sent.id)?.midTurn).toBeFalsy();
  expect(turnsSince(before).filter((request) => request.body.includes('SENT BEFORE STOP'))).toHaveLength(1);
});

it.each(['once Claude has read it', 'while Claude still works'] as const)('reads a message passed on before a restart once, and keeps its place, restarting %s', async (when) => {
  const { workspace, session } = await conversation();
  await send(session.id, work(8));
  await commandRunning(session.id);
  const sent = await send(session.id, 'PASSED ON BEFORE A RESTART');
  const dir = await inbox(session.id);
  await until('its file to be written', () => sandboxExec(workspace.sandboxName, `ls '${dir}' | grep -q json`).code === 0);
  await lonca.kill();
  // Claude reads it while there's no server to see it, or with the new one watching, which writes its file again.
  if (when === 'once Claude has read it') await sleep(12000);
  await lonca.start();
  const items = await lonca.waitForIdle(session.id);
  expect(results(items)).toHaveLength(1);
  expect(users(items).filter((item) => item.text === 'PASSED ON BEFORE A RESTART')).toEqual([expect.objectContaining({ id: sent.id, queued: false, midTurn: true })]);
  const order = shown(items);
  expect(order.indexOf('PASSED ON BEFORE A RESTART')).toBeGreaterThan(order.indexOf('tool'));
  expect(order.at(-2)).toBe('The command finished.');
  expect(await lonca.session(session.id)).toMatchObject({ queue: [], lastOutcome: 'completed' });
});

it.each(['retry', 'restart'] as const)('neither runs a message twice nor moves it after its answer when saving that it was read fails, then %s', async (recovery) => {
  const { workspace, session } = await conversation();
  await send(session.id, work(8));
  await commandRunning(session.id);
  const sent = await send(session.id, 'READ WHILE SAVING FAILS');
  const dir = await inbox(session.id);
  await until('its file to be written', () => sandboxExec(workspace.sandboxName, `ls '${dir}' | grep -q json`).code === 0);
  const logStart = lonca.log.length;
  const restore = failWrites(path.join(lonca.home, 'state.json'));
  try {
    // The conversation saves it as read, but state.json still has it queued.
    await until('saving it as read to fail', () => lonca.log.slice(logStart).includes('could not save a message as read'), 60000);
    await until('saving the finished turn to fail', () => lonca.log.slice(logStart).includes('could not finish saving a turn:'), 60000);
    if (recovery === 'restart') await lonca.kill();
    restore();
    if (recovery === 'restart') await lonca.start();
    const items = await lonca.waitForIdle(session.id);
    expect(results(items)).toHaveLength(1);
    expect(users(items).filter((item) => item.text === 'READ WHILE SAVING FAILS')).toEqual([expect.objectContaining({ id: sent.id, queued: false, midTurn: true })]);
    // Where it was read, before the reply that took it in, whatever is said about saving after that.
    const order = shown(items);
    expect(order.indexOf('READ WHILE SAVING FAILS')).toBeGreaterThan(order.indexOf('tool'));
    expect(order.indexOf('READ WHILE SAVING FAILS')).toBeLessThan(order.indexOf('The command finished.'));
    expect(await lonca.session(session.id)).toMatchObject({ queue: [], lastOutcome: 'completed' });
  } finally {
    restore();
  }
});

it('keeps a message whose file may not have been written for the next turn, and from being cancelled meanwhile', async () => {
  const { workspace, session } = await conversation();
  await send(session.id, work(10));
  await commandRunning(session.id);
  const dir = await inbox(session.id);
  // Every write fails, as one whose acknowledgment was lost would look to the server.
  expect(sandboxExec(workspace.sandboxName, `chmod a-w '${dir}'`).code).toBe(0);
  const logStart = lonca.log.length;
  const before = mock.requests.length;
  const sent = await send(session.id, 'NEVER WRITTEN');
  await passedOn(session.id, sent.id);
  await sleep(4000);
  await expect(lonca.api('DELETE', `/sessions/${session.id}/queue/${sent.id}`)).rejects.toThrow(/409/);
  const items = await lonca.waitForIdle(session.id);
  // The turn under way never read it, so it started the next one, once.
  expect(results(items)).toHaveLength(2);
  expect(users(items).filter((item) => item.text === 'NEVER WRITTEN')).toEqual([expect.objectContaining({ queued: false })]);
  expect(users(items).find((item) => item.id === sent.id)?.midTurn).toBeFalsy();
  expect(turnsSince(before).some((request) => request.body.includes('NEVER WRITTEN'))).toBe(true);
  expect(lonca.log.slice(logStart)).not.toContain('could not pass a message');
});

it('keeps a message read while the server was down from being cancelled until recovery has read its echo', async () => {
  const { workspace, session } = await conversation();
  await send(session.id, work(6));
  await commandRunning(session.id);
  const sent = await send(session.id, 'READ WHILE THE SERVER WAS DOWN');
  const dir = await inbox(session.id);
  const runDir = dir.replace(/\/inbox$/, '');
  await until('its file to be written', () => sandboxExec(workspace.sandboxName, `ls '${dir}' | grep -q json`).code === 0);
  await lonca.kill();
  // Claude reads it, answers and finishes with no server watching, and its inbox closes.
  await until('the turn to end', () => sandboxExec(workspace.sandboxName, `test -f '${runDir}/exit'`).code === 0, 60000);
  // The new server can't read the turn's output for now, so its recovery stops short of the echo.
  expect(sandboxExec(workspace.sandboxName, `chmod 000 '${runDir}/out.jsonl'`).code).toBe(0);
  try {
    await lonca.start();
    await until('recovery to be held up', async () => (await lonca.items(session.id))
      .some((item) => item.type === 'notice' && item.text.startsWith('Reading this conversation was interrupted')));
    // By now it has tried to pass the message on again, and found the inbox closed.
    await sleep(3000);
    await expect(lonca.api('DELETE', `/sessions/${session.id}/queue/${sent.id}`)).rejects.toThrow(/409/);
  } finally {
    sandboxExec(workspace.sandboxName, `chmod 644 '${runDir}/out.jsonl'`);
  }
  const items = await lonca.waitForIdle(session.id);
  expect(results(items)).toHaveLength(1);
  expect(users(items).filter((item) => item.text === 'READ WHILE THE SERVER WAS DOWN')).toEqual([expect.objectContaining({ id: sent.id, queued: false, midTurn: true })]);
  const order = shown(items);
  expect(order.indexOf('READ WHILE THE SERVER WAS DOWN')).toBeLessThan(order.indexOf('The command finished.'));
});

it('reads a message once when its file was written but the server was told it wasn\'t', async () => {
  const { workspace, session } = await conversation();
  await send(session.id, work(8));
  await commandRunning(session.id);
  // Every write works but says it failed, as one whose acknowledgment was lost would look to the server.
  asRoot(workspace.sandboxName, 'printf \'#!/bin/bash\\n/bin/mv "$@"\\nexit 1\\n\' > /usr/local/bin/mv && chmod +x /usr/local/bin/mv');
  try {
    const sent = await send(session.id, 'WRITTEN BUT NOT ACKNOWLEDGED');
    await passedOn(session.id, sent.id);
    await expect(lonca.api('DELETE', `/sessions/${session.id}/queue/${sent.id}`)).rejects.toThrow(/409/);
    const items = await lonca.waitForIdle(session.id);
    expect(results(items)).toHaveLength(1);
    expect(users(items).filter((item) => item.text === 'WRITTEN BUT NOT ACKNOWLEDGED')).toEqual([expect.objectContaining({ id: sent.id, queued: false, midTurn: true })]);
  } finally {
    asRoot(workspace.sandboxName, 'rm -f /usr/local/bin/mv');
  }
});

it('passes the Lead\'s message to a working agent during its turn', async () => {
  const { session: lead } = await conversation();
  await send(lead.id, `TOOL: spawn_agent ${JSON.stringify({ label: 'Busy', task: work(10), model: 'claude-sonnet-5-5', job: 'analyze' })}`);
  const agent = await until('the agent to start', async () => (await state()).sessions.find((entry) => entry.workspaceId === lead.workspaceId && entry.role === 'agent'));
  await commandRunning(agent.id);
  await until('the Lead to wait', async () => (await lonca.session(lead.id)).status === 'idle');
  await send(lead.id, `TOOL: message_agent ${JSON.stringify({ id: agent.id, text: 'FROM THE LEAD' })}`);
  await until('the agent to read it', async () => users(await lonca.items(agent.id)).find((item) => item.text === 'FROM THE LEAD')?.midTurn);
  const items = await lonca.waitForIdle(agent.id);
  expect(results(items)).toHaveLength(1);
  const reply = (await lonca.items(lead.id)).find((item): item is ToolItem => item.type === 'tool' && item.name === 'mcp__lonca__message_agent');
  expect(reply?.output).toContain('at its next step');
});
