import fs from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppState, Project, Session, UserItem, Workspace } from '../../shared/types.ts';
import { Lonca, sandboxExec, makeFixtureRepo, until } from '../support/harness.ts';
import { startMockLlm, type MockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 48449, instance: 'lead-delivery-test', firstWorkspacePort: 58200 });
let mock: MockLlm;
let fixture: string;
let project: Project;
const send = (id: string, text: string) => lonca.api<UserItem>('POST', `/sessions/${id}/messages`, { text });
const tool = (name: string, args: unknown) => `TOOL: ${name} ${JSON.stringify(args)}`;
const state = () => lonca.api<AppState>('GET', '/state');
const agents = async (workspace: Workspace) => (await state()).sessions.filter((entry) => entry.workspaceId === workspace.id && entry.role === 'agent');
async function create() {
  const created = await lonca.api<{workspace: Workspace; session: Session}>('POST', `/projects/${project.id}/workspaces`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  return { workspace: await lonca.waitForWorkspace(created.workspace.id), lead: created.session };
}
async function settled(workspace: Workspace) {
  await until('the team to settle', async () => (await state()).sessions.filter((entry) => entry.workspaceId === workspace.id).every((entry) => entry.status === 'idle' && (!entry.queue.length || entry.held) && !entry.work?.unreported));
}
async function blockReply(workspace: Workspace, lead: Session, name: string, args: unknown) {
  const before = mock.requests.length;
  await send(lead.id, `SLOW ${tool(name, args)}`);
  await until('the tool request', () => mock.requests.slice(before).some((entry) => entry.body.includes(`SLOW TOOL: ${name}`)));
  const replies = `/var/tmp/lonca/agent-runs/${(await lonca.session(lead.id)).activeRunId}/replies`;
  expect(sandboxExec(workspace.sandboxName, `chmod a-w '${replies}'`).code).toBe(0);
  return replies;
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

it('does not replay a message that the user cancelled before its tool reply was saved', async () => {
  const { workspace, lead } = await create();
  await send(lead.id, tool('spawn_agent', { label: 'Held', task: 'FIRST-TURN', job: 'analyze', model: 'claude-sonnet-5-5' }));
  await until('the agent', async () => (await agents(workspace)).length === 1);
  await settled(workspace);
  const [agent] = await agents(workspace);
  await lonca.api('POST', `/sessions/${agent.id}/interrupt`);
  const logStart = lonca.log.length;
  const replies = await blockReply(workspace, lead, 'message_agent', { id: agent.id, text: 'CANCELLED-FOLLOW-UP' });
  try {
    const queued = await until('the follow-up to queue', async () => (await lonca.session(agent.id)).queue[0]);
    await until('the reply write to fail', () => lonca.log.slice(logStart).includes('could not answer a tool call'));
    await lonca.api('DELETE', `/sessions/${agent.id}/queue/${queued}`);
    expect((await lonca.session(agent.id)).queue).toEqual([]);
    await lonca.kill();
    expect(sandboxExec(workspace.sandboxName, `chmod u+w '${replies}'`).code).toBe(0);
    await lonca.start();
    await settled(workspace);
    const after = await lonca.session(agent.id);
    expect(after.queue).toEqual([]);
    expect((await lonca.session(lead.id)).toolReplies).toBeUndefined();
  } finally {
    sandboxExec(workspace.sandboxName, `chmod u+w '${replies}'`);
  }
});

it('does not repeat an old stop after the user starts a new turn', async () => {
  const { workspace, lead } = await create();
  await send(lead.id, tool('spawn_agent', { label: 'Resumed', task: 'FIRST-TURN', job: 'analyze', model: 'claude-sonnet-5-5' }));
  const agent = await until('the agent', async () => (await agents(workspace))[0]);
  await settled(workspace);
  const logStart = lonca.log.length;
  const replies = await blockReply(workspace, lead, 'stop_agent', { id: agent.id });
  try {
    await until('the reply write to fail', () => lonca.log.slice(logStart).includes('could not answer a tool call'));
    const before = mock.requests.length;
    await send(agent.id, 'SLOW USER-RESUMED-WORK');
    await until('the new model request', () => mock.requests.slice(before).some((entry) => entry.body.includes('SLOW USER-RESUMED-WORK')));
    await lonca.kill();
    expect(sandboxExec(workspace.sandboxName, `chmod u+w '${replies}'`).code).toBe(0);
    await lonca.start();
    await settled(workspace);
    const after = await lonca.session(agent.id);
    expect(after.lastOutcome).toBe('completed');
  } finally {
    sandboxExec(workspace.sandboxName, `chmod u+w '${replies}'`);
  }
});
