import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, Attachment, ChatItem, LoginPhase, LoginState, NoticeItem, Profile, Project, Session, ToolItem, UserItem, Workspace } from '../../shared/types.ts';
import { Lonca, asRoot, installFakeSignIn, makeFixtureRepo, removeFakeSignIn, sandboxExec, setFakeSignIn, until } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

// The real `gemini` CLI in a real workspace, with only Google replaced: the mock answers as Code
// Assist does for a Google account and as the Gemini API does for a key, and a token server here
// stands in for Google's, which Lonca renews a Google account's access token with. Signing in runs
// the real CLI in the helper, against tests/support/fake-signin.mjs.

const lonca = new Lonca({ port: 48523, instance: 'gemini-test', firstWorkspacePort: 49000 });
let mock: MockLlm;
let fixture: string;
let project: Project;
let workspace: Workspace;

const ACCESS = 'ya29.gemini-test-access-not-real';
const REFRESH = '1//gemini-test-refresh-not-real';
// Made up, as the CLI's own client isn't kept in Lonca.
const CLIENT = { client_id: 'made-up-client.apps.googleusercontent.com', client_secret: 'made-up-client-secret' };
const RENEWED = 'ya29.gemini-test-renewed-not-real';
const KEY = `AIza${'GeminiTestKeyNotReal'.padEnd(35, 'x')}`;
const PRO = 'gemini-3.1-pro-preview';
const FLASH = 'gemini-3.5-flash';

// Google's token endpoint, as far as renewing goes. Holding keeps its answers until they're released.
const renewals: URLSearchParams[] = [];
let tokenAnswer: 'renew' | 'refuse' | 'hold' = 'renew';
const held: (() => void)[] = [];
const tokenServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    renewals.push(new URLSearchParams(body));
    const reply = (renew: boolean) => {
      res.writeHead(renew ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(renew
        ? { access_token: RENEWED, expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/cloud-platform' }
        : { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    };
    if (tokenAnswer === 'hold') held.push(() => reply(true));
    else reply(tokenAnswer === 'renew');
  });
});
/** Answers what was held, renewing. */
function releaseRenewals(): void {
  tokenAnswer = 'renew';
  for (const answer of held.splice(0)) answer();
}

const state = () => lonca.api<AppState>('GET', '/state');
const send = (id: string, text: string, attachments: Attachment[] = []) => lonca.api<UserItem>('POST', `/sessions/${id}/messages`, { text, attachments });
const notices = (items: ChatItem[]) => items.filter((item): item is NoticeItem => item.type === 'notice');
const tools = (items: ChatItem[]) => items.filter((item): item is ToolItem => item.type === 'tool');
const forProxy = (name: string) => path.join(lonca.home, 'boundary', name);
const generated = (since: number) => mock.requests.slice(since).filter((request) => /:streamGenerateContent$/.test(request.path));
/** What the CLI told the model about itself in a Code Assist request: its own instructions, then Lonca's. */
const instructions = (body: string) => (JSON.parse(body).request.systemInstruction.parts as { text: string }[]).map((part) => part.text).join('\n');

/** Uploads a file, as the composer does. */
async function attach(name: string, content: string): Promise<Attachment> {
  const reply = await fetch(`${lonca.url}/api/workspaces/${workspace.id}/attachments?name=${name}`, {
    method: 'POST', headers: { ...lonca.headers, 'content-type': 'text/plain' }, body: content,
  });
  return await reply.json() as Attachment;
}

/** What signing in with Google leaves on this computer, without the sign-in, which comes later. */
async function signInWithGoogle(fields: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(lonca.home, 'helper-credentials', 'gemini');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'tester@example.com' })).toString('base64url')}.y`;
  fs.writeFileSync(path.join(dir, 'login.json'), JSON.stringify({
    kind: 'google', access_token: ACCESS, refresh_token: REFRESH, expiry_date: Date.now() + 3600e3, id_token: idToken, token_type: 'Bearer', ...CLIENT, ...fields,
  }), { mode: 0o600 });
  await lonca.api('POST', '/agents/refresh');
}

async function conversation(options: Record<string, unknown> = {}): Promise<Session> {
  return lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'gemini', model: PRO, effort: 'low', ...options });
}

beforeAll(async () => {
  mock = await startMockLlm();
  await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  fixture = makeFixtureRepo();
  lonca.env = { GEMINI_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token` };
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: {
      network: 'host',
      env: { CODE_ASSIST_ENDPOINT: `http://host.docker.internal:${mock.port}`, GOOGLE_GEMINI_BASE_URL: `http://host.docker.internal:${mock.port}` },
    },
  });
  await until('sign-in status', async () => (await state()).system.agentsChecked, 120000);
  await signInWithGoogle();
  const created = await lonca.api<{ workspace: Workspace }>('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(created.workspace.id);
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  tokenServer.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('a Gemini conversation on a Google account', () => {
  let session: Session;
  let first: string;

  it('answers, runs a command and carries on in the same conversation, with only a placeholder', async () => {
    session = await conversation();
    const before = mock.requests.length;
    await send(session.id, 'Please RUN: echo hello from gemini');
    const items = await lonca.waitForIdle(session.id);
    expect(items.filter((item) => item.type !== 'user').map((item) => item.type)).toEqual(['text', 'tool', 'text', 'result']);
    expect(tools(items)[0]).toMatchObject({ kind: 'command', status: 'done', detail: 'echo hello from gemini', output: 'hello from gemini' });
    expect(items.at(-1)).toMatchObject({ type: 'result', failed: false });
    first = (await lonca.session(session.id)).resumeId!;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    const requests = mock.requests.slice(before);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.auth).toBe('Bearer goog-lonca-placeholder');
    const turn = JSON.parse(generated(before)[0].body);
    // Lonca's instructions come after the CLI's own, and only the thinking level is changed.
    expect(instructions(generated(before)[0].body)).toContain(`You are working in Lonca workspace "${workspace.name}"`);
    expect(turn.request.generationConfig).toEqual({ temperature: 1, topP: 0.95, topK: 64, thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } });
    expect(turn.model).toBe(PRO);

    await send(session.id, 'And a follow-up');
    const after = await lonca.waitForIdle(session.id);
    expect((await lonca.session(session.id)).resumeId).toBe(first);
    expect(after.at(-2)).toMatchObject({ type: 'text', text: 'Mock Gemini here. You said: And a follow-up' });
    expect(notices(after)).toEqual([]);
  });

  it('keeps its conversation through a rebuild of the workspace', async () => {
    await lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
    workspace = await lonca.waitForWorkspace(workspace.id);
    const before = mock.requests.length;
    await send(session.id, 'After the rebuild');
    const items = await lonca.waitForIdle(session.id);
    expect((await lonca.session(session.id)).resumeId).toBe(first);
    expect(notices(items)).toEqual([]);
    // The CLI sends the conversation so far, which it read from where it kept it.
    expect(generated(before)[0].body).toContain('And a follow-up');
  });

  it('starts afresh with the message when the CLI has lost the conversation', async () => {
    const kept = path.join(lonca.home, 'agent-state', workspace.id, 'gemini-chats');
    for (const name of fs.readdirSync(kept)) fs.rmSync(path.join(kept, name), { recursive: true, force: true });
    await send(session.id, 'Where were we?');
    const items = await lonca.waitForIdle(session.id);
    expect(notices(items).map((notice) => notice.text)).toContain('The earlier part of this conversation couldn’t be loaded, so the agent started a new one with your message.');
    const now = await lonca.session(session.id);
    expect(now.resumeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(now.resumeId).not.toBe(first);
    expect(now.lastOutcome).toBe('completed');
  });

  it('reads an attachment from a copy it may read, as git ignores the original', async () => {
    const attachment = await attach('notes.txt', 'attached words for gemini');
    // Kept with its conversation, where a rebuild keeps it, at the same path here and in the VM.
    const copy = path.join(lonca.home, 'agent-state', workspace.id, 'gemini-attachments', session.id, ...attachment.path.split('/').slice(-2));
    const before = mock.requests.length;
    await send(session.id, `READ: ${copy}`, [attachment]);
    const items = await lonca.waitForIdle(session.id);
    expect(tools(items).at(-1)).toMatchObject({ kind: 'read', status: 'done', detail: copy });
    const [asked, answered] = generated(before);
    expect(asked.body).toContain(`The user has attached these files. Read them before proceeding:\\n- ${copy}`);
    expect(answered.body).toContain('attached words for gemini');
    expect(fs.readFileSync(copy, 'utf8')).toBe('attached words for gemini');
  });
});

describe('what a Gemini conversation refers to, through a rebuild', () => {
  // A rebuild replaces the VM, where the CLI's home is, and keeps the conversation, which names
  // files the CLI was given or wrote there.
  let talk: Session;
  let resumeId: string | null | undefined;
  let copy: string;
  // Where the CLI tells it to keep notes for every project and on this one, which it's given on
  // every turn.
  const notes = { '.gemini/GEMINI.md': 'Remember the word turquoise.', '.gemini/tmp/workspace/memory/MEMORY.md': 'Remember the word vermilion.' };
  const given = async () => {
    const before = mock.requests.length;
    await send(talk.id, 'What did you note?');
    await lonca.waitForIdle(talk.id);
    return instructions(generated(before)[0].body);
  };

  it('is an attachment it read and notes it wrote, before the rebuild', async () => {
    talk = await conversation();
    const before = mock.requests.length;
    await send(talk.id, 'Here is a file', [await attach('kept.txt', 'words kept through a rebuild')]);
    await lonca.waitForIdle(talk.id);
    // Wherever the prompt said its copy is.
    copy = /Read them before proceeding:\\n- (.+?)\\n/.exec(generated(before)[0].body)![1];
    await send(talk.id, `READ: ${copy}`);
    expect(tools(await lonca.waitForIdle(talk.id)).at(-1)).toMatchObject({ kind: 'read', status: 'done', detail: copy });
    for (const [file, note] of Object.entries(notes)) {
      await send(talk.id, `WRITE: /var/tmp/lonca/gemini/${talk.id}/${file} ${note}`);
      expect(tools(await lonca.waitForIdle(talk.id)).at(-1)).toMatchObject({ kind: 'edit', status: 'done' });
    }
    const instructed = await given();
    for (const note of Object.values(notes)) expect(instructed).toContain(note);

    resumeId = (await lonca.session(talk.id)).resumeId;
    await lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
    workspace = await lonca.waitForWorkspace(workspace.id);
  });

  it('reads the attachment again after the rebuild', async () => {
    const before = mock.requests.length;
    await send(talk.id, `READ: ${copy}`);
    const items = await lonca.waitForIdle(talk.id);
    expect((await lonca.session(talk.id)).resumeId).toBe(resumeId);
    expect(tools(items).at(-1)).toMatchObject({ kind: 'read', status: 'done', detail: copy });
    expect(generated(before)[1].body).toContain('words kept through a rebuild');
  });

  it('is given its notes again', async () => {
    const instructed = await given();
    for (const note of Object.values(notes)) expect(instructed).toContain(note);
  });

  it('keeps a note it changed with a command that puts a file in place of the link, through a rebuild straight after', async () => {
    const file = `/var/tmp/lonca/gemini/${talk.id}/.gemini/GEMINI.md`;
    await send(talk.id, `RUN: sed -i s/turquoise/teal/ ${file} && test ! -L ${file} && echo replaced`);
    expect(tools(await lonca.waitForIdle(talk.id)).at(-1)).toMatchObject({ kind: 'command', status: 'done', output: 'replaced' });
    await lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
    workspace = await lonca.waitForWorkspace(workspace.id);
    const instructed = await given();
    expect(instructed).toContain('Remember the word teal.');
    expect(instructed).not.toContain('turquoise');
  });
});

describe('a checkout’s own Gemini settings', () => {
  it('can’t ask the CLI for a sandbox of its own, as the VM is one', async () => {
    const own = path.join(workspace.path, '.gemini');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'settings.json'), JSON.stringify({ tools: { sandbox: true } }));
    fs.writeFileSync(path.join(own, '.env'), 'GEMINI_SANDBOX=true\n');
    try {
      const session = await conversation();
      await send(session.id, 'In a sandbox?');
      const items = await lonca.waitForIdle(session.id);
      expect(notices(items).filter((notice) => notice.level === 'error')).toEqual([]);
      expect(items.at(-1)).toMatchObject({ type: 'result', failed: false });
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('the settings a checkout can’t change', () => {
  const current = () => sandboxExec(workspace.sandboxName, 'stat -c "%U %a" /etc/gemini-cli/settings.json && cat /etc/gemini-cli/settings.json').output;

  it('are put back before a turn when they’ve changed, and a turn other than a Lead’s that can’t have them goes ahead, saying so', async () => {
    const sudo = asRoot(workspace.sandboxName, 'command -v sudo').trim();
    try {
      asRoot(workspace.sandboxName, 'echo {} > /etc/gemini-cli/settings.json');
      let session = await conversation();
      await send(session.id, 'Settings changed');
      let items = await lonca.waitForIdle(session.id);
      expect(notices(items).filter((notice) => notice.level !== 'info')).toEqual([]);
      const [owner, content] = current().split('\n');
      expect(owner).toBe('root 644');
      expect(JSON.parse(content).mcp).toEqual({ excluded: ['lonca'] });

      // Without sudo nothing can put them back, and a turn that isn't a Lead's goes ahead, saying so.
      asRoot(workspace.sandboxName, `rm -f /etc/gemini-cli/settings.json && mv ${sudo} ${sudo}.away`);
      session = await conversation();
      await send(session.id, 'Settings gone');
      items = await lonca.waitForIdle(session.id);
      expect(notices(items).find((notice) => notice.level === 'warning')?.text).toContain('Lonca couldn’t put the Gemini settings that a checkout can’t change in place');
      expect(items.at(-1)).toMatchObject({ type: 'result', failed: false });
    } finally {
      asRoot(workspace.sandboxName, `[ ! -e ${sudo}.away ] || mv -f ${sudo}.away ${sudo}`);
    }
    // And with it back, the next turn puts them back.
    const session = await conversation();
    await send(session.id, 'Settings back');
    expect(notices(await lonca.waitForIdle(session.id)).filter((notice) => notice.level !== 'info')).toEqual([]);
    expect(current().split('\n')[0]).toBe('root 644');
  });

  it('count as missing where the CLI wouldn’t trust them, as under a directory others can change', async () => {
    try {
      // The file and its own directory are as they should be. The CLI skips them anyway.
      asRoot(workspace.sandboxName, 'chmod g+w /etc');
      expect(current().split('\n')[0]).toBe('root 644');
      const session = await conversation();
      await send(session.id, 'Under an insecure /etc');
      const items = await lonca.waitForIdle(session.id);
      expect(notices(items).find((notice) => notice.level === 'warning')?.text).toContain('Lonca couldn’t put the Gemini settings that a checkout can’t change in place');
    } finally {
      asRoot(workspace.sandboxName, 'chmod g-w /etc');
    }
  });

  it('keep a Lead from running without them, saying why and what fixes it', async () => {
    const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, { agent: 'gemini', model: PRO, effort: 'low' });
    const leadWorkspace = await lonca.waitForWorkspace(created.workspace.id);
    const lead = created.session;
    const sudo = asRoot(leadWorkspace.sandboxName, 'command -v sudo').trim();
    try {
      asRoot(leadWorkspace.sandboxName, `rm -f /etc/gemini-cli/settings.json && mv ${sudo} ${sudo}.away`);
      const before = mock.requests.length;
      await send(lead.id, 'TOOL: team_status {}');
      const items = await lonca.waitForIdle(lead.id);
      const error = notices(items).find((notice) => notice.level === 'error');
      expect(error?.text).toContain('This Lead can’t run on Gemini here');
      expect(error?.text).toContain('Rebuild the workspace');
      // Its CLI never started, so a checkout's own server couldn't stand in for Lonca's tools.
      expect(generated(before)).toEqual([]);
      expect(tools(items)).toEqual([]);
    } finally {
      asRoot(leadWorkspace.sandboxName, `[ ! -e ${sudo}.away ] || mv -f ${sudo}.away ${sudo}`);
      await lonca.api('DELETE', `/workspaces/${leadWorkspace.id}`);
    }
  });
});

describe('a Gemini API key', () => {
  let keyed: Profile;

  it('runs on the Gemini API, with a placeholder of its own', async () => {
    keyed = await lonca.api<Profile>('POST', '/profiles', { agent: 'gemini', name: 'key', firstName: 'account' });
    await expect(lonca.api('PUT', `/profiles/${keyed.id}/key`, { key: 'sk-not-a-gemini-key' })).rejects.toThrow(/isn’t a Gemini API key/);
    await lonca.api('PUT', `/profiles/${keyed.id}/key`, { key: KEY });
    // In the file for a key, which the proxy only reads for the Gemini API's host.
    expect(fs.readFileSync(forProxy(`${keyed.id}.key`), 'utf8')).toBe(KEY);
    expect(fs.existsSync(forProxy(keyed.id))).toBe(false);
    expect((await state()).system.profiles[keyed.id]).toMatchObject({ signedIn: true, usesKey: true, summary: `Using an API key ending in ${KEY.slice(-4)}` });
    const session = await conversation({ model: FLASH, effort: 'medium', profileId: keyed.id });
    const before = mock.requests.length;
    await send(session.id, 'Hello over a key');
    const items = await lonca.waitForIdle(session.id);
    expect(items.at(-2)).toMatchObject({ type: 'text', text: 'Mock Gemini here. You said: Hello over a key' });
    const placeholder = `goog-key-lonca-profile-${keyed.id.slice('gemini-'.length)}-placeholder`;
    const requests = generated(before);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.path).toMatch(/^\/v1beta\/models\/[\w.-]+:streamGenerateContent$/);
      expect(request.auth).toBe(placeholder);
      expect(JSON.parse(request.body).generationConfig.thinkingConfig.thinkingLevel).toBe('MEDIUM');
    }
  });

  it('reaches its daily quota as a usage limit, which ends when it can’t say', async () => {
    const session = await conversation({ model: FLASH, profileId: keyed.id });
    mock.limited.add(FLASH).add('gemini-3.8-flash');
    try {
      await send(session.id, 'Use up the day');
      const items = await lonca.waitForIdle(session.id);
      expect(notices(items).find((notice) => notice.code === 'limit')).toMatchObject({ profileId: keyed.id, text: expect.stringContaining('daily quota') });
      const now = await lonca.session(session.id);
      expect(now).toMatchObject({ lastOutcome: 'limit', limitProfileId: keyed.id });
      expect(now.limitResetsAt).toBeUndefined();
    } finally {
      mock.limited.clear();
    }
  });
});

describe('a Google account at its usage limit', () => {
  it('ends the turn as a limit with when it resets, rather than waiting most of a day', async () => {
    const session = await conversation();
    mock.limited.add(PRO);
    const started = Date.now();
    try {
      await send(session.id, 'Use up the capacity');
      const items = await lonca.waitForIdle(session.id, 60000);
      expect(Date.now() - started).toBeLessThan(60000);
      const limit = notices(items).find((notice) => notice.code === 'limit');
      expect(limit).toMatchObject({ profileId: 'gemini', text: expect.stringContaining('exhausted your capacity') });
      expect(notices(items).map((notice) => notice.text).join('\n')).not.toContain('Operation cancelled');
      const resets = started + ((19 * 60 + 14) * 60 + 47) * 1000;
      const now = await lonca.session(session.id);
      expect(now.lastOutcome).toBe('limit');
      expect(Math.abs(now.limitResetsAt! - resets)).toBeLessThan(120000);
      expect((await state()).system.profiles.gemini.limitedAt).toBeGreaterThanOrEqual(started);
      // Nothing is left waiting in the VM.
      expect(sandboxExec(workspace.sandboxName, 'pgrep -f "[g]emini --output-format" || true').output).toBe('');
    } finally {
      mock.limited.clear();
    }
  });

  it('leaves nothing the CLI was running, such as an MCP server that won’t stop, what it started, as root too, or what it starts as the CLI ends', async () => {
    const own = path.join(workspace.path, '.gemini');
    fs.mkdirSync(own, { recursive: true });
    // Answers as an MCP server does, but ignores being stopped, by a signal or by its input ending.
    fs.writeFileSync(path.join(own, 'stubborn.py'), [
      'import json, signal, subprocess, sys, time',
      'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
      'signal.signal(signal.SIGHUP, signal.SIG_IGN)',
      'subprocess.Popen(["sh", "-c", "trap \'\' TERM HUP; exec sleep 617"])',
      // Which this user may not signal.
      'subprocess.Popen(["sudo", "-n", "sh", "-c", "trap \'\' TERM HUP; exec sleep 618"])',
      'for line in sys.stdin:',
      '    message = json.loads(line)',
      '    if "id" not in message:',
      '        continue',
      '    method = message.get("method")',
      '    result = {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "stubborn", "version": "1"}} if method == "initialize" else {"tools": []} if method == "tools/list" else {}',
      '    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)',
      // Its input has ended, as it does when the CLI is going, and it starts another.
      'subprocess.Popen(["sh", "-c", "trap \'\' TERM HUP; exec sleep 619"])',
      'while True:',
      '    time.sleep(617)',
    ].join('\n'));
    fs.writeFileSync(path.join(own, 'settings.json'), JSON.stringify({ mcpServers: { stubborn: { command: 'python3', args: [path.join(own, 'stubborn.py')] } } }));
    const left = () => sandboxExec(workspace.sandboxName, 'pgrep -f "[s]tubborn.py|[s]leep 61[789]" || true').output;
    const session = await conversation();
    mock.limited.add(PRO);
    try {
      await send(session.id, 'Use up the capacity, with a server');
      const items = await lonca.waitForIdle(session.id, 60000);
      // Reported as the limit, whatever ending them took.
      expect(notices(items).find((notice) => notice.code === 'limit')).toMatchObject({ profileId: 'gemini' });
      expect((await lonca.session(session.id)).lastOutcome).toBe('limit');
      expect(left()).toBe('');
    } finally {
      mock.limited.clear();
      asRoot(workspace.sandboxName, 'pkill -KILL -f "[s]tubborn.py|[s]leep 61[789]"; true');
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('a Gemini Lead', () => {
  it('uses Lonca’s tools, has no sub-agents of its own, and starts a Gemini agent', async () => {
    await lonca.api('POST', '/profiles/gemini/logout');
    await signInWithGoogle();
    const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, { agent: 'gemini', model: PRO, effort: 'high' });
    const leadWorkspace = await lonca.waitForWorkspace(created.workspace.id);
    const lead = created.session;
    expect(lead).toMatchObject({ role: 'lead', agent: 'gemini' });
    const before = mock.requests.length;
    const spawn = { label: 'Helper', model: FLASH, job: 'analyze', task: 'Say what you see' };
    await send(lead.id, `TOOL: team_status {}\nTOOL: spawn_agent ${JSON.stringify(spawn)}`);
    const agent = await until('the agent to finish', async () => {
      const found = (await state()).sessions.find((entry) => entry.workspaceId === leadWorkspace.id && entry.role === 'agent');
      return found && found.status === 'idle' && found.lastOutcome ? found : null;
    }, 150000);
    expect(agent).toMatchObject({ agent: 'gemini', model: FLASH, profileId: 'gemini', lastOutcome: 'completed' });
    const leadItems = await lonca.items(lead.id);
    expect(tools(leadItems).slice(0, 2)).toMatchObject([
      { kind: 'team', title: 'Checked on the agents', status: 'done' },
      { kind: 'team', title: 'Started Helper', status: 'done' },
    ]);
    const leadTurn = JSON.parse(generated(before).find((request) => request.body.includes('TOOL: team_status'))!.body);
    const offered = leadTurn.request.tools.flatMap((tool: { functionDeclarations?: { name: string }[] }) => (tool.functionDeclarations ?? []).map((declaration) => declaration.name));
    expect(offered).toContain('mcp_lonca_spawn_agent');
    expect(offered).not.toContain('invoke_agent');
    expect(instructions(JSON.stringify(leadTurn))).toContain('You are the Lead of this Lonca workspace');
    // The Lead's own requests quote the task too.
    const agentTurn = generated(before).find((request) => request.body.includes('Say what you see') && !request.body.includes('TOOL: team_status'))!;
    expect(instructions(agentTurn.body)).toContain('You work for the Lead of this workspace');
    expect(instructions(agentTurn.body)).not.toContain('You are the Lead of this Lonca workspace');
    // Its agents' conversations are kept apart from its own, in homes of their own.
    expect(sandboxExec(leadWorkspace.sandboxName, `test -d /var/tmp/lonca/gemini/${lead.id}/.gemini && test -d /var/tmp/lonca/gemini/${agent.id}/.gemini`).code).toBe(0);
  });

  it('keeps Lonca’s tools when the checkout names a server of its own after them, which nothing then starts', async () => {
    const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, { agent: 'gemini', model: PRO, effort: 'low' });
    const forgedWorkspace = await lonca.waitForWorkspace(created.workspace.id);
    const lead = created.session;
    // A checkout's settings come before the user's, and its .env fills in what a process doesn't have.
    const started = '/tmp/forged-lonca-started';
    fs.mkdirSync(path.join(forgedWorkspace.path, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(forgedWorkspace.path, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { lonca: { command: 'sh', args: ['-c', `touch ${started}; sleep 600`] } },
      mcp: { excluded: [] },
    }));
    fs.writeFileSync(path.join(forgedWorkspace.path, '.gemini', '.env'), 'LONCA_RUN_DIR=/tmp/forged-run\n');
    try {
      const before = mock.requests.length;
      await send(lead.id, 'TOOL: team_status {}');
      const items = await lonca.waitForIdle(lead.id);
      expect(tools(items)[0]).toMatchObject({ kind: 'team', title: 'Checked on the agents', status: 'done' });
      const leadTurn = JSON.parse(generated(before)[0].body);
      const offered = (turn: { request: { tools?: { functionDeclarations?: { name: string }[] }[] } }) =>
        (turn.request.tools ?? []).flatMap((tool) => (tool.functionDeclarations ?? []).map((declaration) => declaration.name));
      expect(offered(leadTurn)).toContain('mcp_lonca_team_status');

      // Any other conversation, as an agent of its own would be, starts neither.
      const other = await lonca.api<Session>('POST', `/workspaces/${forgedWorkspace.id}/sessions`, { agent: 'gemini', model: FLASH, effort: 'low' });
      const since = mock.requests.length;
      await send(other.id, 'Which tools have you got?');
      expect((await lonca.waitForIdle(other.id)).at(-1)).toMatchObject({ type: 'result', failed: false });
      expect(offered(JSON.parse(generated(since)[0].body)).filter((name) => name.startsWith('mcp_lonca_'))).toEqual([]);
      expect(sandboxExec(forgedWorkspace.sandboxName, `test -e ${started}`).code).not.toBe(0);
    } finally {
      await lonca.api('DELETE', `/workspaces/${forgedWorkspace.id}`);
    }
  });
});

describe('a workspace made before Lonca could run Gemini', () => {
  it('says to rebuild it to use Gemini', async () => {
    const session = await conversation();
    asRoot(workspace.sandboxName, 'mv /usr/local/bin/gemini /usr/local/bin/gemini.gone');
    try {
      await send(session.id, 'Hello?');
      const items = await lonca.waitForIdle(session.id);
      expect(notices(items).at(-1)?.text).toContain('Rebuild the workspace from its ⋯ menu to use Gemini');
      expect((await lonca.session(session.id)).lastOutcome).toBe('failed');
    } finally {
      asRoot(workspace.sandboxName, 'mv /usr/local/bin/gemini.gone /usr/local/bin/gemini');
    }
  });
});

describe('a Google account’s access token', () => {
  it('is renewed on this computer when it runs out, and the turn carries on with the new one', async () => {
    renewals.length = 0;
    tokenAnswer = 'renew';
    await signInWithGoogle({ expiry_date: Date.now() - 60e3 });
    await until('the renewal', () => fs.readFileSync(forProxy('gemini'), 'utf8') === RENEWED, 30000);
    expect(Object.fromEntries(renewals[0])).toEqual({ grant_type: 'refresh_token', refresh_token: REFRESH, ...CLIENT });
    const saved = JSON.parse(fs.readFileSync(path.join(lonca.home, 'helper-credentials', 'gemini', 'login.json'), 'utf8'));
    expect(saved).toMatchObject({ kind: 'google', access_token: RENEWED, refresh_token: REFRESH });
    expect(saved.expiry_date).toBeGreaterThan(Date.now() + 3000e3);
    const session = await conversation();
    await send(session.id, 'After renewing');
    expect((await lonca.waitForIdle(session.id)).at(-1)).toMatchObject({ type: 'result', failed: false });
  });

  it('asks to sign in again once Google won’t renew it', async () => {
    tokenAnswer = 'refuse';
    await signInWithGoogle({ expiry_date: Date.now() - 60e3 });
    await until('the refusal', async () => (await state()).system.profiles.gemini.rejected, 30000);
    expect((await state()).system.profiles.gemini.signedIn).toBe(true);
    tokenAnswer = 'renew';
  });

  it('counts a refusal of one that should have worked', async () => {
    await lonca.api('POST', '/profiles/gemini/logout');
    await signInWithGoogle();
    // A moment later, so the turn can't have had any other.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const session = await conversation();
    mock.refuseGemini = true;
    try {
      await send(session.id, 'Refuse me');
      const items = await lonca.waitForIdle(session.id);
      expect(notices(items).find((notice) => notice.code === 'auth')).toMatchObject({
        profileId: 'gemini', text: expect.stringContaining('invalid authentication credentials'),
      });
      await until('the sign-in to be marked', async () => (await state()).system.profiles.gemini.rejected, 30000);
    } finally {
      mock.refuseGemini = false;
    }
  });
});

describe('signing in with a Google account, in the helper', () => {
  const tools = () => `${lonca.prefix}-tools`;
  const login = async (profileId = 'gemini'): Promise<LoginState | undefined> => (await state()).logins[profileId];
  const reached = (phase: LoginPhase, timeout = 60000, profileId = 'gemini') => until(`the sign-in to reach ${phase}`, async () => {
    const current = await login(profileId);
    if (current?.phase === 'failed' && phase !== 'failed') throw new Error(`failed: ${current.failure} ${current.message ?? ''}\n${current.output}`);
    return current?.phase === phase ? current : null;
  }, timeout);
  /** What a browser is sent to when the sign-in page is done with it. */
  const comeBack = (link: string, query = 'code=fakecode') => {
    const url = new URL(link);
    return `${url.searchParams.get('redirect_uri')}?${query}&state=${url.searchParams.get('state')}`;
  };
  const withCode = async (code = '4/fakecode', profileId = 'gemini') => {
    await lonca.api('POST', `/profiles/${profileId}/login`, { method: 'code' });
    const waiting = await reached('waiting', 60000, profileId);
    await lonca.api('POST', `/profiles/${profileId}/login/code`, { code });
    return waiting;
  };
  /** Finishing is reported before what it left in the helper has gone. */
  const helperHoldsNoLogin = () => until('the helper to hold no login', () => {
    const found = sandboxExec(tools(), `pgrep -f '[g]emini.js --list-sessions'; find /var/tmp/lonca/tty ~/.gemini -name 'login-gemini-*' -o -name oauth_creds.json 2>/dev/null`);
    return found.output === '';
  }, 20000);
  const loginFile = (profileId = 'gemini') => path.join(lonca.home, 'helper-credentials', profileId, 'login.json');
  const signedIn = async () => (await state()).system.profiles.gemini.signedIn;

  beforeAll(async () => {
    await lonca.api('POST', '/profiles/gemini/logout');
    await lonca.startHelper();
    installFakeSignIn(tools());
  });

  afterAll(() => {
    removeFakeSignIn(tools());
  });

  it('signs in through the browser, renewed here once with the CLI’s own client, for the proxy to use and out of reach of workspaces', async () => {
    setFakeSignIn(tools(), { mode: 'ok' });
    renewals.length = 0;
    await lonca.api('POST', '/profiles/gemini/login');
    const waiting = await reached('waiting');
    expect(new URL(waiting.url!).hostname).toBe('accounts.google.com');
    // Choosing the account, and so that Google gives a refresh token to one that has let the CLI in before.
    expect(new URL(waiting.url!).searchParams.get('prompt')).toBe('select_account consent');
    const back = comeBack(waiting.url!);
    expect(back).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback\?/);
    // Only the sign-in page knows the state, so nothing else reaches the CLI.
    expect((await fetch(`${new URL(back).origin}/oauth2callback?code=fakecode&state=wrong`)).status).toBe(404);
    expect((await login())?.phase).toBe('waiting');

    const answer = await fetch(back);
    expect(await answer.text()).toContain('You’re signed in');
    expect(await login()).toMatchObject({ phase: 'done' });
    expect((await login())?.needsProject).toBeUndefined();
    expect((await state()).system.profiles.gemini).toMatchObject({ signedIn: true, summary: 'Signed in with Google as probe@example.com', usesKey: false });
    await helperHoldsNoLogin();
    await expect(fetch(back)).rejects.toThrow();

    // Renewed with the client the CLI signed in with, which only the CLI in the helper had.
    const client = JSON.parse(sandboxExec(tools(), 'cat /tmp/fake-signin/google-client.json').output);
    expect(client.client_id).toBe(new URL(waiting.url!).searchParams.get('client_id'));
    expect(client.client_secret).toBeTruthy();
    expect(renewals.map((form) => Object.fromEntries(form))).toEqual([{ grant_type: 'refresh_token', refresh_token: '1//fake-refresh-from-signing-in', ...client }]);
    const saved = JSON.parse(fs.readFileSync(loginFile(), 'utf8'));
    expect(saved).toMatchObject({ kind: 'google', access_token: RENEWED, refresh_token: '1//fake-refresh-from-signing-in', ...client });
    expect(fs.statSync(loginFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(forProxy('gemini'), 'utf8')).toBe(RENEWED);
    const inWorkspace = sandboxExec(workspace.sandboxName, 'cat ~/.gemini/oauth_creds.json 2>/dev/null; env').output;
    for (const secret of [RENEWED, 'fake-access-from-signing-in', 'fake-refresh-from-signing-in', client.client_secret]) {
      expect(inWorkspace).not.toContain(secret);
      expect(JSON.stringify(await state())).not.toContain(secret);
    }

    // Starting another sign-in and cancelling it must not sign out.
    await lonca.api('POST', '/profiles/gemini/login');
    await reached('waiting');
    await lonca.api('DELETE', '/profiles/gemini/login');
    await helperHoldsNoLogin();
    expect(fs.readFileSync(forProxy('gemini'), 'utf8')).toBe(RENEWED);
    expect(await signedIn()).toBe(true);
  });

  it('signs in with a code pasted here, for a browser that can’t come back', async () => {
    await lonca.api('POST', '/profiles/gemini/logout');
    await lonca.api('POST', '/profiles/gemini/login', { method: 'code' });
    const waiting = await reached('waiting');
    expect(waiting.url).toBeUndefined();
    const page = new URL(waiting.pasteUrl!);
    expect(page.hostname).toBe('accounts.google.com');
    expect(page.searchParams.get('redirect_uri')).toBe('https://codeassist.google.com/authcode');
    expect(page.searchParams.get('prompt')).toBe('select_account consent');
    await expect(lonca.api('POST', '/profiles/gemini/login/code', { code: KEY })).rejects.toThrow(/a key, not a sign-in code/);
    await lonca.api('POST', '/profiles/gemini/login/code', { code: '4/fakecode' });
    await reached('done');
    expect((await state()).system.profiles.gemini).toMatchObject({ signedIn: true, summary: 'Signed in with Google as probe@example.com' });
    expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8')).access_token).toBe(RENEWED);
    await helperHoldsNoLogin();
    await lonca.api('DELETE', '/profiles/gemini/login');
  });

  it('says when Google turns the sign-in down, either way, and leaves nobody signed in', async () => {
    await lonca.api('POST', '/profiles/gemini/logout');
    setFakeSignIn(tools(), { mode: 'rejected' });
    await withCode('4/wrongcode');
    expect(await reached('failed')).toMatchObject({ failure: 'rejected' });
    await helperHoldsNoLogin();

    await lonca.api('POST', '/profiles/gemini/login');
    let waiting = await reached('waiting');
    expect(await (await fetch(comeBack(waiting.url!))).text()).toContain('didn’t finish');
    expect(await login()).toMatchObject({ phase: 'failed', failure: 'rejected' });

    setFakeSignIn(tools(), { mode: 'ok' });
    await lonca.api('POST', '/profiles/gemini/login');
    waiting = await reached('waiting');
    expect(await (await fetch(comeBack(waiting.url!, 'error=access_denied'))).text()).toContain('didn’t finish');
    expect(await login()).toMatchObject({ phase: 'failed', failure: 'denied' });
    await helperHoldsNoLogin();
    expect(await signedIn()).toBe(false);
    expect(fs.existsSync(loginFile())).toBe(false);
    await lonca.api('DELETE', '/profiles/gemini/login');
  });

  it('keeps the sign-in of an account whose turns need a Google Cloud project, and says so', async () => {
    setFakeSignIn(tools(), { mode: 'project' });
    await withCode();
    expect(await reached('done')).toMatchObject({ needsProject: true });
    expect(await signedIn()).toBe(true);
    // Kept with the login, for Settings to say after the sign-in's gone.
    expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8')).needs_project).toBe(true);
    expect((await state()).system.profiles.gemini).toMatchObject({ needsProject: true });
    await lonca.api('DELETE', '/profiles/gemini/login');
    await lonca.api('POST', '/profiles/gemini/logout');
  });

  it('turns down an account Google won’t serve, saying why', async () => {
    setFakeSignIn(tools(), { mode: 'ineligible' });
    await withCode();
    expect(await reached('failed')).toMatchObject({ failure: 'denied', message: expect.stringContaining('not currently available in your location') });
    await helperHoldsNoLogin();
    expect(await signedIn()).toBe(false);
    await lonca.api('DELETE', '/profiles/gemini/login');
    setFakeSignIn(tools(), { mode: 'ok' });
  });

  it('keeps a sign-in Google sent no ID token for, with the client from the link the CLI printed', async () => {
    setFakeSignIn(tools(), { mode: 'no-id-token' });
    renewals.length = 0;
    const waiting = await withCode();
    await reached('done');
    expect((await state()).system.profiles.gemini).toMatchObject({ signedIn: true, summary: 'Signed in with Google' });
    const client = new URL(waiting.pasteUrl!).searchParams.get('client_id');
    expect(renewals.map((form) => form.get('client_id'))).toEqual([client]);
    expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8'))).toMatchObject({ client_id: client, access_token: RENEWED });
    await helperHoldsNoLogin();
    await lonca.api('DELETE', '/profiles/gemini/login');
    await lonca.api('POST', '/profiles/gemini/logout');
    setFakeSignIn(tools(), { mode: 'ok' });
  });

  it('says so when Google gives no way to renew a sign-in, rather than that it stopped', async () => {
    setFakeSignIn(tools(), { mode: 'no-refresh' });
    renewals.length = 0;
    await withCode();
    expect(await reached('failed')).toMatchObject({ failure: 'save-failed', message: expect.stringContaining('Google didn’t give Lonca a way to renew this sign-in') });
    expect(renewals).toEqual([]);
    expect(await signedIn()).toBe(false);
    expect(fs.existsSync(loginFile())).toBe(false);
    await helperHoldsNoLogin();
    await lonca.api('DELETE', '/profiles/gemini/login');
    setFakeSignIn(tools(), { mode: 'ok' });
  });

  it('keeps nothing of a sign-in cancelled, overtaken by a key or removed while Google renews it', async () => {
    /** Signs in until Lonca is waiting for Google to renew what the CLI saved. */
    const renewing = async (profileId = 'gemini') => {
      renewals.length = 0;
      tokenAnswer = 'hold';
      await withCode('4/fakecode', profileId);
      await until('Lonca to ask Google to renew it', () => renewals.length > 0, 60000);
      expect((await login(profileId))?.phase).toBe('saving');
    };
    /** Lets Google answer, and gives the answer time to do whatever it would. */
    const answered = async () => {
      releaseRenewals();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    };
    try {
      await renewing();
      await lonca.api('DELETE', '/profiles/gemini/login');
      await lonca.api('POST', '/profiles/gemini/logout');
      await answered();
      expect(fs.existsSync(loginFile())).toBe(false);
      expect(fs.existsSync(forProxy('gemini'))).toBe(false);
      expect(await signedIn()).toBe(false);
      await helperHoldsNoLogin();

      await renewing();
      await lonca.api('PUT', '/profiles/gemini/key', { key: KEY });
      await answered();
      expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8'))).toEqual({ kind: 'key', apiKey: KEY });
      expect(fs.readFileSync(forProxy('gemini.key'), 'utf8')).toBe(KEY);
      expect(fs.existsSync(forProxy('gemini'))).toBe(false);
      expect((await state()).system.profiles.gemini).toMatchObject({ signedIn: true, usesKey: true });
      await lonca.api('POST', '/profiles/gemini/logout');
      await helperHoldsNoLogin();

      const second = await lonca.api<Profile>('POST', '/profiles', { agent: 'gemini', name: 'second', firstName: 'first' });
      await renewing(second.id);
      await lonca.api('DELETE', `/profiles/${second.id}`);
      await answered();
      expect(fs.existsSync(path.dirname(loginFile(second.id)))).toBe(false);
      expect(fs.existsSync(forProxy(second.id))).toBe(false);
      expect((await state()).profiles.map((profile) => profile.id)).not.toContain(second.id);
      await helperHoldsNoLogin();
    } finally {
      releaseRenewals();
    }
  });

  it('fails a sign-in that Google won’t renew from here, rather than an hour later', async () => {
    tokenAnswer = 'refuse';
    try {
      await withCode();
      expect(await reached('failed')).toMatchObject({ failure: 'save-failed', message: expect.stringContaining('wouldn’t renew') });
    } finally {
      tokenAnswer = 'renew';
    }
    await helperHoldsNoLogin();
    expect(await signedIn()).toBe(false);
    expect(fs.existsSync(loginFile())).toBe(false);
    await lonca.api('DELETE', '/profiles/gemini/login');
  });
});
