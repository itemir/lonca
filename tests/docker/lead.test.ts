import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSettings, AppState, ChatItem, Playbook, Project, Session, ToolItem, UserItem, Workspace } from '../../shared/types.ts';
import { Lonca, sandboxExec, makeFixtureRepo, until } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

// The real CLIs in a real workspace, with only the models replaced: a Lead's tools go through
// the same MCP server and files as in real use, and agents are real conversations.

const lonca = new Lonca({ port: 48411, instance: 'lead-test', firstWorkspacePort: 52000 });
let mock: MockLlm;
let fixture: string;
let project: Project;

const CODEX_MODEL = 'gpt-5.5';
const tools = (items: ChatItem[]) => items.filter((item): item is ToolItem => item.type === 'tool');
const teamTools = (items: ChatItem[]) => tools(items).filter((item) => item.kind === 'team');
const users = (items: ChatItem[]) => items.filter((item): item is UserItem => item.type === 'user');
const wakes = (items: ChatItem[]) => users(items).filter((item) => item.from === 'lonca');

const send = (id: string, text: string) => lonca.api<UserItem>('POST', `/sessions/${id}/messages`, { text, attachments: [] });
const spawn = (label: string, task: string, extra: Record<string, unknown> = {}) =>
  `TOOL: spawn_agent ${JSON.stringify({ label, task, model: 'claude-sonnet-5-5', job: 'analyze', ...extra })}`;
const tool = (name: string, args: Record<string, unknown> = {}) => `TOOL: ${name} ${JSON.stringify(args)}`;

async function state(): Promise<AppState> {
  return lonca.api<AppState>('GET', '/state');
}

async function agents(workspace: Workspace): Promise<Session[]> {
  return (await state()).sessions.filter((session) => session.workspaceId === workspace.id && session.role === 'agent').sort((a, b) => a.createdAt - b.createdAt);
}

async function newWorkspace(options: Record<string, unknown> = {}): Promise<{ workspace: Workspace; lead: Session }> {
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, options);
  const workspace = await lonca.waitForWorkspace(created.workspace.id);
  // Codex takes its model server from its config rather than its environment.
  sandboxExec(workspace.sandboxName, `cat > ~/.codex/config.toml <<EOF
cli_auth_credentials_store = "file"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://host.docker.internal:${mock.port}/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
supports_websockets = false
EOF`);
  return { workspace, lead: created.session };
}

/** The Lead and everyone working for it have gone quiet. */
async function settled(lead: Session): Promise<void> {
  await until('the Lead and its agents to finish', async () => {
    const current = await state();
    const team = current.sessions.filter((session) => session.workspaceId === lead.workspaceId && !session.closedAt);
    return team.every((session) => session.status === 'idle' && (session.queue.length === 0 || session.held) && !session.work?.unreported) && team.length > 0;
  }, 150000, 300);
}

async function waitForTool(lead: Session, match: (item: ToolItem) => boolean): Promise<ToolItem> {
  return until('a tool call to finish', async () => tools(await lonca.items(lead.id)).find((item) => match(item) && item.status !== 'running'), 120000);
}

beforeAll(async () => {
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: {
      network: 'host',
      env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock', OPENAI_API_KEY: 'sk-mock', MOCK_KEY: 'sk-mock' },
    },
  });
  await lonca.api('PUT', '/secrets/github', { token: 'gho_lead_test_token' });
  await until('sign-in status', async () => (await state()).system.agentsChecked, 120000);
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('a workspace’s Lead', () => {
  it('starts every workspace, on the default model, and there’s only ever one', async () => {
    await lonca.api('PATCH', '/settings', { leadDefault: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } });
    const { workspace, lead } = await newWorkspace();
    expect(lead).toMatchObject({ role: 'lead', title: 'Lead', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect((await lonca.workspace(workspace.id)).lead).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/lead`)).rejects.toThrow(/already has a Lead/);
    await lonca.api('PATCH', '/settings', { leadDefault: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' } });
  });

  it('can change model until the first message, then keeps it, leaving the default alone', async () => {
    const { workspace, lead } = await newWorkspace();
    const before = (await state()).settings as AppSettings;
    await lonca.api('PATCH', `/sessions/${lead.id}`, { model: 'claude-sonnet-5-5', effort: 'low' });
    expect((await lonca.workspace(workspace.id)).lead).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect((await lonca.workspace(workspace.id)).leadLockedAt).toBeUndefined();
    await send(lead.id, 'first message');
    await lonca.waitForIdle(lead.id);
    expect((await lonca.workspace(workspace.id)).leadLockedAt).toBeGreaterThan(0);
    expect(mock.requests.some((request) => request.model === 'claude-sonnet-5-5' && request.body.includes('first message'))).toBe(true);
    await expect(lonca.api('PATCH', `/sessions/${lead.id}`, { effort: 'high' })).rejects.toThrow(/stays on this model/);
    await expect(lonca.api('PATCH', `/sessions/${lead.id}`, { title: 'Boss' })).rejects.toThrow(/keeps its name/);
    const after = (await state()).settings as AppSettings;
    expect(after.defaultModel).toBe(before.defaultModel);
    expect(after.leadDefault).toEqual(before.leadDefault);
  });

  it('follows the playbook, a project’s own replacing the global one, from its next turn', async () => {
    const { lead } = await newWorkspace();
    // The CLI makes requests of its own, such as naming the conversation, without any of this.
    const toldInTurn = async (text: string) => {
      const before = mock.requests.length;
      await send(lead.id, text);
      await lonca.waitForIdle(lead.id);
      return mock.requests.slice(before).find((request) => request.body.includes('You are the Lead'))?.body;
    };
    await lonca.api('PUT', '/playbook', { content: 'GLOBAL-PLAYBOOK-MARKER' });
    expect(await toldInTurn('one')).toContain('GLOBAL-PLAYBOOK-MARKER');
    const own = await lonca.api<Playbook>('PUT', '/playbook', { project: project.id, content: 'PROJECT-PLAYBOOK-MARKER' });
    expect(own.source).toBe('project');
    // A resumed CLI keeps what it was first told, so the change comes with the next message.
    expect(await toldInTurn('two')).toContain('this is your current playbook');
    const unchanged = JSON.parse((await toldInTurn('nothing has changed'))!);
    const lastUser = unchanged.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
    expect(JSON.stringify(lastUser)).not.toContain('this is your current playbook');
    expect((await lonca.api<Playbook>('DELETE', `/playbook?project=${project.id}`)).source).toBe('global');
    const restored = await lonca.api<Playbook>('DELETE', '/playbook');
    expect(restored.source).toBe('template');
    expect(restored.content).toBe(restored.template);
    await expect(lonca.api('PUT', '/playbook', { content: '   ' })).rejects.toThrow(/empty/);
    expect(await toldInTurn('three')).toContain('You answer to the user for the outcome');

    // A new Lead starts on what's current.
    await lonca.api('PUT', '/playbook', { project: project.id, content: 'FOR-THE-NEXT-LEAD' });
    const { lead: fresh } = await newWorkspace();
    const before = mock.requests.length;
    await send(fresh.id, 'hello');
    await lonca.waitForIdle(fresh.id);
    const told = mock.requests.slice(before).find((request) => request.body.includes('You are the Lead'))?.body;
    expect(told).toContain('FOR-THE-NEXT-LEAD');
    expect(told).not.toContain('this is your current playbook');
    await lonca.api('DELETE', `/playbook?project=${project.id}`);
  });
});

describe('a Lead and its agents', () => {
  it('starts agents that work privately in the same checkout, and is woken once when they’ve all finished', async () => {
    const { workspace, lead } = await newWorkspace();
    const before = mock.requests.length;
    await send(lead.id, [
      spawn('Writer', 'SECRET-BRIEF-ONE RUN: echo shared > made-by-writer.txt && echo "token=[$GH_TOKEN] scratch=$LONCA_SCRATCH"', { job: 'implement', model: 'claude-sonnet-5-5' }),
      spawn('Codex reader', 'SECRET-BRIEF-TWO', { model: CODEX_MODEL, effort: 'low' }),
    ].join('\n'));
    await until('both agents', async () => (await agents(workspace)).length === 2);
    await settled(lead);

    const [writer, reader] = await agents(workspace);
    expect(writer).toMatchObject({ title: 'Writer', agent: 'claude', model: 'claude-sonnet-5-5', role: 'agent', work: { job: 'implement' }, lastOutcome: 'completed', unread: true });
    expect(reader).toMatchObject({ title: 'Codex reader', agent: 'codex', model: CODEX_MODEL, effort: 'low', work: { job: 'analyze' }, lastOutcome: 'completed' });

    // What the Lead asked is shown as coming from it.
    const writerItems = await lonca.items(writer.id);
    expect(users(writerItems)[0]).toMatchObject({ from: 'lead' });

    // Agents see the same files.
    expect(fs.readFileSync(`${workspace.path}/made-by-writer.txt`, 'utf8').trim()).toBe('shared');

    // Never a real GitHub token, and a scratch directory of its own.
    const output = tools(writerItems).find((item) => item.kind === 'command')?.output ?? '';
    expect(output).toContain('token=[');
    expect(output).not.toContain('gho_lead_test_token');
    expect(output).toContain(`scratch=/var/tmp/lonca/agent-scratch/${writer.id}`);

    // Told it works for a Lead, with no tools of its own and no sight of the other's brief.
    const requests = mock.requests.slice(before);
    const toWriter = requests.filter((request) => request.body.includes('SECRET-BRIEF-ONE'));
    expect(toWriter.some((request) => request.body.includes('You work for the Lead'))).toBe(true);
    const agentRequests = requests.filter((request) => request.body.includes('You work for the Lead'));
    expect(agentRequests.length).toBeGreaterThan(0);
    for (const request of agentRequests) {
      expect(request.body).not.toContain('mcp__lonca');
      expect(request.body).not.toContain('You are the Lead');
    }
    expect(requests.filter((request) => request.body.includes('SECRET-BRIEF-ONE') && request.body.includes('SECRET-BRIEF-TWO') && request.body.includes('You work for the Lead'))).toEqual([]);

    // One wake that reports them both, marked as not from the user.
    const leadItems = await lonca.items(lead.id);
    const woken = wakes(leadItems);
    expect(woken).toHaveLength(1);
    expect(woken[0].summary).toBe('2 agents finished');
    expect(woken[0].text).toContain('Update from Lonca');
    expect(woken[0].text).toContain('Writer');
    expect(woken[0].text).toContain('Codex reader');
    expect((await lonca.session(lead.id)).unread).toBe(true);

    // It can read what they reported, in a later turn.
    await send(lead.id, tool('read_agent', { id: writer.id }));
    const read = await waitForTool(lead, (item) => item.title === 'Read the report from' && item.agentId === writer.id);
    expect(read.output).toContain('The command finished.');
    expect((await lonca.session(writer.id)).unread).toBe(false);
    await settled(lead);

    await send(lead.id, tool('team_status'));
    const status = await waitForTool(lead, (item) => item.title === 'Checked on the agents');
    expect(status.output).toContain(writer.id);
    expect(status.output).toContain('claude-sonnet-5-5');
    expect(status.output).toContain(CODEX_MODEL);
    await settled(lead);
  });

  it('refuses what it can’t do, in words the Lead can act on', async () => {
    const { lead } = await newWorkspace();
    await send(lead.id, [
      spawn('Bad model', 'x', { model: 'claude-imaginary' }),
      spawn('Bad effort', 'x', { effort: 'ultra-mega' }),
      spawn('Bad job', 'x', { job: 'wander' }),
      tool('read_agent', { id: 'nobody' }),
    ].join('\n'));
    const failures = await until('four refusals', async () => {
      const found = teamTools(await lonca.items(lead.id)).filter((item) => item.status === 'error');
      return found.length === 4 ? found : null;
    });
    const words = failures.map((item) => item.output).join('\n');
    expect(words).toContain('no model called claude-imaginary');
    expect(words).toContain('doesn\'t offer the thinking level ultra-mega');
    expect(words).toContain('job must be one of');
    expect(words).toContain('no agent with that id');
    await settled(lead);
  });

  it('lets one agent at a time change files, and caps how many work at once', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('First writer', 'SLOW write something', { job: 'implement' }));
    await until('the writer to start', async () => (await agents(workspace))[0]?.status === 'running');
    await waitForTool(lead, (item) => item.title === 'Started First writer');
    await lonca.waitForIdle(lead.id);
    await send(lead.id, spawn('Second writer', 'write something else', { job: 'implement' }));
    const refused = await until('the refusal', async () => teamTools(await lonca.items(lead.id)).find((item) => item.status === 'error'));
    expect(refused.output).toContain('already changing files');
    await lonca.waitForIdle(lead.id);

    // Its job can't change while it's writing, or the next writer would be let in alongside it.
    const [writer] = await agents(workspace);
    await send(lead.id, tool('message_agent', { id: writer.id, job: 'analyze', text: 'look instead' }));
    const noChange = await until('the refusal', async () => teamTools(await lonca.items(lead.id)).find((item) => item.output?.includes('still working')));
    expect(noChange.status).toBe('error');
    expect((await lonca.session(writer.id)).work?.job).toBe('implement');
    await lonca.waitForIdle(lead.id);

    await lonca.api('PATCH', '/settings', { leadMaxAgents: 1 });
    await send(lead.id, spawn('Over the cap', 'look at something'));
    const capped = await until('the cap', async () => teamTools(await lonca.items(lead.id)).find((item) => item.output?.includes('most allowed at once')));
    expect(capped.status).toBe('error');
    expect((await agents(workspace)).length).toBe(1);
    await lonca.waitForIdle(lead.id);

    // The cap counts an agent being sent back to work as well as a new one.
    await until('the writer to finish', async () => (await lonca.session(writer.id)).status === 'idle', 60000);
    await settled(lead);
    await send(lead.id, spawn('Second', 'SLOW look at something'));
    await until('the second agent to run', async () => (await agents(workspace))[1]?.status === 'running');
    await waitForTool(lead, (item) => item.title === 'Started Second');
    await lonca.waitForIdle(lead.id);
    await send(lead.id, tool('message_agent', { id: writer.id, text: 'one more thing' }));
    await until('the second refusal', async () => teamTools(await lonca.items(lead.id)).filter((item) => item.output?.includes('most allowed at once')).length === 2);
    await lonca.api('PATCH', '/settings', { leadMaxAgents: 4 });
    await settled(lead);
  });

  it('says so when an agent told not to change files did, whoever it was', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Reader', 'RUN: echo oops > changed-by-reader.txt'));
    await until('the agent', async () => (await agents(workspace)).length === 1);
    await settled(lead);
    const [reader] = await agents(workspace);
    expect(reader.work?.filesChanged).toBe(true);
    expect((await lonca.items(reader.id)).some((item) => item.type === 'notice' && item.text.includes('files changed'))).toBe(true);
    expect(wakes(await lonca.items(lead.id)).at(-1)?.text).toContain('files changed');

    await send(reader.id, 'RUN: echo just looking');
    await settled(lead);
    expect((await lonca.session(reader.id)).work?.filesChanged).toBe(false);

    // Given the job of changing files, it isn't told off for it, and it's told what's changed.
    await send(lead.id, tool('message_agent', { id: reader.id, job: 'implement', text: 'RUN: echo fine > allowed.txt' }));
    await until('its new job', async () => (await lonca.session(reader.id)).work?.job === 'implement');
    await settled(lead);
    expect((await lonca.session(reader.id)).work?.filesChanged).toBeFalsy();
    expect(users(await lonca.items(reader.id)).at(-1)?.text).toContain('your job has changed');
  });

  it('tells the Lead what the user said to an agent, and keeps an agent the user stopped stopped', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Stoppable', 'SLOW take your time'));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    const [agent] = await agents(workspace);
    const wakesBefore = wakes(await lonca.items(lead.id)).length;
    await lonca.api('POST', `/sessions/${agent.id}/interrupt`);
    await until('it to stop', async () => (await lonca.session(agent.id)).status === 'idle');
    expect(await lonca.session(agent.id)).toMatchObject({ held: true, lastOutcome: 'stopped' });
    // Whoever stopped it knows, so this isn't worth a turn of the Lead's.
    expect(wakes(await lonca.items(lead.id)).length).toBe(wakesBefore);

    await send(lead.id, tool('message_agent', { id: agent.id, text: 'carry on regardless' }));
    const held = await waitForTool(lead, (item) => item.title === 'Messaged');
    expect(held.output).toContain('stopped by the user');
    await lonca.waitForIdle(lead.id);
    expect((await lonca.session(agent.id))).toMatchObject({ status: 'idle', held: true });
    expect((await lonca.session(agent.id)).queue).toHaveLength(1);

    await send(lead.id, tool('retry_agent', { id: agent.id }));
    const refused = await waitForTool(lead, (item) => item.title === 'Asked to try again:');
    expect(refused.output).toContain('stopped by the user');
    await lonca.waitForIdle(lead.id);

    // Cancelling what was waiting for it doesn't release it either.
    await lonca.api('DELETE', `/sessions/${agent.id}/queue/${(await lonca.session(agent.id)).queue[0]}`);
    expect(await lonca.session(agent.id)).toMatchObject({ held: true, queue: [] });

    // The user releases it by writing to it.
    await send(agent.id, 'actually, go ahead');
    await settled(lead);
    expect(await lonca.session(agent.id)).toMatchObject({ held: false, lastOutcome: 'completed' });
    const woken = wakes(await lonca.items(lead.id)).at(-1);
    expect(woken?.text).toContain('The user wrote to it directly');
    expect(woken?.text).toContain('actually, go ahead');
  });

  it('doesn’t let a wake release a Lead the user stopped', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Quick', 'SLOW finish while the Lead is stopped'));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    const kept = await send(lead.id, 'SLOW think about it');
    await until('the Lead to run', async () => (await lonca.session(lead.id)).status === 'running');
    const queued = await send(lead.id, 'and then this');
    await lonca.api('POST', `/sessions/${lead.id}/interrupt`);
    await until('it to stop', async () => (await lonca.session(lead.id)).status === 'idle');
    expect((await lonca.session(lead.id)).held).toBe(true);
    expect(kept.id).toBeTruthy();

    await until('the agent to finish', async () => (await agents(workspace))[0]?.status === 'idle', 60000);
    const woken = await until('the wake to wait', async () => {
      const session = await lonca.session(lead.id);
      const items = await lonca.items(lead.id);
      return session.queue.length === 2 ? wakes(items)[0] : null;
    });
    expect(woken.queued).toBe(true);
    expect((await lonca.session(lead.id))).toMatchObject({ held: true, status: 'idle' });

    await lonca.api('POST', `/sessions/${lead.id}/queue/flush`);
    await settled(lead);
    expect((await lonca.items(lead.id)).find((item) => item.id === queued.id)).toMatchObject({ queued: false });
    expect(wakes(await lonca.items(lead.id))[0].queued).toBe(false);
  });

  it('holds a stopped Lead even with nothing queued, until the user writes to it', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Outlasts the Lead', 'SLOW finish while the Lead is stopped'));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    await send(lead.id, 'SLOW think about it');
    await until('the Lead to run', async () => (await lonca.session(lead.id)).status === 'running');
    await lonca.api('POST', `/sessions/${lead.id}/interrupt`);
    await until('it to stop', async () => (await lonca.session(lead.id)).status === 'idle');
    expect((await lonca.session(lead.id)).held).toBe(true);

    await until('the wake to wait', async () => (await lonca.session(lead.id)).queue.length === 1, 60000);
    expect(await lonca.session(lead.id)).toMatchObject({ status: 'idle', held: true });

    await send(lead.id, 'carry on');
    await settled(lead);
    expect(await lonca.session(lead.id)).toMatchObject({ held: false, lastOutcome: 'completed' });
    expect(wakes(await lonca.items(lead.id))[0].queued).toBe(false);
    expect(users(await lonca.items(lead.id)).at(-1)?.text).toBe('carry on');
  });
});

describe('queued jobs and Lead stops', () => {
  it.each(['message', 'retry'])('keeps the current job after cancelling its queued message and resuming with %s', async (method) => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Changing jobs', 'ORIGINAL-WRITING-REQUEST', { job: 'implement' }));
    await until('the agent', async () => (await agents(workspace)).length === 1);
    await settled(lead);
    const [agent] = await agents(workspace);
    expect(agent.resumeId).toBeTruthy();

    if (method === 'retry') {
      // A retry repeats the last request, including any old job-change instructions it carried.
      await send(lead.id, tool('message_agent', { id: agent.id, job: 'review', text: 'EARLIER-REVIEW-REQUEST' }));
      await settled(lead);
      expect(users(await lonca.items(agent.id)).at(-1)?.text).toContain('Your job is to review.');
    }
    const job = method === 'message' ? 'review' : 'implement';
    await lonca.api('POST', `/sessions/${agent.id}/interrupt`);
    await send(lead.id, tool('message_agent', { id: agent.id, job, text: 'CANCELLED-JOB-CHANGE' }));
    await settled(lead);
    const changed = await lonca.session(agent.id);
    expect(changed).toMatchObject({ work: { job }, held: true, userStopped: true });
    expect(changed.queue).toHaveLength(1);
    await lonca.api('DELETE', `/sessions/${agent.id}/queue/${changed.queue[0]}`);
    await lonca.kill();
    await lonca.start();
    expect(await lonca.session(agent.id)).toMatchObject({ work: { job }, held: true, queue: [] });

    const before = mock.requests.length;
    if (method === 'message') await send(agent.id, 'RESUME-AFTER-CANCEL');
    else await lonca.api('POST', `/sessions/${agent.id}/retry`);
    await settled(lead);
    expect(await lonca.session(agent.id)).toMatchObject({ work: { job }, lastOutcome: 'completed', held: false, resumeId: agent.resumeId });

    // Inspect the new message sent by the real Claude CLI, not the system prompt it kept from turn one.
    const request = mock.requests.slice(before).find((entry) => entry.path.endsWith('/messages') && entry.body.includes('You work for the Lead'));
    expect(request).toBeDefined();
    const messages = JSON.parse(request!.body).messages as { role: string; content: string | { type: string; text?: string }[] }[];
    const content = messages.filter((message) => message.role === 'user').at(-1)?.content;
    const prompt = typeof content === 'string' ? content : content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    expect(prompt).toContain(method === 'message' ? 'RESUME-AFTER-CANCEL' : 'EARLIER-REVIEW-REQUEST');
    expect(prompt).not.toContain('CANCELLED-JOB-CHANGE');
    expect(prompt?.match(/Your job is to (analyze|implement|review)\./g)?.at(-1)).toBe(`Your job is to ${job}.`);
  });

  it('keeps the old job until earlier queued messages have finished', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Queued writer', 'SLOW start writing', { job: 'implement' }));
    await until('the writer to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    const [writer] = await agents(workspace);
    const queued = await send(writer.id, 'RUN: echo queued-write > queued-write.txt');
    await lonca.api('POST', `/sessions/${writer.id}/interrupt`);
    await until('the writer to stop', async () => (await lonca.session(writer.id)).status === 'idle');

    await send(lead.id, tool('message_agent', { id: writer.id, job: 'review', text: 'Review only; do not change files.' }));
    const refused = await waitForTool(lead, (item) => item.title === 'Messaged');
    expect(refused.status).toBe('error');
    expect(refused.output).toContain('messages waiting');
    expect(await lonca.session(writer.id)).toMatchObject({ work: { job: 'implement' }, held: true, queue: [queued.id] });
    await lonca.waitForIdle(lead.id);

    await send(lead.id, spawn('Other writer', 'SLOW keep writing', { job: 'implement' }));
    await until('the other writer to run', async () => (await agents(workspace))[1]?.status === 'running');
    await expect(lonca.api('POST', `/sessions/${writer.id}/queue/flush`)).rejects.toThrow(/only one agent/);
    expect(sandboxExec(workspace.sandboxName, `test ! -f '${workspace.path}/queued-write.txt'`).code).toBe(0);
    await lonca.api('POST', `/workspaces/${workspace.id}/agents/stop`);
    await settled(lead);
  });

  it.each(['message_agent', 'retry_agent'])('lets the Lead resume its own stopped agent with %s after a restart', async (method) => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Lead stopped writer', 'SLOW start writing', { job: 'implement' }));
    await until('the writer to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    const [writer] = await agents(workspace);
    const queued = await send(writer.id, 'RUN: echo resumed > resumed-by-lead.txt');
    await send(lead.id, tool('stop_agent', { id: writer.id }));
    await waitForTool(lead, (item) => item.title === 'Stopped');
    await until('the writer to stop', async () => (await lonca.session(writer.id)).status === 'idle');
    await lonca.waitForIdle(lead.id);
    expect(await lonca.session(writer.id)).toMatchObject({ held: true, queue: [queued.id], lastOutcome: 'stopped' });
    await lonca.kill();
    await lonca.start();

    // Releasing the Lead's hold still has to obey the one-writer rule.
    await send(lead.id, spawn('Busy writer', 'SLOW keep writing', { job: 'implement' }));
    await until('the other writer to run', async () => (await agents(workspace))[1]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    const args = { id: writer.id, ...(method === 'message_agent' ? { text: 'Carry on with the queued work.' } : {}) };
    await send(lead.id, tool(method, args));
    const blocked = await waitForTool(lead, (item) => item.name.includes(method));
    expect(blocked.status).toBe('error');
    expect(blocked.output).toContain('only one agent');
    expect(await lonca.session(writer.id)).toMatchObject({ held: true, queue: [queued.id] });
    await lonca.waitForIdle(lead.id);
    const other = (await agents(workspace))[1];
    await lonca.api('POST', `/sessions/${other.id}/interrupt`);
    await until('the other writer to stop', async () => (await lonca.session(other.id)).status === 'idle');

    await send(lead.id, tool(method, args));
    await waitForTool(lead, (item) => item.name.includes(method) && item.status === 'done');
    await settled(lead);
    expect(await lonca.session(writer.id)).toMatchObject({ held: false, queue: [], lastOutcome: 'completed' });
    expect(sandboxExec(workspace.sandboxName, `cat '${workspace.path}/resumed-by-lead.txt'`).output).toBe('resumed');
  });
});

describe('an agent that fails', () => {
  it('tells the Lead why, in either view of it', async () => {
    const { workspace, lead } = await newWorkspace();
    mock.refuseCodex = true;
    try {
      await send(lead.id, spawn('Failing', 'look at something', { model: CODEX_MODEL }));
      await until('it to fail', async () => (await agents(workspace))[0]?.lastOutcome === 'failed', 100000);
      await settled(lead);
    } finally {
      mock.refuseCodex = false;
    }
    const [agent] = await agents(workspace);
    for (const [args, expected] of [
      [{ id: agent.id }, 'It didn\'t write anything.'],
      [{ id: agent.id, view: 'activity' }, 'It hasn\'t used any tools'],
    ] as const) {
      const reads = async () => teamTools(await lonca.items(lead.id)).filter((item) => item.title.startsWith('Read'));
      const before = (await reads()).length;
      await send(lead.id, tool('read_agent', args));
      const read = await until('the read', async () => {
        const all = await reads();
        return all.length > before && all.at(-1)!.status !== 'running' ? all.at(-1) : null;
      });
      expect(read.output).toContain('failed');
      expect(read.output).toContain('unexpected status 401');
      expect(read.output).toContain(expected);
      await settled(lead);
    }
  });
});

describe('one writer at a time, from the buttons', () => {
  it('refuses Try now and Send now while another writes, and warns about a message typed to one', async () => {
    const { workspace, lead } = await newWorkspace();
    mock.limited.add('claude-haiku-5-5');
    try {
      await send(lead.id, spawn('Old writer', 'write something', { model: 'claude-haiku-5-5', job: 'implement' }));
      await until('the limit', async () => (await agents(workspace))[0]?.lastOutcome === 'limit');
      await settled(lead);
    } finally {
      mock.limited.delete('claude-haiku-5-5');
    }
    const [oldWriter] = await agents(workspace);
    // Something for Send now to send.
    await send(lead.id, tool('message_agent', { id: oldWriter.id, text: 'and this, when you can' }));
    await waitForTool(lead, (item) => item.title === 'Messaged');
    await settled(lead);
    expect((await lonca.session(oldWriter.id)).queue.length).toBe(1);

    // Taking over is allowed, because the first isn't working.
    await send(lead.id, spawn('New writer', 'SLOW write something else', { job: 'implement' }));
    await until('its replacement', async () => (await agents(workspace))[1]?.status === 'running');
    await expect(lonca.api('POST', `/sessions/${oldWriter.id}/retry`)).rejects.toThrow(/409.*New writer is changing files/);
    await expect(lonca.api('POST', `/sessions/${oldWriter.id}/queue/flush`)).rejects.toThrow(/409.*New writer is changing files/);
    expect(await lonca.session(oldWriter.id)).toMatchObject({ status: 'idle', lastOutcome: 'limit', held: true, queue: [expect.any(String)] });
    await settled(lead);

    // With nobody else writing it's let through.
    await lonca.api('POST', `/sessions/${oldWriter.id}/retry`);
    await until('it to finish', async () => (await lonca.session(oldWriter.id)).lastOutcome === 'completed', 60000);
    await settled(lead);
    const quiet = await lonca.items(oldWriter.id);
    expect(quiet.some((item) => item.type === 'notice' && item.text.includes('changing files'))).toBe(false);

    await send(lead.id, spawn('Third writer', 'SLOW write a third thing', { job: 'implement' }));
    await until('the third', async () => (await agents(workspace))[2]?.status === 'running');
    await send(oldWriter.id, 'change this too');
    const warned = (await lonca.items(oldWriter.id)).find((item) => item.type === 'notice' && item.level === 'warning');
    expect(warned).toMatchObject({ text: expect.stringContaining('Third writer is changing files at the same time') });
    await settled(lead);
  });

  it('holds a button to the limit on how many work at once', async () => {
    const { workspace, lead } = await newWorkspace();
    mock.limited.add('claude-haiku-5-5');
    try {
      await send(lead.id, spawn('Stopped', 'look at something', { model: 'claude-haiku-5-5' }));
      await until('the limit', async () => (await agents(workspace))[0]?.lastOutcome === 'limit');
      await settled(lead);
    } finally {
      mock.limited.delete('claude-haiku-5-5');
    }
    const [stopped] = await agents(workspace);
    await send(lead.id, spawn('Busy', 'SLOW look at something else'));
    await until('the other', async () => (await agents(workspace))[1]?.status === 'running');
    await lonca.api('PATCH', '/settings', { leadMaxAgents: 1 });
    try {
      await expect(lonca.api('POST', `/sessions/${stopped.id}/retry`)).rejects.toThrow(/409.*most allowed at once/);
    } finally {
      await lonca.api('PATCH', '/settings', { leadMaxAgents: 4 });
    }
    await settled(lead);
  });
});

describe('a project’s own key', () => {
  it('reaches a running VM when it changes, with no turn to carry it', async () => {
    const { workspace } = await newWorkspace();
    const { env } = (await state()).projects.find((entry) => entry.id === project.id)!.settings;
    const inVm = () => sandboxExec(workspace.sandboxName, 'cat ~/.codex/auth.json').output;
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { env: { ...env, OPENAI_API_KEY: 'sk-changed' } } });
    try {
      await until('the new key', () => inVm().includes('sk-changed'), 20000);
    } finally {
      await lonca.api('PATCH', `/projects/${project.id}`, { settings: { env } });
    }
    await until('the key before', () => inVm().includes('sk-mock'), 20000);
    // Other settings leave it alone.
    const before = sandboxExec(workspace.sandboxName, 'stat -c %Y%i ~/.codex/auth.json').output;
    await lonca.api('PATCH', `/projects/${project.id}`, { name: 'still-the-same-key' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sandboxExec(workspace.sandboxName, 'stat -c %Y%i ~/.codex/auth.json').output).toBe(before);
  });

  it('is what the real CLIs send, rather than the placeholder or a sign-in', async () => {
    const { workspace } = await newWorkspace();
    await lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-oat01-a-sign-in-that-should-lose' });
    try {
      // Codex's usual provider, at the mock's address. A config that isn't Lonca's stays as it is.
      sandboxExec(workspace.sandboxName, `cat > ~/.codex/config.toml <<EOF
cli_auth_credentials_store = "file"
openai_base_url = "http://host.docker.internal:${mock.port}/v1"
EOF`);
      // What's there from booting isn't what it goes by: each turn sets it again.
      sandboxExec(workspace.sandboxName, `echo '{"OPENAI_API_KEY":"sk-out-of-date"}' > ~/.codex/auth.json`);
      const sent = async (agent: string, model: string, marker: string) => {
        const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent, model, effort: 'low' });
        await send(session.id, marker);
        await lonca.waitForIdle(session.id);
        return mock.requests.findLast((request) => request.body.includes(marker))?.auth;
      };
      expect(await sent('codex', CODEX_MODEL, 'WHOSE-KEY-CODEX')).toBe('Bearer sk-mock');
      expect(await sent('claude', 'claude-sonnet-5-5', 'WHOSE-KEY-CLAUDE')).toBe('sk-mock');
    } finally {
      await lonca.api('POST', '/agents/claude/logout');
    }
  });
});

describe('usage limits', () => {
  it('wakes the Lead when an agent hits one, and the agent can pick up afterwards', async () => {
    const { workspace, lead } = await newWorkspace();
    mock.limited.add('claude-haiku-5-5');
    try {
      await send(lead.id, spawn('Limited', 'THE-ORIGINAL-REQUEST', { model: 'claude-haiku-5-5' }));
      await until('the agent to stop', async () => (await agents(workspace))[0]?.lastOutcome === 'limit');
      await settled(lead);
      const [agent] = await agents(workspace);
      expect(agent.held).toBe(true);
      expect((await lonca.items(agent.id)).some((item) => item.type === 'notice' && item.code === 'limit')).toBe(true);
      const woken = wakes(await lonca.items(lead.id)).at(-1);
      expect(woken?.summary).toContain('usage limit');
      expect(woken?.text).toContain('retry_agent');
    } finally {
      mock.limited.delete('claude-haiku-5-5');
    }
    const [agent] = await agents(workspace);
    await send(lead.id, tool('retry_agent', { id: agent.id }));
    await waitForTool(lead, (item) => item.title === 'Asked to try again:');
    await settled(lead);
    expect(await lonca.session(agent.id)).toMatchObject({ lastOutcome: 'completed', held: false });
    const retried = users(await lonca.items(agent.id)).at(-1);
    expect(retried?.text).toContain('Continue where you left off');
    expect(retried?.text).toContain('THE-ORIGINAL-REQUEST');
  });

  it('pauses a Lead at its own limit, holds what comes in, and tells the difference from Codex', async () => {
    const { lead } = await newWorkspace({ agent: 'codex', model: CODEX_MODEL, effort: 'low' });
    await send(lead.id, 'first');
    await lonca.waitForIdle(lead.id);
    mock.limited.add(CODEX_MODEL);
    try {
      await send(lead.id, 'second');
      await until('the limit', async () => (await lonca.session(lead.id)).lastOutcome === 'limit');
      expect(await lonca.session(lead.id)).toMatchObject({ held: true, unread: true, status: 'idle' });
      await expect(lonca.api('POST', `/workspaces/${lead.workspaceId}/lead/switch`, { agent: 'codex', model: CODEX_MODEL, effort: 'nonsense' })).rejects.toThrow(/isn’t available/);
    } finally {
      mock.limited.delete(CODEX_MODEL);
    }
    await lonca.api('POST', `/sessions/${lead.id}/retry`);
    await lonca.waitForIdle(lead.id);
    expect(await lonca.session(lead.id)).toMatchObject({ lastOutcome: 'completed', held: false });
  });

  it('moves a Lead to another model only when it can’t run, leaving a record', async () => {
    const { workspace, lead } = await newWorkspace({ model: 'claude-sonnet-5-5' });
    await send(lead.id, 'first');
    await lonca.waitForIdle(lead.id);
    const choice = { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' };
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/lead/switch`, choice)).rejects.toThrow(/while it can still run/);
    const { workspace: unlocked } = await newWorkspace();
    await expect(lonca.api('POST', `/workspaces/${unlocked.id}/lead/switch`, choice)).rejects.toThrow(/changed from its tab/);

    mock.limited.add('claude-sonnet-5-5');
    try {
      await send(lead.id, 'second');
      await until('the limit', async () => (await lonca.session(lead.id)).lastOutcome === 'limit');
      // The same CLI carries on the same conversation.
      const same = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/lead/switch`, choice);
      expect(same.id).toBe(lead.id);
      await lonca.waitForIdle(lead.id);
      expect(mock.requests.some((request) => request.model === 'claude-opus-5-5' && request.body.includes('Continue where you left off'))).toBe(true);
      expect((await lonca.items(lead.id)).some((item) => item.type === 'notice' && item.text.includes('moved from Sonnet 5.5 to Opus 5.5'))).toBe(true);
      expect((await lonca.workspace(workspace.id)).lead).toMatchObject({ model: 'claude-opus-5-5' });
    } finally {
      mock.limited.delete('claude-sonnet-5-5');
    }

    // Another CLI can't read this one's conversation, so a new Lead takes over.
    mock.limited.add('claude-opus-5-5');
    try {
      await send(lead.id, 'third');
      await until('the limit', async () => (await lonca.session(lead.id)).lastOutcome === 'limit');
      const next = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/lead/switch`, { agent: 'codex', model: CODEX_MODEL, effort: 'low' });
      expect(next.id).not.toBe(lead.id);
      expect(next).toMatchObject({ role: 'lead', agent: 'codex', model: CODEX_MODEL });
      expect((await lonca.session(lead.id)).closedAt).toBeGreaterThan(0);
      await lonca.waitForIdle(next.id);
      const told = users(await lonca.items(next.id))[0];
      expect(told.context).toContain('taking over');
      // What the user asked for carries over, or the new Lead wouldn't know what the work is.
      expect(told.context).toContain('third');
      expect(told.context).toContain('first');
    } finally {
      mock.limited.delete('claude-opus-5-5');
    }
  });
});

describe('closing a Lead', () => {
  it('keeps what the user had queued for it, for the next Lead', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, 'SLOW the original request');
    await until('the Lead to run', async () => (await lonca.session(lead.id)).status === 'running');
    const waiting = await send(lead.id, 'and this follow-up');
    await lonca.api('POST', `/sessions/${lead.id}/close`, {});
    expect((await lonca.items(lead.id)).find((item) => item.id === waiting.id)).toMatchObject({ queued: false });
    const next = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/lead`);
    await send(next.id, 'what was I doing?');
    await lonca.waitForIdle(next.id);
    const first = users(await lonca.items(next.id))[0];
    expect(first.context).toContain('the original request');
    expect(first.context).toContain('and this follow-up');
  });

  it('keeps its conversation and its agents, and a new Lead takes over on the same model', async () => {
    const { workspace, lead } = await newWorkspace({ model: 'claude-sonnet-5-5' });
    await send(lead.id, spawn('Survivor', 'SLOW keep working after the Lead has gone'));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    await lonca.api('POST', `/sessions/${lead.id}/close`, { stopAgents: false });
    expect((await lonca.session(lead.id)).closedAt).toBeGreaterThan(0);
    expect((await lonca.items(lead.id)).length).toBeGreaterThan(0);
    await expect(send(lead.id, 'are you there?')).rejects.toThrow(/was closed/);
    expect((await agents(workspace))[0].status).toBe('running');

    await until('the agent to finish', async () => (await agents(workspace))[0].status === 'idle', 60000);
    expect((await agents(workspace))[0].work?.unreported).toBe(true);

    const next = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/lead`);
    expect(next).toMatchObject({ role: 'lead', model: 'claude-sonnet-5-5' });
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/lead`)).rejects.toThrow(/already has a Lead/);
    await send(next.id, 'what do I have?');
    await settled(next);
    const first = users(await lonca.items(next.id))[0];
    expect(first.context).toContain('taking over');
    expect(first.context).toContain('Survivor');
    expect((await lonca.items(next.id)).some((item) => item.type === 'notice' && item.text.includes('What this Lead was told'))).toBe(true);
    expect((await agents(workspace))[0].work?.unreported).toBe(false);
    expect(mock.requests.some((request) => request.body.includes('You\'re taking over as Lead'))).toBe(true);
  });

  it('can stop the agents along with it, and deletes a Lead that never said anything', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Stopped with it', 'SLOW keep going'));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    await lonca.api('POST', `/sessions/${lead.id}/close`, { stopAgents: true });
    await until('the agent to stop', async () => (await agents(workspace))[0].status === 'idle');
    expect((await agents(workspace))[0]).toMatchObject({ held: true, lastOutcome: 'stopped' });

    const unused = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/lead`);
    await lonca.api('POST', `/sessions/${unused.id}/close`, {});
    expect((await state()).sessions.some((session) => session.id === unused.id)).toBe(false);
  });

  it('doesn’t delete a Lead’s conversation by mistake', async () => {
    const { lead } = await newWorkspace();
    await send(lead.id, 'something worth keeping');
    await lonca.waitForIdle(lead.id);
    await expect(lonca.api('DELETE', `/sessions/${lead.id}`)).rejects.toThrow(/Close a Lead/);
  });
});

describe('restarts', () => {
  it('does not repeat completed queued work when a retry reply cannot be saved', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Retry once', 'SLOW wait for follow-up', { job: 'implement' }));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    const [agent] = await agents(workspace);
    const queued = await send(agent.id, 'RUN: echo retried >> retry-count.txt');
    await send(lead.id, tool('stop_agent', { id: agent.id }));
    await waitForTool(lead, (item) => item.title === 'Stopped');
    await until('the agent to stop', async () => (await lonca.session(agent.id)).status === 'idle');
    await lonca.waitForIdle(lead.id);
    expect(await lonca.session(agent.id)).toMatchObject({ held: true, queue: [queued.id] });

    const before = mock.requests.length;
    await send(lead.id, `SLOW ${tool('retry_agent', { id: agent.id })}`);
    await until('the retry model request', () => mock.requests.slice(before).some((request) => request.body.includes('SLOW TOOL: retry_agent')));
    const run = (await lonca.session(lead.id)).activeRunId;
    const replies = `/var/tmp/lonca/agent-runs/${run}/replies`;
    // Only the tool reply fails to save. The queue release and its agent's work still succeed.
    expect(sandboxExec(workspace.sandboxName, `chmod a-w '${replies}'`).code).toBe(0);
    const logStart = lonca.log.length;
    try {
      await until('the queued work to finish', async () => (await lonca.session(agent.id)).lastOutcome === 'completed');
      await until('the reply write to fail', () => lonca.log.slice(logStart).includes('could not answer a tool call'));
      expect(sandboxExec(workspace.sandboxName, `cat '${workspace.path}/retry-count.txt'`).output).toBe('retried');
      const accepted = users(await lonca.items(agent.id)).map((item) => item.id);
      await lonca.kill();
      expect(sandboxExec(workspace.sandboxName, `chmod u+w '${replies}'`).code).toBe(0);
      await lonca.start();
      const reply = await waitForTool(lead, (item) => item.title === 'Asked to try again:');
      expect(reply.status).toBe('done');
      await settled(lead);
      expect(sandboxExec(workspace.sandboxName, `cat '${workspace.path}/retry-count.txt'`).output).toBe('retried');
      expect(users(await lonca.items(agent.id)).map((item) => item.id)).toEqual(accepted);
    } finally {
      sandboxExec(workspace.sandboxName, `chmod u+w '${replies}'`);
    }
  });

  it('handles a tool call the Lead made while the server was down', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, `SLOW ${spawn('Born during downtime', 'hello')}`);
    await until('the Lead to run', async () => (await lonca.session(lead.id)).status === 'running');
    await until('the model request', async () => mock.requests.at(-1)?.body.includes('Born during downtime'));
    await lonca.kill();
    await lonca.start();
    await until('the agent', async () => (await agents(workspace)).length === 1, 120000);
    await settled(lead);
    expect(await agents(workspace)).toHaveLength(1);
    expect(tools(await lonca.items(lead.id)).find((item) => item.kind === 'team')?.status).toBe('done');
  });

  it('doesn’t start an agent twice when the server dies around handling a call', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Only once', 'SLOW hello'));
    await until('the agent', async () => (await agents(workspace)).length === 1);
    await lonca.kill();
    await lonca.start();
    await settled(lead);
    const found = await agents(workspace);
    expect(found).toHaveLength(1);
    expect(users(await lonca.items(found[0].id)).filter((item) => item.from === 'lead')).toHaveLength(1);
    // If it died before the agent's CLI started, the Lead hears that and can try again.
    expect(wakes(await lonca.items(lead.id)).at(-1)?.text).toContain('Only once');
  });

  it('wakes the Lead for an agent that finished while the server was down', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('Finishes alone', 'SLOW finish while nobody is watching'));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    await lonca.kill();
    await new Promise((resolve) => setTimeout(resolve, 14000));
    await lonca.start();
    await settled(lead);
    expect(wakes(await lonca.items(lead.id)).at(-1)?.summary).toBe('Finishes alone finished');
  });
});

describe('a Lead left unattended', () => {
  it('pauses after too many turns without the user, until it’s let continue', async () => {
    const { workspace, lead } = await newWorkspace();
    await send(lead.id, spawn('First of many', 'SLOW take a while'));
    await until('the agent to run', async () => (await agents(workspace))[0]?.status === 'running');
    await lonca.waitForIdle(lead.id);
    // As if this were the last of a long run of turns, which would take too long to run through.
    await lonca.kill();
    const file = `${lonca.home}/state.json`;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.sessions.find((session: Session) => session.id === lead.id).autonomousTurns = 30;
    fs.writeFileSync(file, JSON.stringify(saved));
    await lonca.start();

    await until('the Lead to pause', async () => (await lonca.session(lead.id)).held, 60000);
    expect(await lonca.session(lead.id)).toMatchObject({ status: 'idle', unread: true });
    expect((await lonca.session(lead.id)).queue).toHaveLength(1);
    expect((await lonca.items(lead.id)).some((item) => item.type === 'notice' && item.text.includes('turns without a word from you'))).toBe(true);

    await lonca.api('POST', `/sessions/${lead.id}/queue/flush`);
    await settled(lead);
    expect(await lonca.session(lead.id)).toMatchObject({ held: false, autonomousTurns: 1, lastOutcome: 'completed' });
  });
});

describe('a Lead on Codex', () => {
  it('uses the same tools and carries on the same conversation', async () => {
    const { workspace, lead } = await newWorkspace({ agent: 'codex', model: CODEX_MODEL, effort: 'low' });
    await send(lead.id, spawn('From Codex', 'RUN: echo hello from the agent'));
    await until('the agent', async () => (await agents(workspace)).length === 1);
    const started = await waitForTool(lead, (item) => item.kind === 'team');
    expect(started.status).toBe('done');
    await settled(lead);
    const resumeId = (await lonca.session(lead.id)).resumeId;
    expect(resumeId).toBeTruthy();
    expect(wakes(await lonca.items(lead.id))).toHaveLength(1);
    expect((await lonca.session(lead.id)).resumeId).toBe(resumeId);
    const [agent] = await agents(workspace);
    await send(lead.id, tool('read_agent', { id: agent.id }));
    const read = await waitForTool(lead, (item) => item.agentId === agent.id);
    expect(read.output).toContain('The command finished.');
    await settled(lead);
  });
});
