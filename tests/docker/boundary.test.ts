import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, Profile, Project, Session, Workspace } from '../../shared/types.ts';
import { FAKE_SANDBOX, FAKE_SBX_DIR, Lonca, REAL_SANDBOX, docker, sandboxExec, makeFixtureRepo, sbx, until, sleep } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

// Credentials stay outside a workspace: its VM holds placeholders for the proxy to swap. The real
// proxy's swapping needs real tokens, so it was measured by hand.

const lonca = new Lonca({ port: 48431, instance: 'boundary-test', firstWorkspacePort: 53300 });
let mock: MockLlm;
let fixture: string;
let project: Project;
let workspace: Workspace;
let session: Session;

const CLAUDE = 'sk-ant-oat01-boundary-test-not-real';
const GITHUB = 'gho_boundary_test_not_real';
const CODEX = 'sk-boundary-test-not-real-key';
const REAL_VALUES = [CLAUDE, GITHUB, CODEX];

const state = () => lonca.api<AppState>('GET', '/state');
const forProxy = (name: string) => path.join(lonca.home, 'boundary', name);
const tools = () => `${lonca.prefix}-tools`;

beforeAll(async () => {
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}` } } });
  await until('sign-in status', async () => (await state()).system.agentsChecked, 120000);
  await lonca.api('PUT', '/profiles/claude/key', { key: CLAUDE });
  await lonca.api('PUT', '/secrets/github', { token: GITHUB });
  await lonca.api('PUT', '/profiles/codex/key', { key: CODEX });
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, {});
  session = created.session;
  workspace = await lonca.waitForWorkspace(created.workspace.id);
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

/** Everything a process in the VM could read: every environment and every small file. */
function readableInVm(): string {
  return sandboxExec(workspace.sandboxName, String.raw`cat /proc/[0-9]*/environ 2>/dev/null; find "$HOME" /tmp /var/tmp /var/lib/lonca -xdev -type f -size -1024k 2>/dev/null | xargs cat 2>/dev/null; true`).output;
}

/** What the proxy was told to swap in this sandbox, and on which hosts. */
function placeholdersIn(sandbox: string): { placeholder: string; targets: string[] }[] {
  if (REAL_SANDBOX) return (JSON.parse(sbx('secret', 'ls', '--sandbox', sandbox, '--json')) as { custom_secrets?: { placeholder: string; targets: string[] }[] }).custom_secrets ?? [];
  return fs.readFileSync(path.join(FAKE_SBX_DIR, 'calls.log'), 'utf8').split('\n')
    .filter((line) => line.startsWith('secret set-custom ') && line.includes(`--sandbox ${sandbox} `))
    .map((line) => ({ placeholder: /--placeholder (\S+)/.exec(line)![1], targets: [...line.matchAll(/--host (\S+)/g)].map((match) => match[1]) }));
}

async function terminalEnv(): Promise<string> {
  const created = await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
  const terminal = await lonca.openTerminal(created.id);
  terminal.send('env; echo finished-listing\n');
  await until('the listing', () => terminal.output().includes('finished-listing\r\n'));
  terminal.socket.close();
  return terminal.output();
}

describe('what a workspace can read', () => {
  it('has none of the real values, in any process or file', async () => {
    const listing = await terminalEnv();
    const scan = readableInVm();
    for (const value of REAL_VALUES) {
      expect(listing).not.toContain(value);
      expect(scan).not.toContain(value);
    }
    expect(fs.readFileSync(forProxy('claude'), 'utf8')).toBe(CLAUDE);
    expect(fs.readFileSync(forProxy('github'), 'utf8')).toBe(GITHUB);
    expect(fs.readFileSync(forProxy('codex'), 'utf8')).toBe(CODEX);
  });

  it('has nothing of the sign-ins mounted', () => {
    const listing = REAL_SANDBOX
      ? JSON.stringify((JSON.parse(sbx('ls', '--json')) as { name: string }[]).find((entry) => entry.name === workspace.sandboxName))
      : docker('inspect', workspace.sandboxName);
    expect(listing).toContain(workspace.path);
    expect(listing).not.toContain('helper-credentials');
    expect(listing).not.toContain(path.join(lonca.home, 'credentials'));
    expect(listing).not.toContain(path.join(lonca.home, 'boundary'));
  });

  it('has a placeholder for each, with Codex at the usual address for an API key', async () => {
    expect(await terminalEnv()).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-lonca-placeholder');
    expect(JSON.parse(sandboxExec(workspace.sandboxName, 'cat ~/.codex/auth.json').output)).toEqual({ OPENAI_API_KEY: 'oai-oat01-lonca-placeholder' });
    expect(sandboxExec(workspace.sandboxName, 'cat ~/.codex/config.toml').output.trim()).toBe('cli_auth_credentials_store = "file"');
  });
});

describe('what the proxy is told', () => {
  it('reads each from a file, for this sandbox alone, and never gets a value', () => {
    if (FAKE_SANDBOX) {
      const calls = fs.readFileSync(path.join(FAKE_SBX_DIR, 'calls.log'), 'utf8').split('\n').filter((line) => line.startsWith('secret ') && line.includes(workspace.sandboxName));
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const value of REAL_VALUES) expect(calls.join('\n')).not.toContain(value);
      for (const call of calls) expect(call).toContain(`--sandbox ${workspace.sandboxName} --command /bin/cat`);
    } else {
      const listed = JSON.parse(sbx('secret', 'ls', '--sandbox', workspace.sandboxName, '--json')) as { secrets?: { name: string; secret?: string }[]; custom_secrets?: { placeholder: string; targets: string[]; kind?: string; source?: string }[] };
      expect(listed.secrets?.map((entry) => entry.name)).toContain('github');
      expect(listed.custom_secrets?.map((entry) => entry.placeholder).sort()).toEqual(['oai-oat01-lonca-placeholder', 'sk-ant-oat01-lonca-placeholder']);
      expect(listed.custom_secrets?.find((entry) => entry.placeholder.startsWith('sk-ant'))?.targets).toEqual(['api.anthropic.com']);
      expect(JSON.stringify(listed)).toContain(forProxy('claude'));
      for (const value of REAL_VALUES) expect(JSON.stringify(listed)).not.toContain(value);
    }
  });

  it.runIf(REAL_SANDBOX)('keeps them to this sandbox, and they go with it', async () => {
    const global = JSON.parse(sbx('secret', 'ls', '--global', '--json')) as { secrets?: unknown[]; custom_secrets?: unknown[] };
    expect(JSON.stringify(global)).not.toContain(path.join(lonca.home, 'boundary'));
    const other = await lonca.api<{ workspace: Workspace }>('POST', `/projects/${project.id}/workspaces`, {});
    const name = (await lonca.waitForWorkspace(other.workspace.id)).sandboxName;
    expect(sbx('secret', 'ls', '--sandbox', name, '--json')).toContain('oai-oat01-lonca-placeholder');
    await lonca.api('DELETE', `/workspaces/${other.workspace.id}`);
    await until('the sandbox to go', async () => !sbx('ls', '--json').includes(name));
    expect(sbx('secret', 'ls', '--json')).not.toContain(name);
  });

  it('follows signing out and back in with nothing else to do', async () => {
    await lonca.api('PUT', '/secrets/github', { token: '' });
    expect(fs.existsSync(forProxy('github'))).toBe(false);
    await lonca.api('POST', '/profiles/codex/logout');
    expect(fs.existsSync(forProxy('codex'))).toBe(false);
    await lonca.api('PUT', '/secrets/github', { token: GITHUB });
    await lonca.api('PUT', '/profiles/codex/key', { key: CODEX });
    expect(fs.readFileSync(forProxy('github'), 'utf8')).toBe(GITHUB);
    expect(fs.readFileSync(forProxy('codex'), 'utf8')).toBe(CODEX);
  });
});

describe('another sign-in', () => {
  const SECOND = 'sk-ant-api03-boundary-test-second-not-real';
  let added: Profile;
  const placeholder = () => `sk-ant-oat01-lonca-profile-${added.id.slice('claude-'.length)}-placeholder`;

  it('reaches a workspace that’s already running, with a placeholder and file of its own', async () => {
    added = await lonca.api<Profile>('POST', '/profiles', { agent: 'claude', name: 'personal', firstName: 'work' });
    await lonca.api('PUT', `/profiles/${added.id}/key`, { key: SECOND });
    expect(fs.readFileSync(forProxy(added.id), 'utf8')).toBe(SECOND);
    await until('the running VM to have it', async () => placeholdersIn(workspace.sandboxName).some((entry) => entry.placeholder === placeholder()));
    expect(placeholdersIn(workspace.sandboxName).find((entry) => entry.placeholder === placeholder())?.targets).toEqual(['api.anthropic.com']);
  });

  it('gives a turn on it that placeholder alone, and its value to nothing in the VM', async () => {
    const conversation = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', profileId: added.id });
    const before = mock.requests.length;
    await lonca.api('POST', `/sessions/${conversation.id}/messages`, { text: 'Hello from the other sign-in' });
    await lonca.waitForIdle(conversation.id);
    const sent = mock.requests.slice(before).map((request) => request.auth);
    expect(sent.length).toBeGreaterThan(0);
    for (const auth of sent) expect(auth).toContain(placeholder());
    expect(readableInVm()).not.toContain(SECOND);
  });

  it('takes its file away when it’s removed, and leaves the first alone', async () => {
    await lonca.api('DELETE', `/profiles/${added.id}`);
    expect(fs.existsSync(forProxy(added.id))).toBe(false);
    expect(fs.readFileSync(forProxy('claude'), 'utf8')).toBe(CLAUDE);
    expect((await state()).profiles.filter((profile) => profile.agent === 'claude').map((profile) => profile.id)).toEqual(['claude']);
  });
});

describe('Codex’s sign-in, in the helper', () => {
  const base64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (exp: number, label: string) => `${base64({ alg: 'none' })}.${base64({ exp, label })}.sig`;
  const inDays = (days: number) => Math.floor(Date.now() / 1000) + days * 86400;
  const login = (access: string) => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: token(inDays(1), 'id'), access_token: access, refresh_token: 'refresh-one', account_id: 'account' }, last_refresh: new Date().toISOString() });
  // What finishing a sign-in leaves, without the sign-in.
  const signIn = (content: string) => fs.writeFileSync(path.join(lonca.home, 'helper-credentials', 'codex', 'auth.json'), content, { mode: 0o600 });
  const RENEWED = token(inDays(10), 'renewed');
  const TOKEN_SERVER = `
import http.server, json, os, time
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', '0')))
        with open('/tmp/renewals', 'a') as renewals:
            renewals.write('renewed\\n')
        if os.path.exists('/tmp/slow'):
            time.sleep(3)
        body = json.dumps({'id_token': '${token(inDays(1), 'id')}', 'access_token': '${RENEWED}', 'refresh_token': 'refresh-two'}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', 47911), Handler).serve_forever()
`;

  beforeAll(async () => {
    await lonca.api('POST', '/profiles/codex/logout');
    await lonca.kill();
    lonca.env = { CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'http://127.0.0.1:47911/oauth/token' };
    await lonca.start();
    // Starting a sign-in is what starts the helper. Its CLI has to be gone before a login appears.
    await lonca.api('POST', '/profiles/claude/login');
    await until('the helper', () => sandboxExec(tools(), 'true').code === 0, 120000);
    await lonca.api('DELETE', '/profiles/claude/login');
    fs.writeFileSync(path.join(lonca.home, 'token-server.py'), TOKEN_SERVER);
    sbx('cp', path.join(lonca.home, 'token-server.py'), `${tools()}:/tmp/token-server.py`);
    sandboxExec(tools(), 'rm -f /tmp/renewals; (nohup python3 -I /tmp/token-server.py) >/dev/null 2>&1 & sleep 1');
  });

  afterAll(async () => {
    await lonca.api('POST', '/profiles/codex/logout').catch(() => {});
    lonca.env = {};
  });

  it('leaves a sign-in with time left alone, and gives the proxy its token', async () => {
    const access = token(inDays(6), 'current');
    signIn(login(access));
    await lonca.api('POST', '/agents/refresh');
    expect(fs.readFileSync(forProxy('codex'), 'utf8')).toBe(access);
    expect(sandboxExec(tools(), 'cat /tmp/renewals 2>/dev/null').output).toBe('');
    expect((await state()).system.profiles.codex.signedIn).toBe(true);
  });

  it('renews one about to run out, and the proxy gets the new token', async () => {
    signIn(login(token(inDays(1), 'ending')));
    await lonca.api('POST', '/agents/refresh');
    expect(fs.readFileSync(forProxy('codex'), 'utf8')).toBe(RENEWED);
    // The real service turns a made-up token down, which can make the CLI renew it a second time.
    expect(sandboxExec(tools(), 'cat /tmp/renewals').output).toContain('renewed');
    const saved = JSON.parse(fs.readFileSync(path.join(lonca.home, 'helper-credentials', 'codex', 'auth.json'), 'utf8'));
    expect(saved.tokens.refresh_token).toBe('refresh-two');
    expect(sandboxExec(tools(), 'find ~/.codex /tmp /var/tmp/lonca -name auth.json 2>/dev/null').output.trim()).toBe('');
  });

  it('doesn’t let a renewal under way undo signing out', async () => {
    sandboxExec(tools(), 'touch /tmp/slow; rm -f /tmp/renewals');
    signIn(login(token(inDays(1), 'ending')));
    const refreshing = lonca.api('POST', '/agents/refresh');
    await until('the renewal to start', () => sandboxExec(tools(), 'test -s /tmp/renewals').code === 0, 30000);
    await lonca.api('POST', '/profiles/codex/logout');
    await refreshing;
    expect(fs.existsSync(path.join(lonca.home, 'helper-credentials', 'codex', 'auth.json'))).toBe(false);
    expect(fs.existsSync(forProxy('codex'))).toBe(false);
    expect((await state()).system.profiles.codex.signedIn).toBe(false);
    sandboxExec(tools(), 'rm -f /tmp/slow');
  });

  it('has nothing of the server’s mounted', () => {
    const listing = REAL_SANDBOX
      ? JSON.stringify((JSON.parse(sbx('ls', '--json')) as { name: string }[]).find((entry) => entry.name === tools()))
      : docker('inspect', tools());
    expect(listing).toContain(tools());
    for (const dir of ['helper-credentials', 'boundary', 'secrets.json']) expect(listing).not.toContain(path.join(lonca.home, dir));
  });
});

describe('a workspace from before this server started', () => {
  it('gets its secrets again, over the ones it has, before anything else happens in it', async () => {
    await lonca.kill();
    await lonca.start();
    await lonca.api('GET', `/workspaces/${workspace.id}/changes`);
    if (FAKE_SANDBOX) {
      const calls = fs.readFileSync(path.join(FAKE_SBX_DIR, 'calls.log'), 'utf8').split('\n').filter((line) => line.startsWith('secret set github') && line.includes(workspace.sandboxName));
      expect(calls.length).toBeGreaterThanOrEqual(2);
    }
    if (REAL_SANDBOX) expect(sbx('secret', 'ls', '--sandbox', workspace.sandboxName, '--json')).toContain('oai-oat01-lonca-placeholder');
  });
});

describe('moving from where Codex’s sign-in used to be', () => {
  it('takes it from the old directory', async () => {
    await lonca.api('POST', '/profiles/codex/logout');
    await lonca.kill();
    sbx('rm', '--force', tools());
    const old = path.join(lonca.home, 'credentials');
    fs.rmSync(path.join(lonca.home, 'helper-credentials'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.mkdirSync(path.join(old, 'codex'), { recursive: true });
    fs.writeFileSync(path.join(old, 'codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: CODEX }));

    await lonca.start();
    expect(fs.existsSync(path.join(old, 'codex', 'auth.json'))).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
    expect(fs.readFileSync(forProxy('codex'), 'utf8')).toBe(CODEX);
    await lonca.api('POST', '/agents/refresh');
    expect((await state()).system.profiles.codex.signedIn).toBe(true);
    await lonca.api('POST', '/profiles/codex/logout');
  });
});
