import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, ChatItem, Project, Session, SlackStatus, UserItem, Workspace } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, sandboxExec, until } from '../support/harness.ts';
import { type FakeSlack, OWNER, TOKENS, startFakeSlack } from '../support/fake-slack.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

// A real Lonca, with a Lead on the real Claude CLI in a workspace, and stand-ins for the model and
// for Slack. What the Lead writes when it needs the user goes to their DM, and what they write
// back in Slack reaches it, through restarts on either side.

const lonca = new Lonca({ port: 48467, instance: 'slack-test', firstWorkspacePort: 58700 });
const FROM_SLACK = 'The user sent this from Slack and will read your reply there, possibly on a phone.';
let mock: MockLlm;
let slack: FakeSlack;
let fixture: string;
let project: Project;
let workspace: Workspace;
let lead: Session;
let thread: string;

const state = () => lonca.api<AppState>('GET', '/state');
const send = (id: string, text: string) => lonca.api<UserItem>('POST', `/sessions/${id}/messages`, { text, attachments: [] });
const fromSlack = (items: ChatItem[]) => items.filter((item): item is UserItem => item.type === 'user' && item.via === 'slack');
const replies = () => slack.thread(thread).filter((message) => message.bot_id).map((message) => slack.markdown(message));
// The model's stand-in repeats the start of a message, which for one from Slack is the note ahead of it.
const answersFromSlack = () => replies().filter((reply) => reply.includes(`You said: ${FROM_SLACK.slice(0, 40)}`)).length;
const work = (seconds: number) => `RUN: python3 -c "import time; time.sleep(${seconds})"`;
/** The user messages of every turn's requests to the model, as the CLI sent them. */
const sentToModel = () => mock.requests.filter((request) => request.path.endsWith('/messages')).flatMap((request) => {
  const body = JSON.parse(request.body) as { messages?: { role: string; content: unknown }[] };
  return (body.messages ?? []).filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content));
});

beforeAll(async () => {
  mock = await startMockLlm();
  slack = await startFakeSlack();
  fixture = makeFixtureRepo();
  // A post whose answer was lost is looked for this long after, rather than a minute and a half.
  lonca.env = { LONCA_SLACK_API_URL: slack.url, LONCA_SLACK_SETTLE_SECONDS: '2' };
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', env: {
    ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock',
  } } });
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  workspace = await lonca.waitForWorkspace(created.workspace.id);
  lead = created.session;
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  await slack?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('a Lead in Slack', () => {
  it('pairs with the user who DMs the code', async () => {
    const saved = await lonca.api<SlackStatus>('PUT', '/slack', { botToken: TOKENS.bot, appToken: TOKENS.app });
    expect(saved).toMatchObject({ team: 'Fake Team', pairing: { code: expect.any(String) } });
    await until('Slack to connect', async () => (await state()).slack.connection === 'connected');
    expect((await state()).secrets).toMatchObject({ slackBotToken: expect.stringMatching(/^••••/), slackAppToken: expect.stringMatching(/^••••/) });
    slack.say(OWNER, saved.pairing!.code);
    await until('pairing', async () => (await state()).slack.owner?.user === OWNER);
  });

  it('posts the Lead’s reply in its workspace’s thread when it finishes', async () => {
    await send(lead.id, 'FIRST-FROM-LONCA');
    await lonca.waitForIdle(lead.id);
    thread = await until('the thread', async () => (await lonca.workspace(workspace.id)).slack?.thread);
    await until('the reply', () => replies().some((reply) => reply.includes('You said: FIRST-FROM-LONCA')));
    expect(replies()[0]).toBe(`**${workspace.name}** in ${project.name}\nFIRST-FROM-LONCA`);
  });

  it('passes the user’s reply in Slack to the Lead, saying where it came from, and posts its answer', async () => {
    const { ts } = slack.say(OWNER, 'SLACK-REPLY &amp; MORE', { thread });
    const item = await until('the message', async () => fromSlack(await lonca.items(lead.id)).find((entry) => entry.text === 'SLACK-REPLY & MORE'));
    expect(item.context).toBe(FROM_SLACK);
    await until('the answer in Slack', () => replies().some((reply) => reply.includes(`You said: ${FROM_SLACK.slice(0, 40)}`)));
    expect(sentToModel().some((content) => content.includes(FROM_SLACK) && content.includes('SLACK-REPLY & MORE'))).toBe(true);
    expect(slack.messages().find((message) => message.ts === ts)?.reactions).toEqual([{ name: 'eyes', users: ['U0BOT'] }]);
  });

  it('gives a working Lead the message at its next step, with its note', async () => {
    await send(lead.id, work(8));
    await until('the command to start', async () => (await lonca.items(lead.id)).some((entry) => entry.type === 'tool' && entry.status === 'running'));
    slack.say(OWNER, 'MID-TURN-FROM-SLACK', { thread });
    const items = await lonca.waitForIdle(lead.id);
    expect(fromSlack(items).find((entry) => entry.text === 'MID-TURN-FROM-SLACK')).toMatchObject({ queued: false, midTurn: true });
    // Read in the turn under way, as a message of its own with the note ahead of it.
    expect(sentToModel().some((content) => content.includes(`${FROM_SLACK}\\n\\nMID-TURN-FROM-SLACK`))).toBe(true);
  });

  it('wakes a stopped workspace for a message from Slack', async () => {
    await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
    await lonca.waitForWorkspace(workspace.id, 'stopped');
    const answered = answersFromSlack();
    slack.say(OWNER, 'WAKE-UP', { thread });
    await lonca.waitForWorkspace(workspace.id, 'ready');
    await until('the message', async () => fromSlack(await lonca.items(lead.id)).some((entry) => entry.text === 'WAKE-UP'));
    await until('the answer in Slack', () => answersFromSlack() > answered);
  });

  it('passes on what was written while Lonca was down, once', async () => {
    await lonca.waitForIdle(lead.id);
    const answered = answersFromSlack();
    await lonca.kill();
    slack.say(OWNER, 'WHILE-LONCA-WAS-DOWN', { thread });
    await lonca.start();
    await until('the message', async () => fromSlack(await lonca.items(lead.id)).some((entry) => entry.text === 'WHILE-LONCA-WAS-DOWN'));
    await lonca.waitForIdle(lead.id);
    await until('the answer in Slack', () => answersFromSlack() === answered + 1);
    // And again, which finds nothing new.
    await lonca.kill();
    await lonca.start();
    await until('Slack to connect', async () => (await state()).slack.connection === 'connected');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(fromSlack(await lonca.items(lead.id)).filter((entry) => entry.text === 'WHILE-LONCA-WAS-DOWN')).toHaveLength(1);
    expect(answersFromSlack()).toBe(answered + 1);
  });

  it('keeps a reply through Slack being down and Lonca stopping, and posts it once', async () => {
    slack.fail('chat.postMessage', ...Array.from({ length: 1000 }, () => ({ status: 503, error: 'service_unavailable' })));
    await send(lead.id, 'WHILE-SLACK-WAS-DOWN');
    await lonca.waitForIdle(lead.id);
    const saved = () => JSON.parse(fs.readFileSync(path.join(lonca.home, 'state.json'), 'utf8')) as { slack?: { outbox?: { text?: string }[] } };
    await until('the post to be saved, waiting', () => saved().slack?.outbox?.some((post) => post.text?.includes('WHILE-SLACK-WAS-DOWN')));
    await lonca.kill();
    slack.failures.clear();
    await lonca.start();
    await until('the reply', () => replies().some((reply) => reply.includes('WHILE-SLACK-WAS-DOWN')));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(replies().filter((reply) => reply.includes('WHILE-SLACK-WAS-DOWN'))).toHaveLength(1);
  });

  it('only ever used the user’s DM, and never let a token into the workspace', async () => {
    expect(slack.postsOutsideDms()).toEqual([]);
    expect(slack.calls.every((call) => !call.params.channel || call.params.channel === slack.dm())).toBe(true);
    expect(sandboxExec(workspace.sandboxName, 'env').output).not.toMatch(/xoxb-|xapp-/);
    const files = sandboxExec(workspace.sandboxName, `grep -rlF -e '${TOKENS.bot}' -e '${TOKENS.app}' "$HOME" /tmp /var/tmp /etc '${workspace.path}' 2>/dev/null | head -5; true`);
    expect(files.output).toBe('');
    expect(fs.readFileSync(path.join(lonca.home, 'state.json'), 'utf8')).not.toMatch(/xoxb-|xapp-/);
    expect(lonca.log).not.toMatch(/xoxb-|xapp-/);
  });

  it('forgets the tokens, the owner and the threads on disconnect', async () => {
    await lonca.api('DELETE', '/slack');
    expect((await state()).slack).toEqual({ connection: 'off' });
    expect((await lonca.workspace(workspace.id)).slack).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(lonca.home, 'secrets.json'), 'utf8'))).not.toHaveProperty('slackBotToken');
  });
});
