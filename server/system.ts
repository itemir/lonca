import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, AgentStatus, Catalog, LoginMethod, ModelOption, SystemStatus } from '../shared/types.ts';
import { PREFIX, paths } from './config.ts';
import { publish } from './events.ts';
import { SandboxError, buildTemplate, detectSandboxes, ensureSandbox, exec, isSandboxRunning, removeSandbox, templateLoaded, templateTag } from './sandbox.ts';
import { getSecrets, saveState, setBoundaryValue, state, writeAtomic } from './store.ts';
import { errorMessage } from './util.ts';

const LOG_LIMIT = 20000;

export const system: SystemStatus = {
  sandbox: { state: 'checking' },
  image: { tag: templateTag(), state: 'unknown', log: '' },
  agents: { claude: { signedIn: false }, codex: { signedIn: false } },
  agentsChecked: false,
};

function publishSystem(): void {
  publish({ type: 'system', system, catalog: state.catalog });
}

let checkingSandboxes: Promise<void> | null = null;
let sandboxesReadyListener: () => void = () => {};

/** Called when workspaces can run, having not been able to a moment ago. */
export function onSandboxesReady(listener: () => void): void {
  sandboxesReadyListener = listener;
}

/** Finds out whether workspaces can run. Safe to call often. */
export function checkSandboxes(): Promise<void> {
  checkingSandboxes ??= detectSandboxes().then((sandbox) => {
    const changed = JSON.stringify(sandbox) !== JSON.stringify(system.sandbox);
    const nowReady = sandbox.state === 'ready' && system.sandbox.state !== 'ready';
    system.sandbox = sandbox;
    if (changed) publishSystem();
    if (nowReady) sandboxesReadyListener();
  }).finally(() => {
    checkingSandboxes = null;
  });
  return checkingSandboxes;
}

function imageLog(): (text: string) => void {
  let lastPublish = 0;
  return (text) => {
    system.image.log = (system.image.log + text).slice(-LOG_LIMIT);
    if (Date.now() - lastPublish > 500) {
      lastPublish = Date.now();
      publishSystem();
    }
  };
}

function imageBuilding(): void {
  system.image = { tag: templateTag(), state: 'building', log: '' };
  publishSystem();
}

function imageReady(): void {
  system.image = { tag: templateTag(), state: 'ready', log: '' };
  publishSystem();
}

function imageFailed(error: unknown): void {
  system.image = { tag: templateTag(), state: 'error', log: system.image.log, error: errorMessage(error) };
  publishSystem();
}

let building: Promise<string> | null = null;

function runBuild(options: { fresh?: boolean }): Promise<string> {
  building ??= (async () => {
    const tag = templateTag();
    imageBuilding();
    try {
      await buildTemplate(tag, options, imageLog());
      imageReady();
      // The helper moves to the new template the next time it's needed.
      await removeSandbox(HELPER);
      state.catalogTemplate = undefined;
      void refreshCodexCatalog();
      return tag;
    } catch (error) {
      imageFailed(error);
      throw error;
    }
  })().finally(() => {
    building = null;
  });
  return building;
}

/** Returns the template sandboxes start from, building it the first time. */
export async function ensureSandboxImage(): Promise<string> {
  const tag = templateTag();
  if (!building && (await templateLoaded(tag))) {
    if (system.image.state !== 'ready') imageReady();
    return tag;
  }
  return runBuild({});
}

/** A project's own template has to be one Docker Sandboxes already has. */
export async function ensureCustomTemplate(image: string): Promise<string> {
  if (await templateLoaded(image)) return image;
  throw new SandboxError(`Docker Sandboxes has no template called ${image}. \`sbx template ls\` lists the ones it has, and the README says how to make one.`);
}

/** Rebuilds from scratch to pick up new versions of the agent CLIs. */
export function rebuildImage(): Promise<string> {
  return runBuild({ fresh: true });
}

// A small sandbox for what doesn't belong to a workspace: signing in, trying a key, and renewing
// Codex's sign-in. It's the only place credentials reach outside this server, for as long as one
// of those takes. Agents never run in it, and it has no proxy secrets because the CLIs here need
// the real thing. Nothing of the server's is mounted.
const HELPER = `${PREFIX}-tools`;

export function helperSandbox(): Promise<string> {
  return ensureSandbox({
    name: HELPER,
    image: ensureSandboxImage,
    // Only for tests, to renew a made-up sign-in without going to the real service.
    env: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ? [`CODEX_REFRESH_TOKEN_URL_OVERRIDE=${process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE}`] : [],
    mounts: [],
    agentState: paths.agentState('helper'),
    secrets: [],
    network: 'internet',
    memoryGb: 1,
    cpus: 1,
  });
}

export function helperRunning(): Promise<boolean> {
  return isSandboxRunning(HELPER).catch(() => false);
}

function claudeEnv(credential: string | undefined): string[] {
  if (!credential) return [];
  return [`${credential.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'}=${credential}`];
}

// Signing in with a browser also asks the service for an API key. Codex doesn't use one with this
// login, and a key outlives signing out, so it isn't kept.
function withoutIncidentalKey(authJson: string): string {
  const auth = JSON.parse(authJson) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown };
  return auth.auth_mode === 'chatgpt' && auth.OPENAI_API_KEY != null ? JSON.stringify({ ...auth, OPENAI_API_KEY: null }) : authJson;
}

// Only this server writes the login. A CLI that needs it gets a copy, so that nothing it does
// meanwhile, or leaves behind, can undo signing out or replace something newer.
function saveCodexLogin(authJson: string): void {
  fs.mkdirSync(path.dirname(hostCodexLogin()), { recursive: true, mode: 0o700 });
  writeAtomic(hostCodexLogin(), withoutIncidentalKey(authJson), 0o600);
  shareCodexCredentialWithProxy();
}

/** After `codex login` has finished. A file that isn't a whole login isn't taken for one. */
export function adoptCodexLogin(authJson: string): boolean {
  if (!codexCredential(authJson)) return false;
  saveCodexLogin(authJson);
  return true;
}

export function describeClaudeSignIn(credential: string | undefined): Pick<AgentStatus, 'summary' | 'usesKey'> {
  if (!credential) return {};
  if (credential.startsWith('sk-ant-oat')) return { summary: 'Signed in with your Claude subscription', usesKey: false };
  return { summary: `Using an API key ending in ${credential.slice(-4)}`, usesKey: true };
}

/** Reads auth.json, whose format belongs to the CLI, so nothing in it is relied on. */
export function describeCodexSignIn(authJson: string): Pick<AgentStatus, 'summary' | 'usesKey'> {
  try {
    const auth = JSON.parse(authJson) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { id_token?: unknown } };
    // A key beside a ChatGPT login isn't what Codex uses. See withoutIncidentalKey.
    if (auth.auth_mode !== 'chatgpt' && typeof auth.OPENAI_API_KEY === 'string') {
      return { summary: `Using an API key ending in ${auth.OPENAI_API_KEY.slice(-4)}`, usesKey: true };
    }
    const payload = typeof auth.tokens?.id_token === 'string' ? auth.tokens.id_token.split('.')[1] : undefined;
    const email = payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }).email : undefined;
    return { summary: typeof email === 'string' ? `Signed in with ChatGPT as ${email}` : 'Signed in with ChatGPT', usesKey: false };
  } catch {
    return { summary: 'Signed in with ChatGPT', usesKey: false };
  }
}

async function checkAgents(): Promise<void> {
  try {
    await readAgentStatus();
  } finally {
    // Even a check that couldn't run has to end the wait, or nobody could ever try to sign in.
    system.agentsChecked = true;
    publishSystem();
  }
}

const hostCodexLogin = () => path.join(paths.helperCredentials, 'codex', 'auth.json');

function readCodexLogin(): string {
  try {
    return fs.readFileSync(hostCodexLogin(), 'utf8');
  } catch {
    return '';
  }
}

/** What the proxy should send for Codex, and when that stops working if it's a sign-in rather than a key. */
export function codexCredential(authJson: string): { value: string; expiresAt?: number } | null {
  try {
    const auth = JSON.parse(authJson) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } };
    // A browser sign-in can leave a key beside its tokens, and the sign-in is what was asked for.
    if (auth.auth_mode !== 'chatgpt' && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) return { value: auth.OPENAI_API_KEY };
    const token = auth.tokens?.access_token;
    if (typeof token !== 'string' || !token) return null;
    return { value: token, expiresAt: tokenExpiry(token) };
  } catch {
    return null;
  }
}

/** A token of a kind this can't read still has to reach the proxy, so that isn't an error. */
function tokenExpiry(token: string): number | undefined {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function shareCodexCredentialWithProxy(): void {
  setBoundaryValue('codex', codexCredential(readCodexLogin())?.value);
}

const MAX_LOGIN_BYTES = 65536;

/**
 * A process that opened this directory before it was moved can still change what's in it. So the
 * file is read all from one opening, which won't follow a link, wait on a pipe or read without end.
 */
function readOldLogin(dir: string): string {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return '';
  let opened: number;
  try {
    opened = fs.openSync(path.join(dir, 'auth.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return '';
  }
  try {
    if (!fs.fstatSync(opened).isFile()) return '';
    const content = Buffer.alloc(MAX_LOGIN_BYTES + 1);
    const length = fs.readSync(opened, content);
    return length <= MAX_LOGIN_BYTES ? content.toString('utf8', 0, length) : '';
  } finally {
    fs.closeSync(opened);
  }
}

/**
 * Older workspaces have the old directory mounted and can't lose it, so the sign-in moves out from
 * under them, once. They can put anything there, including a link to elsewhere on this computer,
 * and change it at any moment. So it's renamed before anything looks at it, which moves a link
 * rather than following it, to where they can't put another. Anything appearing later goes unread.
 */
function leaveOldDirectory(): void {
  const old = path.join(paths.oldCredentials, 'codex');
  const taken = path.join(paths.helperCredentials, 'old-codex');
  const moved = path.join(paths.helperCredentials, 'moved');
  // Already there if the last start was stopped partway, and then it can be the only copy.
  if (!fs.lstatSync(taken, { throwIfNoEntry: false })) {
    try {
      fs.renameSync(old, taken);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!fs.existsSync(moved) && !fs.existsSync(hostCodexLogin())) {
    const login = readOldLogin(taken);
    if (codexCredential(login)) saveCodexLogin(login);
  }
  // Only now, so that being stopped before this tries again rather than losing the only copy.
  fs.writeFileSync(moved, '');
  fs.rmSync(taken, { recursive: true, force: true });
}

export function moveCodexLogin(): void {
  fs.mkdirSync(path.dirname(hostCodexLogin()), { recursive: true, mode: 0o700 });
  // What a workspace left there mustn't be able to stop Lonca starting.
  try {
    leaveOldDirectory();
  } catch (error) {
    console.error('could not clear the old directory for Codex’s sign-in:', errorMessage(error));
  }
  // A key kept before they stopped being.
  const login = readCodexLogin();
  if (codexCredential(login) && withoutIncidentalKey(login) !== login) saveCodexLogin(login);
  shareCodexCredentialWithProxy();
}

// A sign-in lasts about ten days. A CLI inside a workspace can't renew one it never had, so one in
// the helper does, on a copy it's given and prints back, through its own protocol, which leaves
// how that's done to the CLI.
const RENEW_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;
const RENEW_CODEX_LOGIN = String.raw`
import json, os, signal, subprocess, sys, tempfile
signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
with tempfile.TemporaryDirectory() as home:
    auth = os.path.join(home, 'auth.json')
    with open(auth, 'w') as file:
        file.write(sys.stdin.read())
    with open(os.path.join(home, 'config.toml'), 'w') as file:
        file.write('cli_auth_credentials_store = "file"\n')
    codex = subprocess.Popen(['codex', 'app-server'], env={**os.environ, 'CODEX_HOME': home}, start_new_session=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        for message in [
            {'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'lonca', 'version': '1'}}},
            {'method': 'initialized', 'params': {}},
            {'id': 2, 'method': 'account/read', 'params': {'refreshToken': True}},
        ]:
            codex.stdin.write(json.dumps(message) + '\n')
            codex.stdin.flush()
        for line in codex.stdout:
            if json.loads(line).get('id') == 2:
                break
    finally:
        # The whole group, since the command is a launcher with the real CLI as its child.
        os.killpg(codex.pid, signal.SIGKILL)
        codex.wait()
    with open(auth) as file:
        sys.stdout.write(file.read())
`;

async function renewCodexLogin(): Promise<void> {
  const current = readCodexLogin();
  const login = codexCredential(current);
  if (!login?.expiresAt || login.expiresAt - Date.now() > RENEW_WITHIN_MS || system.sandbox.state !== 'ready') return;
  try {
    const result = await exec(await helperSandbox(), ['timeout', '60', 'python3', '-I', '-c', RENEW_CODEX_LOGIN], { stdin: current, timeoutMs: 70000 });
    const renewed = result.stdout.toString('utf8');
    const after = codexCredential(renewed);
    if (result.code !== 0 || !after) throw new Error(result.stderr.toString('utf8').trim());
    // Signing out or in while this ran counts for more.
    if (readCodexLogin() === current) saveCodexLogin(renewed);
    if (after.expiresAt === login.expiresAt) throw new Error('it still runs out when it did');
  } catch (error) {
    console.error('could not renew the Codex sign-in:', errorMessage(error));
  }
}

let updateCodexSetups: () => Promise<void> = async () => {};

/** Workspaces supply this so checking a sign-in also updates terminal/script configuration. */
export function setCodexSetupUpdater(update: () => Promise<void>): void {
  updateCodexSetups = update;
}

/** What's saved here decides this. The CLIs' own status commands only read the same things. */
async function readAgentStatus(): Promise<void> {
  await renewCodexLogin();
  shareCodexCredentialWithProxy();
  // API keys and ChatGPT logins use different endpoints. Wait for the same serialized setup
  // used by project-key changes before reporting the sign-in ready, including during provisioning.
  // Refreshing also retries VMs that were unreachable at the time of the original change.
  await updateCodexSetups();
  const token = getSecrets().claudeToken;
  system.agents.claude = {
    signedIn: Boolean(token),
    ...describeClaudeSignIn(token),
    rejected: token ? system.agents.claude.rejected : undefined,
  };
  const login = readCodexLogin();
  const signedIn = codexCredential(login) !== null;
  system.agents.codex = {
    signedIn,
    ...(signedIn ? describeCodexSignIn(login) : {}),
    rejected: signedIn ? system.agents.codex.rejected : undefined,
  };
}

let checking: Promise<void> | null = null;
let checkingAgain: Promise<void> | null = null;

/**
 * Checks can overlap, and one that began before a credential changed reports the old answer.
 * So a request during a check waits for a fresh one that starts after it.
 */
export function refreshAgents(): Promise<void> {
  if (!checking) {
    checking = checkAgents().finally(() => {
      checking = null;
    });
    return checking;
  }
  checkingAgain ??= checking.catch(() => {}).then(() => {
    checkingAgain = null;
    return refreshAgents();
  });
  return checkingAgain;
}

/** A turn failed because the agent's service refused its credentials, whatever the CLI said about them. */
export function markAgentRejected(agent: AgentId): void {
  if (system.agents[agent].rejected || !system.agents[agent].signedIn) return;
  system.agents[agent] = { ...system.agents[agent], rejected: true };
  publishSystem();
}

export function clearAgentRejected(agent: AgentId): void {
  system.agents[agent] = { ...system.agents[agent], rejected: undefined };
}

export type CredentialCheck = 'accepted' | 'refused' | 'unknown';

const CHECKS_DISABLED = process.env.LONCA_SKIP_CREDENTIAL_CHECK === '1';

/** Tries a key for real, the way an agent would use it, so "signed in" means it works. */
export async function checkClaudeCredential(credential: string): Promise<CredentialCheck> {
  if (CHECKS_DISABLED) return 'accepted';
  const prompt = 'Reply with the word ok.';
  const result = await helperSandbox().then((helper) => exec(helper, [
    'claude', '-p', prompt, '--model', 'claude-haiku-5-5', '--output-format', 'json', '--tools', '',
    '--no-session-persistence', '--system-prompt', prompt,
  ], { env: claudeEnv(credential), workdir: '/tmp', timeoutMs: 60000 })).catch(() => null);
  if (!result) return 'unknown';
  try {
    const outcome = JSON.parse(result.stdout.toString('utf8')) as { is_error?: boolean; result?: string };
    if (!outcome.is_error) return 'accepted';
    return /invalid (api )?key|invalid.*token|not logged in|authenticat|unauthori[sz]ed|\b401\b|revoked|expired/i.test(outcome.result ?? '') ? 'refused' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function checkCodexKey(key: string): Promise<CredentialCheck> {
  if (CHECKS_DISABLED) return 'accepted';
  try {
    const response = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    return response.status === 401 ? 'refused' : response.ok ? 'accepted' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function parseCodexCatalog(output: string): ModelOption[] {
  const parsed = JSON.parse(output) as {
    models?: {
      slug: string;
      display_name?: string;
      visibility?: string;
      priority?: number;
      default_reasoning_level?: string;
      supported_reasoning_levels?: { effort: string }[];
    }[];
  };
  return (parsed.models ?? [])
    .filter((model) => model.visibility === 'list')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((model) => ({
      id: model.slug,
      label: model.display_name ?? model.slug,
      efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
      defaultEffort: model.default_reasoning_level ?? 'medium',
    }));
}

/** The picker offers what the CLI in the template actually supports, which only changes with the template. */
export async function refreshCodexCatalog(): Promise<void> {
  const template = templateTag();
  if (state.catalogTemplate === template) return;
  try {
    const result = await exec(await helperSandbox(), ['codex', 'debug', 'models'], { timeoutMs: 60000 });
    if (result.code !== 0) throw new Error(result.stderr.toString('utf8').trim());
    const models = parseCodexCatalog(result.stdout.toString('utf8'));
    if (models.length === 0) throw new Error('it listed none');
    const catalog: Catalog = { ...state.catalog, codex: { label: 'Codex', models } };
    state.catalog = catalog;
    state.catalogTemplate = template;
    saveState();
    publishSystem();
  } catch (error) {
    console.error('could not read Codex’s models:', errorMessage(error));
  }
}

export function agentLoginCommand(agent: AgentId, method: LoginMethod): string[] {
  if (agent === 'claude') return ['claude', 'setup-token'];
  return method === 'device' ? ['codex', 'login', '--device-auth'] : ['codex', 'login'];
}

export function signOutCodex(): void {
  fs.rmSync(hostCodexLogin(), { force: true });
  shareCodexCredentialWithProxy();
}

export function saveCodexApiKey(key: string): void {
  saveCodexLogin(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }));
}
