// Slack through the real store, runner and team: messages go through sendMessage, and replies
// are posted from needsYou, against a stand-in for Slack. Workspaces have no virtual machine, so
// waking one is only recorded. A restart is the modules loaded again from what's on disk, and a
// crash is that without saving anything first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Session, UserItem, Workspace } from '../../shared/types.ts';
import { BOT, GROUP_DM, OTHER, OTHER_BOT, OTHER_TOKENS, OWNER, PRIVATE, PUBLIC, TOKENS, type FakeSlack, startFakeSlack } from '../support/fake-slack.ts';

vi.mock('../../server/workspaces.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/workspaces.ts')>(),
  startWorkspace: vi.fn(async () => {}),
}));

let home: string;
/** Every home a test used: a crash leaves the old one behind. */
let homes: string[] = [];
let slack: FakeSlack;
let store: typeof import('../../server/store.ts');
let runner: typeof import('../../server/agents/runner.ts');
let team: typeof import('../../server/agents/team.ts');
let transcripts: typeof import('../../server/transcript.ts');
let lonca: typeof import('../../server/slack/index.ts');
let outbox: typeof import('../../server/slack/outbox.ts');
let web: typeof import('../../server/slack/web.ts');
let events: typeof import('../../server/events.ts');
let project: Project;
let workspace: Workspace;
let lead: Session;
let runs = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const saved = () => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
const markdown = () => slack.posts().map((post) => slack.markdown(post));

async function load(): Promise<void> {
  store = await import('../../server/store.ts');
  runner = await import('../../server/agents/runner.ts');
  team = await import('../../server/agents/team.ts');
  transcripts = await import('../../server/transcript.ts');
  lonca = await import('../../server/slack/index.ts');
  outbox = await import('../../server/slack/outbox.ts');
  web = await import('../../server/slack/web.ts');
  events = await import('../../server/events.ts');
  Object.assign(outbox.OUTBOX_TIMING, { spacingMs: 5, retryMs: 50, maxRetryMs: 400, settleMs: 100 });
  Object.assign(lonca.SLACK_TIMING, { retryMs: 200, graceMs: 500, pendingRetryMs: 50, pendingMaxRetryMs: 200, pollMs: 60000 });
  lonca.SLACK_TIMING.socket = { retryMs: 50, maxRetryMs: 400 };
}

/** As if the server stopped and started again, with what it had saved. */
async function restart(between: () => void | Promise<void> = () => {}): Promise<void> {
  lonca.stopSlack();
  // A process that stops has nothing left in flight. These modules do, until it's answered.
  await sleep(150);
  store.flushTranscripts();
  store.flushState();
  await between();
  vi.resetModules();
  await load();
  workspace = store.getWorkspace(workspace.id)!;
  lead = store.getSession(lead.id)!;
  lonca.startSlack();
  await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
}

/** What's on disk this moment, as a process that died now would leave it, in a copy the old modules don't write to. */
function diskNow(): string {
  const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-slack-')));
  fs.cpSync(home, copy, { recursive: true });
  homes.push(copy);
  return copy;
}

/**
 * As if the server died: nothing is saved first, and what's loaded again is only what was on disk
 * then, or when `disk` was taken. The old modules can't reach Slack after that, though what they'd
 * already asked of it still lands.
 */
async function crash(disk = diskNow()): Promise<void> {
  lonca.stopSlack();
  home = disk;
  vi.stubEnv('LONCA_HOME', home);
  vi.resetModules();
  await load();
  workspace = store.getWorkspace(workspace.id)!;
  lead = store.getSession(lead.id)!;
  lonca.startSlack();
  await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
}

function makeWorkspace(id: string, name: string, title: string): { workspace: Workspace; lead: Session } {
  const made = { id, projectId: project.id, name, sandboxName: `vm-${id}`, status: 'creating', title, steps: [] } as unknown as Workspace;
  store.state.workspaces.push(made);
  return { workspace: made, lead: runner.createLead(made) };
}

/** A turn of the Lead's that ended having written this. */
function leadWrote(text: string, session = lead): string {
  const runId = `run${++runs}`;
  const transcript = transcripts.transcriptFor(session.id);
  transcript.upsert({ id: `${runId}:thinking`, ts: Date.now(), runId, type: 'thinking', text: 'Private thoughts.' });
  transcript.upsert({ id: `${runId}:tool`, ts: Date.now(), runId, type: 'tool', kind: 'command', name: 'Bash', title: 'Ran', detail: 'ls', status: 'done', output: 'secret output' });
  transcript.upsert({ id: `${runId}:text`, ts: Date.now(), runId, type: 'text', text });
  transcript.upsert({ id: `${runId}:result`, ts: Date.now(), runId, type: 'result' });
  return runId;
}

async function pair(user = OWNER): Promise<void> {
  if (!lonca.slackStatus().team) expect((await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app)).team).toBe('Fake Team');
  await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
  const code = lonca.slackStatus().pairing?.code ?? lonca.offerPairing().pairing!.code;
  slack.say(user, code);
  await vi.waitFor(() => expect(lonca.slackStatus().owner).toEqual({ user }));
  await vi.waitFor(() => expect(slack.posts(slack.dm(user)).some((post) => slack.markdown(post).startsWith('Paired with Lonca'))).toBe(true));
}

/** The Lead needs the user, and its thread has what Lonca posts for that. */
async function threadOf(target = workspace): Promise<string> {
  await vi.waitFor(() => expect(target.slack?.thread).toBeDefined());
  return target.slack!.thread!;
}

beforeEach(async () => {
  vi.resetModules();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-slack-')));
  homes = [home];
  vi.stubEnv('LONCA_HOME', home);
  slack = await startFakeSlack();
  vi.stubEnv('LONCA_SLACK_API_URL', slack.url);
  await load();
  project = { id: 'project', name: 'lonca', slug: 'lonca', settings: { env: {} } } as unknown as Project;
  store.state.projects.push(project);
  ({ workspace, lead } = makeWorkspace('workspace', 'prague', 'Fix the login redirect'));
});

afterEach(async () => {
  lonca.stopSlack();
  vi.restoreAllMocks();
  await slack.close();
  // Whatever was under way when the test ended finishes before its home goes.
  await sleep(150);
  store.flushTranscripts();
  store.flushState();
  vi.unstubAllEnvs();
  for (const used of homes) fs.rmSync(used, { recursive: true, force: true });
});

describe('the app’s tokens', () => {
  it('stay in secrets.json, out of state, environments, the proxy and everything posted', async () => {
    await pair();
    const secrets = path.join(home, 'secrets.json');
    expect(JSON.parse(fs.readFileSync(secrets, 'utf8'))).toMatchObject({ slackBotToken: TOKENS.bot, slackAppToken: TOKENS.app });
    expect(fs.statSync(secrets).mode & 0o777).toBe(0o600);
    expect(store.secretsStatus()).toMatchObject({ slackBotToken: `••••${TOKENS.bot.slice(-4)}`, slackAppToken: `••••${TOKENS.app.slice(-4)}` });
    const { execEnv } = await import('../../server/env.ts');
    const { proxySecrets } = await import('../../server/boundary.ts');
    const everywhere = JSON.stringify([
      fs.readFileSync(path.join(home, 'state.json'), 'utf8'), runner.turnEnv(lead, project, 'claude', '/run'), execEnv(project), proxySecrets(),
      lonca.slackStatus(), fs.existsSync(path.join(home, 'boundary')) ? fs.readdirSync(path.join(home, 'boundary')).map((name) => fs.readFileSync(path.join(home, 'boundary', name), 'utf8')) : [],
    ]);
    expect(everywhere).not.toContain('xoxb-');
    expect(everywhere).not.toContain('xapp-');
    // Even a Lead that somehow had them, or Lonca's own link, can't post them.
    leadWrote(`Here: ${TOKENS.bot} ${TOKENS.app} http://localhost:4700/?token=${store.accessToken()}`);
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown().some((text) => text.startsWith('Here:'))).toBe(true));
    const posted = JSON.stringify(slack.posts());
    expect(posted).not.toContain(TOKENS.bot);
    expect(posted).not.toContain(TOKENS.app);
    expect(posted).not.toContain(store.accessToken());
  });

  it('are checked with Slack before they’re saved, which says what was wrong', async () => {
    await expect(lonca.saveSlackTokens(TOKENS.app, TOKENS.app)).rejects.toMatchObject({ status: 400, message: /isn’t a bot token/ });
    await expect(lonca.saveSlackTokens(TOKENS.bot, TOKENS.bot)).rejects.toMatchObject({ status: 400, message: /isn’t an app-level token/ });
    await expect(lonca.saveSlackTokens('xoxb-1-unknown', TOKENS.app)).rejects.toMatchObject({ status: 400, message: 'Slack didn’t accept the bot token (invalid_auth).' });
    slack.tokens.delete(TOKENS.app);
    await expect(lonca.saveSlackTokens(TOKENS.bot, TOKENS.app)).rejects.toMatchObject({ status: 400, message: 'Slack didn’t accept the app-level token (token_revoked).' });
    slack.tokens.add(TOKENS.app);
    slack.fail('auth.test', { status: 503, error: 'service_unavailable' });
    await expect(lonca.saveSlackTokens(TOKENS.bot, TOKENS.app)).rejects.toMatchObject({ status: 502 });
    expect(store.getSecrets().slackBotToken).toBeUndefined();
    expect(lonca.slackStatus().connection).toBe('off');
    const status = await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    expect(status).toMatchObject({ team: 'Fake Team', pairing: { code: expect.stringMatching(/^\w{4}-\w{4}-\w{4}$/) } });
  });

  it.each(['org_login_required', 'team_added_to_org'])('aren’t given up on for %s, which a Slack workspace says while it migrates', async (code) => {
    await pair();
    lonca.stopSlack();
    slack.fail('auth.test', { error: code }, { error: code });
    lonca.startSlack();
    await vi.waitFor(() => expect(lonca.slackStatus()).toMatchObject({ connection: 'error', error: code }));
    expect(lonca.slackStatus().stopped).toBeUndefined();
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'), { timeout: 5000 });
    slack.fail('chat.postMessage', { error: code });
    leadWrote('Through a migration.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown()).toContain('Through a migration.'), { timeout: 5000 });
  });

  it('aren’t forgotten for what a replaced connection hears back late', async () => {
    await pair();
    const asked = slack.calls.filter((call) => call.method === 'auth.test').length;
    slack.delay('auth.test', 1500);
    slack.drop();
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'auth.test').length).toBeGreaterThan(asked));
    // While the old connection waits to hear whose its token is, the user moves to another app and pairs with it.
    await lonca.saveSlackTokens(OTHER_TOKENS.bot, OTHER_TOKENS.app);
    await pair();
    leadWrote('For the new app.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown()).toContain('For the new app.'));
    await sleep(1600);
    expect(lonca.slackStatus().owner).toEqual({ user: OWNER });
    expect(workspace.slack?.thread).toBeDefined();
    expect(saved().slack.owner).toMatchObject({ user: OWNER });
  }, 10000);

  it('aren’t stopped by a refusal of the tokens they replaced', async () => {
    await pair();
    leadWrote('A thread to read.');
    team.needsYou(lead, 'finished');
    await threadOf();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reads = slack.calls.filter((call) => call.method === 'conversations.replies').length;
    slack.fail('conversations.replies', { error: 'token_revoked' });
    slack.delay('conversations.replies', 1500);
    slack.drop();
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'conversations.replies').length).toBeGreaterThan(reads));
    await lonca.saveSlackTokens(OTHER_TOKENS.bot, OTHER_TOKENS.app);
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    await sleep(1600);
    expect(lonca.slackStatus()).toMatchObject({ connection: 'connected' });
    expect(lonca.slackStatus().stopped).toBeUndefined();
  }, 10000);

  it('aren’t saved when Slack is disconnected, or others saved, while Slack checks them', async () => {
    await pair();
    slack.delay('auth.test', 800);
    const saving = lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'auth.test').length).toBeGreaterThan(1));
    lonca.disconnectSlack();
    await expect(saving).rejects.toMatchObject({ status: 409 });
    expect(store.getSecrets().slackBotToken).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')).slackBotToken).toBeUndefined();
    expect(lonca.slackStatus()).toEqual({ connection: 'off' });
    expect(saved().slack).toBeUndefined();
    await sleep(300);
    expect(lonca.slackStatus()).toEqual({ connection: 'off' });
    // Of two saves under way at once, the later one is what's kept.
    slack.delay('auth.test', 800);
    const first = lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'auth.test').length).toBeGreaterThan(2));
    await lonca.saveSlackTokens(OTHER_TOKENS.bot, OTHER_TOKENS.app);
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(store.getSecrets()).toMatchObject({ slackBotToken: OTHER_TOKENS.bot, slackAppToken: OTHER_TOKENS.app });
  });

  it('stop being used, and the error is shown, once Slack refuses them', async () => {
    await pair();
    slack.tokens.delete(TOKENS.bot);
    leadWrote('Done.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(lonca.slackStatus()).toMatchObject({ connection: 'error', error: 'token_revoked' }));
    const calls = slack.calls.length;
    await sleep(500);
    expect(slack.calls.length).toBe(calls);
    // Saved again, they're used again, and what was waiting is posted.
    slack.tokens.add(TOKENS.bot);
    await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(markdown()).toContain('Done.'));
  });
});

describe('pairing', () => {
  it('answers nobody until a code arrives, and nobody but the owner after', async () => {
    await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    const ignored = [slack.say(OTHER, 'hello').envelope!, slack.say(OWNER, 'hi there').envelope!];
    await vi.waitFor(() => expect(ignored.every((id) => slack.acked.has(id))).toBe(true));
    expect(slack.posts()).toEqual([]);
    expect(slack.posts(slack.dm(OTHER))).toEqual([]);
    await pair();
    const later = slack.say(OTHER, 'I’m not the owner').envelope!;
    await vi.waitFor(() => expect(slack.acked.has(later)).toBe(true));
    expect(slack.posts(slack.dm(OTHER))).toEqual([]);
    expect(saved().slack.owner).toEqual({ user: OWNER, team: 'T0FAKE', dm: slack.dm(OWNER) });
  });

  it('acknowledges the code at once, and what comes after it, however slowly Slack opens the DM', async () => {
    await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    const code = lonca.slackStatus().pairing!.code;
    slack.delay('conversations.open', 3500);
    const sent = [slack.say(OWNER, code).envelope!, slack.say(OTHER, 'hello').envelope!];
    const early = slack.say(OWNER, 'Are you there yet?');
    await vi.waitFor(() => expect(sent.every((id) => slack.acked.has(id))).toBe(true), { timeout: 1000 });
    await vi.waitFor(() => expect(lonca.slackStatus().owner).toEqual({ user: OWNER }), { timeout: 6000 });
    // Written while the DM was being opened, it's answered once Lonca knows whose it is.
    await vi.waitFor(() => expect(slack.thread(early.ts).filter((message) => message.bot_id)).toHaveLength(1), { timeout: 3000 });
  }, 15000);

  it('comes to nothing when the app’s tokens are replaced while Slack opens the DM', async () => {
    await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    const code = lonca.slackStatus().pairing!.code;
    slack.delay('conversations.open', 1000);
    slack.say(OWNER, code);
    await vi.waitFor(() => expect(slack.calls.some((call) => call.method === 'conversations.open')).toBe(true));
    await lonca.saveSlackTokens(OTHER_TOKENS.bot, OTHER_TOKENS.app);
    await sleep(1300);
    expect(lonca.slackStatus().owner).toBeUndefined();
    expect(saved().slack.owner).toBeUndefined();
    // The code is still good, for the app that has it now.
    await pair();
    expect(saved().slack.owner).toMatchObject({ user: OWNER });
  }, 10000);

  it('takes a new code while Slack is still opening the DM for the one it replaced', async () => {
    await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    const first = lonca.slackStatus().pairing!.code;
    slack.fail('conversations.open', ...Array.from({ length: 3 }, () => ({ error: 'service_unavailable' })));
    slack.say(OWNER, first);
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'conversations.open')).toHaveLength(1));
    const second = lonca.offerPairing().pairing!.code;
    slack.failures.delete('conversations.open');
    slack.say(OWNER, second);
    await vi.waitFor(() => expect(lonca.slackStatus().owner).toEqual({ user: OWNER }), { timeout: 1500 });
    expect(lonca.slackStatus().pairing).toBeUndefined();
  });

  it('refuses a code that reached another app than the bot token’s, and says why', async () => {
    // A bot token from one app, and an app-level token, which events come with, from another.
    await lonca.saveSlackTokens(OTHER_TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    slack.say(OWNER, lonca.slackStatus().pairing!.code);
    await vi.waitFor(() => expect(lonca.slackStatus().pairingEnded).toBe('otherApp'));
    expect(lonca.slackStatus().owner).toBeUndefined();
    expect(lonca.slackStatus().pairing).toBeUndefined();
    await sleep(200);
    expect(slack.posts(slack.dm(OWNER, OTHER_BOT))).toEqual([]);
    expect(slack.posts(slack.dm(OWNER, BOT))).toEqual([]);
  });

  it('opens the DM and checks that it’s one person’s', async () => {
    await pair();
    expect(slack.calls.find((call) => call.method === 'conversations.open')?.params).toMatchObject({ users: OWNER, return_im: 'true' });
  });

  it('ends after five wrong codes, and a code works once', async () => {
    await lonca.saveSlackTokens(TOKENS.bot, TOKENS.app);
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    const code = lonca.slackStatus().pairing!.code;
    for (let attempt = 0; attempt < 5; attempt++) slack.say(OTHER, '0000-0000-0000');
    await vi.waitFor(() => expect(lonca.slackStatus()).toMatchObject({ pairingEnded: 'attempts' }));
    expect(lonca.slackStatus().pairing).toBeUndefined();
    const late = slack.say(OWNER, code).envelope!;
    await vi.waitFor(() => expect(slack.acked.has(late)).toBe(true));
    expect(lonca.slackStatus().owner).toBeUndefined();
    await pair();
    // Used, it pairs nobody else.
    slack.say(OTHER, code);
    await sleep(300);
    expect(lonca.slackStatus().owner).toEqual({ user: OWNER });
  });

  it('is replaced by pairing again, which starts every thread afresh with the new owner', async () => {
    await pair();
    leadWrote('For the first owner.');
    team.needsYou(lead, 'finished');
    await threadOf();
    await pair(OTHER);
    expect(workspace.slack).toBeUndefined();
    leadWrote('For the second.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.posts(slack.dm(OTHER)).map((post) => slack.markdown(post))).toContain('For the second.'));
    expect(markdown()).not.toContain('For the second.');
    // The first owner is nobody now.
    const id = slack.say(OWNER, 'still me?', { thread: workspace.slack!.thread }).envelope!;
    await vi.waitFor(() => expect(slack.acked.has(id)).toBe(true));
    expect(transcripts.transcriptFor(lead.id).items.some((item) => item.type === 'user' && item.text === 'still me?')).toBe(false);
  });
});

describe('what’s posted', () => {
  beforeEach(() => pair());

  it('starts a thread for the workspace, and posts the Lead’s last reply in it, safely', async () => {
    leadWrote('All done. <!here> @channel see [this](!everyone) and <@U0123ABCD>.\n\n```\n<!channel>\n```');
    team.needsYou(lead, 'finished');
    const thread = await threadOf();
    await vi.waitFor(() => expect(slack.thread(thread)).toHaveLength(2));
    const [root, reply] = slack.thread(thread);
    expect(slack.markdown(root)).toBe('**prague** in lonca\nFix the login redirect');
    expect(reply.thread_ts).toBe(thread);
    expect(reply.blocks).toEqual([{ type: 'markdown', text: expect.stringMatching(/^All done\. &lt;!here&gt; @​channel/) }]);
    expect(reply.text).toMatch(/^All done\. &lt;!here&gt;/);
    expect(reply.posted).toMatchObject({ unfurl_links: 'false', unfurl_media: 'false', channel: slack.dm() });
    expect(JSON.stringify(slack.posts())).not.toMatch(/<[!@#]|Private thoughts|secret output/);
    expect(reply.metadata).toEqual({ event_type: 'lonca_post', event_payload: { id: expect.any(String) } });
    expect(saved().workspaces[0].slack.thread).toBe(thread);
    expect(slack.postsOutsideDms()).toEqual([]);
  });

  it('makes everything it posts safe, roots and Lonca’s own replies included', async () => {
    const token = store.accessToken();
    workspace.title = `Open http://localhost:4700/?token=${token} <!here>`;
    workspace.name = `prague-${token}`;
    project.name = 'lonca @everyone <@U0123ABCD>';
    leadWrote('Done.');
    team.needsYou(lead, 'finished');
    const thread = await threadOf();
    await vi.waitFor(() => expect(slack.thread(thread).filter((message) => message.bot_id)).toHaveLength(2));
    workspace.status = 'archived';
    slack.say(OWNER, 'Still there?', { thread });
    const { ts } = slack.say(OWNER, 'Which Lead is this?');
    await vi.waitFor(() => expect(slack.thread(thread).at(-1)?.text).toMatch(/^This didn’t reach the Lead/));
    await vi.waitFor(() => expect(slack.thread(ts).filter((message) => message.bot_id)).toHaveLength(1));
    const posted = JSON.stringify(slack.posts().map((post) => [slack.markdown(post), post.text]));
    expect(posted).toContain('[redacted]');
    expect(posted).not.toContain(token);
    expect(posted).not.toMatch(/<[!@#]/);
    expect(posted).not.toMatch(/(?<![\w.+\-/])@(here|channel|everyone)\b/);
    expect(fs.readFileSync(path.join(home, 'state.json'), 'utf8').match(/"outbox"[^\]]*\]/)?.[0] ?? '').not.toContain(token);
  });

  it('says when the Lead paused, reached a limit or failed, and doesn’t post a reply twice', async () => {
    leadWrote('First reply.');
    team.needsYou(lead, 'finished');
    const thread = await threadOf();
    // The real way a Lead pauses: Lonca's update waits behind 30 turns without the user.
    const transcript = transcripts.transcriptFor(lead.id);
    transcript.upsert({ id: 'wake', ts: Date.now(), type: 'user', text: 'Update from Lonca.', attachments: [], queued: true, from: 'lonca' } as UserItem);
    runner.persistSession(lead, { queue: ['wake'], autonomousTurns: 30 });
    workspace.status = 'ready';
    runner.startNextQueued(lead);
    workspace.status = 'creating';
    expect(lead).toMatchObject({ held: true, unread: true });
    await vi.waitFor(() => expect(slack.thread(thread)).toHaveLength(3));
    expect(slack.markdown(slack.thread(thread)[2])).toBe('_The Lead paused after 30 turns without a word from you. Reply here to let it continue._');
    leadWrote('Partway, then the limit.');
    team.needsYou(lead, 'limit');
    team.needsYou(lead, 'limit');
    leadWrote('Broke.');
    team.needsYou(lead, 'failed');
    await vi.waitFor(() => expect(slack.thread(thread)).toHaveLength(5));
    expect(slack.thread(thread).slice(3).map((post) => slack.markdown(post))).toEqual([
      'Partway, then the limit.\n\n_The Lead reached a usage limit._',
      'Broke.\n\n_The Lead stopped with an error._',
    ]);
  });

  it('splits a long reply between paragraphs, and posts only the start of one too long', async () => {
    const paragraph = (index: number) => `Paragraph ${index}. ${'Lorem ipsum dolor sit amet. '.repeat(70)}`;
    leadWrote(Array.from({ length: 12 }, (_, index) => paragraph(index)).join('\n\n'));
    team.needsYou(lead, 'finished');
    const thread = await threadOf();
    await vi.waitFor(() => expect(slack.thread(thread).length).toBeGreaterThan(2));
    await sleep(200);
    const parts = slack.thread(thread).slice(1).map((post) => slack.markdown(post));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(4);
    expect(parts.join('\n\n')).toBe(Array.from({ length: 12 }, (_, index) => paragraph(index)).join('\n\n').trim());
    leadWrote(Array.from({ length: 60 }, (_, index) => paragraph(index)).join('\n\n'));
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.markdown(slack.thread(thread).at(-1)!)).toMatch(/The rest is in Lonca\._$/));
    expect(slack.thread(thread).length).toBe(parts.length + 2);
  });

  it('passes on a reply to a thread whose root Slack hasn’t confirmed yet', async () => {
    slack.delay('chat.postMessage', 800);
    leadWrote('Starting a thread.');
    team.needsYou(lead, 'finished');
    const root = await vi.waitFor(() => {
      const found = slack.posts().find((post) => slack.markdown(post).startsWith('**prague**'));
      expect(found).toBeDefined();
      return found!;
    });
    slack.say(OWNER, 'Replying straight away', { thread: root.ts });
    const fromSlack = () => transcripts.transcriptFor(lead.id).items.filter((item): item is UserItem => item.type === 'user' && item.via === 'slack');
    await vi.waitFor(() => expect(fromSlack().map((item) => item.text)).toEqual(['Replying straight away']), { timeout: 3000 });
    expect(slack.thread(root.ts).some((message) => slack.markdown(message).startsWith('To reach a Lead'))).toBe(false);
  });

  it('posts nothing when the switch is off', async () => {
    store.state.settings.slackReplies = false;
    leadWrote('Not for Slack.');
    team.needsYou(lead, 'finished');
    await sleep(300);
    expect(markdown()).not.toContain('Not for Slack.');
    expect(workspace.slack).toBeUndefined();
  });

  it('keeps every post in order, through a 429 and Slack being unreachable', async () => {
    const other = makeWorkspace('second', 'lisbon', 'Second');
    slack.fail('chat.postMessage', { status: 429, error: 'ratelimited', retryAfter: 1 }, { status: 503, error: 'service_unavailable' });
    leadWrote('A1');
    team.needsYou(lead, 'finished');
    leadWrote('B1', other.lead);
    team.needsYou(other.lead, 'finished');
    leadWrote('A2');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown()).toContain('A2'), { timeout: 8000 });
    expect(markdown().slice(1)).toEqual(['**prague** in lonca\nFix the login redirect', 'A1', '**lisbon** in lonca\nSecond', 'B1', 'A2']);
    const posts = slack.calls.filter((call) => call.method === 'chat.postMessage');
    expect(posts[2].at - posts[1].at).toBeGreaterThanOrEqual(1000);
    expect(slack.thread(workspace.slack!.thread!).map((post) => slack.markdown(post)).slice(1)).toEqual(['A1', 'A2']);
  });

  it('keeps trying, and says so in Settings, when Slack refuses a post for a reason Lonca doesn’t know', async () => {
    slack.fail('chat.postMessage', { error: 'message_limit_exceeded' }, { error: 'message_limit_exceeded' });
    leadWrote('Not lost.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(lonca.slackStatus().postError).toBe('message_limit_exceeded'));
    await vi.waitFor(() => expect(markdown()).toContain('Not lost.'), { timeout: 5000 });
    expect(markdown().filter((text) => text.startsWith('**prague**'))).toHaveLength(1);
    expect(lonca.slackStatus().postError).toBeUndefined();
  });

  it('posts a short note in place of a reply Slack won’t take, and carries on', async () => {
    leadWrote('Before.');
    team.needsYou(lead, 'finished');
    const thread = await threadOf();
    await vi.waitFor(() => expect(slack.thread(thread).filter((message) => message.bot_id)).toHaveLength(2));
    slack.fail('chat.postMessage', { error: 'invalid_blocks' });
    leadWrote('Something Slack won’t take.');
    team.needsYou(lead, 'finished');
    leadWrote('After.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.thread(thread).filter((message) => message.bot_id).map((message) => slack.markdown(message)).slice(2)).toEqual([
      'This reply couldn’t be posted to Slack. It’s in Lonca.', 'After.',
    ]));
  });

  it('starts the workspace a new thread when its root was deleted in Slack', async () => {
    leadWrote('Before.');
    team.needsYou(lead, 'finished');
    const first = await threadOf();
    await vi.waitFor(() => expect(slack.thread(first).filter((message) => message.bot_id)).toHaveLength(2));
    slack.remove(first);
    leadWrote('In a new thread.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(workspace.slack?.thread).not.toBe(first));
    const second = workspace.slack!.thread!;
    await vi.waitFor(() => expect(slack.thread(second).map((message) => slack.markdown(message))).toEqual(['**prague** in lonca\nFix the login redirect', 'In a new thread.']));
  });

  it('isn’t posted twice when Slack posts it but the answer is lost', async () => {
    slack.fail('chat.postMessage', { loseAnswer: true }, { loseAnswer: true });
    leadWrote('Only once.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(store.state.slack?.outbox ?? []).toEqual([]), { timeout: 5000 });
    expect(markdown().filter((text) => text === 'Only once.')).toHaveLength(1);
    expect(markdown().filter((text) => text.startsWith('**prague**'))).toHaveLength(1);
  });

  it.each(['internal_error', 'fatal_error'])('isn’t posted twice when Slack posts it and then says %s', async (error) => {
    slack.fail('chat.postMessage', { error, afterDoing: true });
    leadWrote('Only once, whatever Slack said.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(store.state.slack?.outbox ?? []).toEqual([]), { timeout: 5000 });
    expect(markdown().filter((text) => text.startsWith('**prague**'))).toHaveLength(1);
  });

  it('isn’t taken for not posted when looking for it found more than Lonca reads at once', async () => {
    leadWrote('Before.');
    team.needsYou(lead, 'finished');
    const thread = await threadOf();
    await vi.waitFor(() => expect(slack.thread(thread).filter((message) => message.bot_id)).toHaveLength(2));
    for (const text of ['One', 'Two', 'Three']) slack.say(OWNER, text, { thread, deliver: false });
    Object.assign(web.SLACK_PAGING, { limit: 2, maxPages: 1 });
    slack.fail('chat.postMessage', { error: 'internal_error', afterDoing: true });
    leadWrote('Made the first time.');
    team.needsYou(lead, 'finished');
    await sleep(800);
    Object.assign(web.SLACK_PAGING, { limit: 200, maxPages: 100 });
    await vi.waitFor(() => expect(store.state.slack?.outbox ?? []).toEqual([]), { timeout: 3000 });
    expect(markdown().filter((text) => text === 'Made the first time.')).toHaveLength(1);
  });

  it('waits before looking for a post whose answer was lost, which can still land', async () => {
    outbox.OUTBOX_TIMING.settleMs = 1000;
    slack.fail('chat.postMessage', { loseAnswer: true, landAfterMs: 500 });
    leadWrote('Landed late.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(store.state.slack?.outbox ?? []).toEqual([]), { timeout: 5000 });
    // Until well after the first one would have landed.
    await sleep(800);
    expect(markdown().filter((text) => text.startsWith('**prague**'))).toHaveLength(1);
    expect(markdown()).toContain('Landed late.');
  });

  it('survives a crash before it’s posted, and isn’t posted twice after one while Slack was posting it', async () => {
    slack.fail('chat.postMessage', ...Array.from({ length: 50 }, () => ({ status: 503, error: 'service_unavailable' })));
    leadWrote('Waited for Slack.');
    team.needsYou(lead, 'finished');
    // On disk as soon as it's decided.
    expect(saved().slack.outbox.map((post: { kind: string }) => post.kind)).toEqual(['root', 'text']);
    slack.failures.clear();
    await crash();
    await vi.waitFor(() => expect(markdown()).toContain('Waited for Slack.'));
    // Now Slack makes the post, and Lonca dies before it hears back.
    slack.delay('chat.postMessage', 1000);
    leadWrote('Made before the crash.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.calls.some((call) => call.method === 'chat.postMessage' && call.params.text === 'Made before the crash.')).toBe(true));
    const disk = diskNow();
    // That it was asked for was saved before Slack was.
    expect(JSON.parse(fs.readFileSync(path.join(disk, 'state.json'), 'utf8')).slack.outbox).toEqual([expect.objectContaining({ askedAt: expect.any(Number) })]);
    await crash(disk);
    await vi.waitFor(() => expect(store.state.slack?.outbox).toEqual([]));
    await sleep(1000);
    expect(markdown().filter((text) => text === 'Made before the crash.')).toHaveLength(1);
  });

  /** A post whose first try may have reached Slack, so that the next looks for it first, slowly. */
  async function lookingForAPost(): Promise<void> {
    leadWrote('Before.');
    team.needsYou(lead, 'finished');
    const thread = await threadOf();
    await vi.waitFor(() => expect(slack.thread(thread).filter((message) => message.bot_id)).toHaveLength(2));
    slack.fail('chat.postMessage', { status: 500, error: 'internal_error' });
    slack.delay('conversations.replies', 800);
    leadWrote('After.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.calls.some((call) => call.method === 'conversations.replies' && call.params.include_all_metadata === 'true')).toBe(true), { timeout: 5000 });
  }

  it('posts nothing once Slack is disconnected, even a post it was looking for', async () => {
    await lookingForAPost();
    const posts = slack.calls.filter((call) => call.method === 'chat.postMessage').length;
    lonca.disconnectSlack();
    await sleep(1200);
    expect(slack.calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(posts);
    expect(markdown()).not.toContain('After.');
  });

  it('posts nothing to the last owner once Slack is paired with someone else, even a post it was looking for', async () => {
    await lookingForAPost();
    await pair(OTHER);
    await sleep(1200);
    expect(markdown()).not.toContain('After.');
  });

  it('drops what’s waiting for a workspace that’s deleted', async () => {
    slack.fail('chat.postMessage', ...Array.from({ length: 50 }, () => ({ status: 503, error: 'service_unavailable' })));
    leadWrote('Never posted.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.calls.some((call) => call.method === 'chat.postMessage' && call.params.text.includes('prague'))).toBe(true));
    expect(store.state.slack?.outbox).toHaveLength(2);
    store.state.workspaces = store.state.workspaces.filter((entry) => entry !== workspace);
    const { publish } = await import('../../server/events.ts');
    publish({ type: 'workspace.removed', id: workspace.id });
    expect(store.state.slack?.outbox).toEqual([]);
    slack.failures.clear();
    await sleep(300);
    expect(markdown().some((text) => text.includes('prague') || text === 'Never posted.')).toBe(false);
  });

  it('lands before Disconnect is done, if it was already on its way', async () => {
    leadWrote('First.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown()).toContain('First.'));
    slack.delay('chat.postMessage', 800);
    leadWrote('On its way.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.calls.some((call) => call.method === 'chat.postMessage' && call.params.text === 'On its way.')).toBe(true));
    const started = Date.now();
    await lonca.disconnectSlack();
    expect(Date.now() - started).toBeGreaterThan(500);
    expect(lonca.slackStatus()).toEqual({ connection: 'off' });
  });

  it('may still arrive after Disconnect, which Settings says, if Slack takes too long to answer for it', async () => {
    lonca.SLACK_TIMING.writesWaitMs = 200;
    const posted = slack.calls.filter((call) => call.method === 'chat.postMessage').length;
    slack.delay('chat.postMessage', 1500);
    leadWrote('Slow.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'chat.postMessage').length).toBeGreaterThan(posted));
    const started = Date.now();
    await lonca.disconnectSlack();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(lonca.slackStatus()).toEqual({ connection: 'off', postMayArrive: true });
    // As it does, before this test's home goes.
    await sleep(1400);
  });

  it('lands before someone else is paired, if it was already on its way to the last owner', async () => {
    leadWrote('First.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown()).toContain('First.'));
    slack.delay('chat.postMessage', 1000);
    leadWrote('To the first owner.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(slack.calls.some((call) => call.method === 'chat.postMessage' && call.params.text === 'To the first owner.')).toBe(true));
    slack.say(OTHER, lonca.offerPairing().pairing!.code);
    await sleep(500);
    expect(lonca.slackStatus().owner).toEqual({ user: OWNER });
    await vi.waitFor(() => expect(lonca.slackStatus().owner).toEqual({ user: OTHER }), { timeout: 2000 });
    expect(markdown()).toContain('To the first owner.');
    expect(lonca.slackStatus().postMayArrive).toBeUndefined();
  });

  it('forgets everything on disconnect', async () => {
    leadWrote('Before.');
    team.needsYou(lead, 'finished');
    await threadOf();
    slack.fail('chat.postMessage', ...Array.from({ length: 50 }, () => ({ status: 503, error: 'service_unavailable' })));
    leadWrote('Waiting.');
    team.needsYou(lead, 'finished');
    // Failed once, so that it's waiting rather than on its way.
    await vi.waitFor(() => expect(slack.calls.some((call) => call.method === 'chat.postMessage' && call.params.text === 'Waiting.')).toBe(true));
    lonca.disconnectSlack();
    expect(lonca.slackStatus()).toEqual({ connection: 'off' });
    expect(saved().slack).toBeUndefined();
    expect(saved().workspaces[0].slack).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')).slackBotToken).toBeUndefined();
    slack.failures.clear();
    await sleep(300);
    expect(markdown()).not.toContain('Waiting.');
  });
});

describe('what’s posted, with this computer’s clock ahead of Slack’s', () => {
  it('isn’t posted twice when Slack posts it but the answer is lost', async () => {
    slack.clockOffsetMs = -2 * 60 * 60 * 1000;
    await pair();
    leadWrote('A thread first.');
    team.needsYou(lead, 'finished');
    await threadOf();
    slack.fail('chat.postMessage', { loseAnswer: true });
    leadWrote('Only once.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(store.state.slack?.outbox ?? []).toEqual([]), { timeout: 5000 });
    await sleep(300);
    expect(markdown().filter((text) => text === 'Only once.')).toHaveLength(1);
  });
});

describe('what’s been handled', () => {
  it('is remembered until a catch-up has read past it, however much comes after', async () => {
    const { handledThrough, isHandled, markHandled } = await import('../../server/slack/state.ts');
    const ledger = { handled: '1700000000.000000' };
    markHandled(ledger, '1700000001.000000');
    for (let index = 0; index < 600; index++) markHandled(ledger, `1700000002.${String(index).padStart(6, '0')}`);
    expect(isHandled(ledger, '1700000001.000000')).toBe(true);
    handledThrough(ledger, '1700000001.500000');
    expect(isHandled(ledger, '1700000001.000000')).toBe(true);
    expect(isHandled(ledger, '1700000002.000599')).toBe(true);
    expect(isHandled(ledger, '1700000003.000000')).toBe(false);
  });
});

describe('what the owner writes', () => {
  let thread: string;

  beforeEach(async () => {
    await pair();
    leadWrote('Ready for you.');
    team.needsYou(lead, 'finished');
    thread = await threadOf();
    await vi.waitFor(() => expect(slack.thread(thread)).toHaveLength(2));
  });

  const slackItems = () => transcripts.transcriptFor(lead.id).items.filter((item): item is UserItem => item.type === 'user' && item.via === 'slack');

  it('reaches the Lead as if typed in Lonca, saying where it came from, and gets an eyes', async () => {
    runner.persistSession(lead, { autonomousTurns: 30, held: true, unread: true });
    workspace.status = 'stopped';
    const { ts, envelope } = slack.say(OWNER, 'Ship it &amp; tell <@U0123ABCD>', { thread });
    await vi.waitFor(() => expect(slack.acked.has(envelope!)).toBe(true));
    await vi.waitFor(() => expect(slackItems()).toHaveLength(1));
    const [item] = slackItems();
    expect(item).toMatchObject({ id: `slack-${slack.dm()}-${ts.replace('.', '-')}`, text: 'Ship it & tell @U0123ABCD', via: 'slack', context: lonca.FROM_SLACK, queued: true });
    expect(item.from).toBeUndefined();
    expect(lead).toMatchObject({ autonomousTurns: 0, held: false, unread: false, queue: [item.id] });
    const { startWorkspace } = await import('../../server/workspaces.ts');
    expect(startWorkspace).toHaveBeenCalledWith(workspace);
    await vi.waitFor(() => expect(slack.messages().find((message) => message.ts === ts)?.reactions).toEqual([{ name: 'eyes', users: [BOT.user] }]));
  });

  it('gets an eyes Slack won’t take without it holding up the Lead’s reply', async () => {
    slack.fail('reactions.add', ...Array.from({ length: 50 }, () => ({ error: 'too_many_emoji' })));
    slack.say(OWNER, 'Seen?', { thread });
    await vi.waitFor(() => expect(slackItems()).toHaveLength(1));
    leadWrote('Seen, and on it.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown()).toContain('Seen, and on it.'));
    await vi.waitFor(() => expect(store.state.slack?.outbox).toEqual([]));
  });

  it('gets an eyes Slack can’t take yet without it holding up the Lead’s reply, and once Slack can', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    slack.fail('reactions.add', ...Array.from({ length: 10 }, () => ({ status: 503, error: 'service_unavailable' })));
    const { ts } = slack.say(OWNER, 'Seen?', { thread });
    await vi.waitFor(() => expect(slackItems()).toHaveLength(1));
    leadWrote('On it.');
    team.needsYou(lead, 'finished');
    await vi.waitFor(() => expect(markdown()).toContain('On it.'));
    expect(lonca.slackStatus().postError).toBeUndefined();
    await vi.waitFor(() => expect(slack.messages().find((message) => message.ts === ts)?.reactions).toEqual([{ name: 'eyes', users: [BOT.user] }]), { timeout: 6000 });
  }, 10000);

  it('is answered with the reason when it can’t be passed on', async () => {
    workspace.status = 'archived';
    slack.say(OWNER, 'Are you there?', { thread });
    await vi.waitFor(() => expect(slack.thread(thread).at(-1)?.text).toBe('This didn’t reach the Lead: prague is archived.'));
    workspace.status = 'creating';
    await runner.closeLead(lead);
    slack.say(OWNER, 'Hello?', { thread });
    await vi.waitFor(() => expect(slack.markdown(slack.thread(thread).at(-1)!)).toMatch(/^This workspace has no Lead/));
    expect(slackItems()).toEqual([]);
  });

  it('passes on a file’s text, and says the file wasn’t', async () => {
    slack.say(OWNER, 'See the log', { thread, subtype: 'file_share', files: [{ id: 'F1' }] });
    slack.say(OWNER, '', { thread, subtype: 'file_share', files: [{ id: 'F2' }] });
    await vi.waitFor(() => expect(slack.thread(thread).filter((post) => slack.markdown(post).startsWith('Files aren’t passed on'))).toHaveLength(2));
    expect(slackItems().map((item) => item.text)).toEqual(['See the log']);
  });

  it('is ignored, and nothing’s said, from anyone else, a bot, an edit, or outside the DM', async () => {
    const envelopes = [
      slack.say(OTHER, 'from someone else', { channel: slack.dm(), thread }).envelope!,
      slack.say(OTHER, 'in their own DM', { thread }).envelope!,
      slack.say(OWNER, 'a bot', { thread, subtype: 'bot_message' }).envelope!,
      slack.deliver({ type: 'message', subtype: 'message_changed', channel: slack.dm(), channel_type: 'im', ts: '1.000001', message: { user: OWNER, text: 'edited', thread_ts: thread }, team: 'T0FAKE' })!,
      slack.deliver({ type: 'message', subtype: 'message_deleted', channel: slack.dm(), channel_type: 'im', ts: '1.000002', deleted_ts: thread, team: 'T0FAKE' })!,
      slack.deliver({ type: 'message', user: OWNER, bot_id: 'B0OTHER', text: 'a bot as the owner', channel: slack.dm(), channel_type: 'im', ts: '1.000003', thread_ts: thread })!,
      ...[[PUBLIC, 'channel'], [PRIVATE, 'group'], [GROUP_DM, 'mpim']].map(([channel, type]) =>
        slack.deliver({ type: 'message', user: OWNER, text: `in ${type}`, channel, channel_type: type, ts: '1.000004', thread_ts: thread, team: 'T0FAKE' })!),
    ];
    await vi.waitFor(() => expect(envelopes.every((id) => slack.acked.has(id))).toBe(true));
    await sleep(200);
    expect(slackItems()).toEqual([]);
    expect(slack.thread(thread).filter((message) => message.bot_id)).toHaveLength(2);
    expect(slack.postsOutsideDms()).toEqual([]);
    // No call was made about any of them.
    expect(slack.calls.filter((call) => ![
      'auth.test', 'apps.connections.open', 'conversations.open', 'chat.postMessage', 'conversations.replies', 'conversations.history',
    ].includes(call.method))).toEqual([]);
    expect(slack.calls.every((call) => !call.params.channel || call.params.channel === slack.dm())).toBe(true);
  });

  it('reaches the Lead when it looks like a pairing code, in a workspace’s thread, while one is on offer', async () => {
    lonca.offerPairing();
    for (let index = 0; index < 5; index++) slack.say(OWNER, `12345678901${index}`, { thread });
    await vi.waitFor(() => expect(slackItems()).toHaveLength(5));
    // None of them was taken for a wrong code.
    expect(lonca.slackStatus().pairing).toBeDefined();
    expect(lonca.slackStatus().pairingEnded).toBeUndefined();
  });

  it('isn’t read with the old token once Slack is disconnected, even by a read waiting out a 429', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reads = () => slack.calls.filter((call) => call.method === 'conversations.replies').length;
    const before = reads();
    slack.fail('conversations.replies', { status: 429, error: 'ratelimited', retryAfter: 1 });
    slack.say(OWNER, 'Read after a wait', { thread });
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    await lonca.disconnectSlack();
    await sleep(1300);
    expect(reads()).toBe(before + 1);
  });

  it('isn’t held up by a read for an owner who’s been replaced', async () => {
    const reads = () => slack.calls.filter((call) => call.method === 'conversations.history').length;
    const before = reads();
    slack.delay('conversations.history', 4000);
    slack.say(OWNER, 'At the top');
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    await pair(OTHER);
    const { ts } = slack.say(OTHER, 'Which Lead is this?');
    await vi.waitFor(() => expect(slack.thread(ts, slack.dm(OTHER)).some((message) => message.bot_id)).toBe(true), { timeout: 2000 });
  });

  it('is read in a while, though Slack never sent its event and the connection stayed up', async () => {
    lonca.SLACK_TIMING.pollMs = 200;
    lonca.stopSlack();
    lonca.startSlack();
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    await lonca.catchUp();
    const connections = slack.connections;
    slack.say(OWNER, 'Never announced', { thread, deliver: false });
    await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['Never announced']), { timeout: 2000 });
    expect(slack.connections).toBe(connections);
  });

  it('isn’t read now and then once nothing has happened in its conversation for a while', async () => {
    Object.assign(lonca.SLACK_TIMING, { pollMs: 200, activeMs: 1000 });
    lonca.stopSlack();
    lonca.startSlack();
    await vi.waitFor(() => expect(lonca.slackStatus().connection).toBe('connected'));
    await lonca.catchUp();
    await sleep(1100);
    const reads = () => slack.calls.filter((call) => call.method.startsWith('conversations.')).length;
    const before = reads();
    await sleep(600);
    expect(reads()).toBe(before);
  });

  it('is pointed to a thread when it’s at the top of the DM', async () => {
    const { ts } = slack.say(OWNER, 'Which Lead is this?');
    await vi.waitFor(() => expect(slack.thread(ts).map((message) => message.bot_id ? slack.markdown(message) : message.text)).toEqual([
      'Which Lead is this?', expect.stringMatching(/^To reach a Lead, reply in its workspace’s thread/),
    ]));
  });

  it('is read a part at a time, in order, from a thread with more than Lonca reads at once', async () => {
    for (const text of ['One', 'Two', 'Three', 'Four', 'Five']) slack.say(OWNER, text, { thread, deliver: false });
    Object.assign(web.SLACK_PAGING, { limit: 2, maxPages: 1 });
    slack.drop();
    await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['One', 'Two', 'Three', 'Four', 'Five']), { timeout: 3000 });
    slack.say(OWNER, 'Six', { thread });
    await vi.waitFor(() => expect(slackItems()).toHaveLength(6));
  });

  it('is pointed to a thread from the newest part only, when the DM’s top level has more than Lonca reads at once', async () => {
    const sent = ['One', 'Two', 'Three', 'Four'].map((text) => slack.say(OWNER, text, { deliver: false }).ts);
    Object.assign(web.SLACK_PAGING, { limit: 2, maxPages: 1 });
    slack.drop();
    const answered = (ts: string) => slack.thread(ts).some((message) => message.bot_id);
    await vi.waitFor(() => expect(sent.map(answered)).toEqual([false, false, true, true]), { timeout: 3000 });
    const { ts } = slack.say(OWNER, 'Five');
    await vi.waitFor(() => expect(answered(ts)).toBe(true));
    await sleep(300);
    expect(sent.map(answered)).toEqual([false, false, true, true]);
  });

  describe('exactly once', () => {
    it('when Slack sends it again', async () => {
      const { envelope } = slack.say(OWNER, 'Once', { thread });
      await vi.waitFor(() => expect(slack.acked.has(envelope!)).toBe(true));
      slack.redeliver(envelope!);
      slack.redeliver(envelope!);
      await sleep(300);
      expect(slackItems()).toHaveLength(1);
      expect(lead.queue).toHaveLength(1);
    });

    it('when it was written while the connection was down', async () => {
      slack.say(OWNER, 'While disconnected', { thread, deliver: false });
      slack.drop();
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['While disconnected']));
      slack.drop();
      await vi.waitFor(() => expect(slack.connections).toBe(3));
      await sleep(300);
      expect(slackItems()).toHaveLength(1);
    });

    it('in the order written, whatever order Slack’s events about them arrive in', async () => {
      const first = slack.say(OWNER, 'Merge it.', { thread, deliver: false });
      const second = slack.say(OWNER, 'Stop, don’t merge.', { thread, deliver: false });
      const eventFor = (ts: string) => slack.eventFor({ id: slack.dm(), type: 'im' }, slack.thread(thread).find((message) => message.ts === ts)!);
      slack.deliver(eventFor(second.ts));
      slack.deliver(eventFor(first.ts));
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['Merge it.', 'Stop, don’t merge.']));
      await sleep(300);
      expect(slackItems()).toHaveLength(2);
    });

    it('when Slack’s event about it comes before it can be read', async () => {
      slack.say(OWNER, 'Read late', { thread, readableAfterMs: 300 });
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['Read late']), { timeout: 3000 });
    });

    it('in the order written, when Slack shows a later one before an earlier one', async () => {
      slack.say(OWNER, 'Merge it.', { thread, readableAfterMs: 300 });
      slack.say(OWNER, 'Stop, don’t merge.', { thread });
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['Merge it.', 'Stop, don’t merge.']), { timeout: 3000 });
    });

    it('as the event had it, in its place, when Slack still doesn’t show it after a while', async () => {
      slack.say(OWNER, 'Never shown', { thread, readableAfterMs: 60000 });
      slack.say(OWNER, 'Shown', { thread });
      await sleep(300);
      // What comes after it waits for it.
      expect(slackItems()).toEqual([]);
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['Never shown', 'Shown']), { timeout: 3000 });
    });

    it('from what its event said, when Lonca dies before Slack shows it', async () => {
      const { envelope } = slack.say(OWNER, 'Kept from the event', { thread, readableAfterMs: 60000 });
      await vi.waitFor(() => expect(slack.acked.has(envelope!)).toBe(true));
      await crash();
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['Kept from the event']), { timeout: 3000 });
    });

    it('in the order written in a thread that starts while another is being read', async () => {
      const other = makeWorkspace('second', 'lisbon', 'Second');
      const reads = slack.calls.filter((call) => call.method === 'conversations.replies').length;
      slack.delay('conversations.replies', 1200);
      slack.say(OWNER, 'One', { thread });
      await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'conversations.replies').length).toBeGreaterThan(reads));
      slack.delay('chat.postMessage', 300);
      leadWrote('A thread of its own.', other.lead);
      team.needsYou(other.lead, 'finished');
      const root = await vi.waitFor(() => {
        const found = slack.posts().find((post) => slack.markdown(post).startsWith('**lisbon**'));
        expect(found).toBeDefined();
        return found!;
      });
      slack.say(OWNER, 'Early', { thread: root.ts });
      await vi.waitFor(() => expect(other.workspace.slack?.thread).toBe(root.ts));
      slack.say(OWNER, 'Later', { thread: root.ts });
      const inOther = () => transcripts.transcriptFor(other.lead.id).items.filter((item): item is UserItem => item.type === 'user' && item.via === 'slack');
      await vi.waitFor(() => expect(inOther().map((item) => item.text)).toEqual(['Early', 'Later']), { timeout: 4000 });
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['One']));
    }, 10000);

    it('as it first reads it: edited before then, as edited, and deleted before then, not at all', async () => {
      const edited = slack.say(OWNER, 'Typo', { thread, deliver: false });
      slack.edit(edited.ts, 'Fixed while Lonca was away');
      const deleted = slack.say(OWNER, 'Never mind', { thread, deliver: false });
      slack.remove(deleted.ts);
      slack.drop();
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['Fixed while Lonca was away']));
      // An edit once it's been passed on doesn't change what the Lead was sent.
      slack.edit(edited.ts, 'Changed again');
      await sleep(300);
      expect(slackItems().map((item) => item.text)).toEqual(['Fixed while Lonca was away']);
    });

    it('in the order written, when one comes live while what was missed is still being read', async () => {
      slack.say(OWNER, 'First, while disconnected', { thread, deliver: false });
      const reads = slack.calls.filter((call) => call.method === 'conversations.replies').length;
      slack.delay('conversations.replies', 800);
      slack.drop();
      await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === 'conversations.replies').length).toBeGreaterThan(reads));
      const { envelope } = slack.say(OWNER, 'Second, live', { thread });
      // Acknowledged at once all the same: the catch-up, or the next one, has it.
      await vi.waitFor(() => expect(slack.acked.has(envelope!)).toBe(true), { timeout: 500 });
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['First, while disconnected', 'Second, live']), { timeout: 3000 });
    }, 10000);

    it('after waiting as long as Slack asked, when it slows a catch-up down', async () => {
      lonca.SLACK_TIMING.retryMs = 60000;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      slack.say(OWNER, 'While disconnected', { thread, deliver: false });
      slack.fail('conversations.replies', ...Array.from({ length: 6 }, () => ({ status: 429, error: 'ratelimited', retryAfter: 1 })));
      slack.drop();
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['While disconnected']), { timeout: 10000 });
    }, 15000);

    it('without keeping a list of what it’s handled that only grows', async () => {
      for (const text of ['One', 'Two', 'Three', 'Four']) slack.say(OWNER, text, { thread });
      await vi.waitFor(() => expect(slackItems()).toHaveLength(4));
      await vi.waitFor(() => expect(workspace.slack?.done ?? []).toEqual([]));
      expect(workspace.slack?.handled).toBe(slackItems()[3].id.split('-').slice(2).join('.'));
    });

    it('when Lonca restarts, or dies once the Lead has it but before it’s marked handled', async () => {
      lonca.stopSlack();
      slack.say(OWNER, 'While Lonca was down', { thread });
      slack.say(OWNER, 'And this', { thread, deliver: false });
      await restart();
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['While Lonca was down', 'And this']));
      const handledBefore = workspace.slack?.handled;
      // What's on disk the moment the Lead's queue has it saved, which is before anything else is.
      let disk: string | undefined;
      let id = '';
      const stop = events.subscribe((event) => {
        if (!disk && event.type === 'session' && event.session.id === lead.id && event.session.queue.includes(id)) disk = diskNow();
      });
      const { ts } = slack.say(OWNER, 'Accepted, then a crash', { thread });
      id = `slack-${slack.dm()}-${ts.replace('.', '-')}`;
      await vi.waitFor(() => expect(disk).toBeDefined());
      stop();
      const left = JSON.parse(fs.readFileSync(path.join(disk!, 'state.json'), 'utf8'));
      expect(left.sessions.find((session: Session) => session.id === lead.id).queue).toContain(id);
      expect(left.workspaces[0].slack.handled).toBe(handledBefore);
      await crash(disk);
      await vi.waitFor(() => expect(workspace.slack?.handled).toBe(ts));
      await sleep(300);
      expect(slackItems().map((item) => item.text)).toEqual(['While Lonca was down', 'And this', 'Accepted, then a crash']);
      expect(lead.queue).toHaveLength(3);
      await vi.waitFor(() => expect(slack.messages().find((message) => message.ts === ts)?.reactions).toEqual([{ name: 'eyes', users: [BOT.user] }]));
    });

    it('when saving it fails, leaving it for Slack to send again, and in order', async () => {
      const rename = fs.renameSync;
      const failing = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (to === path.join(home, 'state.json')) throw new Error('disk full');
        rename(from, to);
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = slack.say(OWNER, 'First', { thread }).envelope!;
      const second = slack.say(OWNER, 'Second', { thread }).envelope!;
      await sleep(400);
      // Not saved, so Slack isn't told they arrived.
      expect(slack.acked.has(first) || slack.acked.has(second)).toBe(false);
      expect(slackItems()).toEqual([]);
      failing.mockRestore();
      slack.redeliver(second);
      await vi.waitFor(() => expect(slackItems().map((item) => item.text)).toEqual(['First', 'Second']), { timeout: 3000 });
      expect(slack.acked.has(second)).toBe(true);
      slack.redeliver(first);
      await sleep(300);
      expect(slackItems()).toHaveLength(2);
    });
  });
});
