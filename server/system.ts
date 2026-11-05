import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, AgentStatus, Catalog, LoginMethod, ModelOption, SystemStatus } from '../shared/types.ts';
import { IMAGE_CONTEXT, LONCA_HOME, PREFIX } from './config.ts';
import { CONTAINER_CREDENTIALS, ensureContainer } from './containers.ts';
import {
  type ExecResult, buildImage, docker, exec, execText, imageExists, imageTag, removeContainer, sandboxImageTag, saveImage,
} from './docker.ts';
import { publish } from './events.ts';
import { detectSandboxes, loadTemplate, templateLoaded } from './sandbox.ts';
import { getSecrets, saveState, state } from './store.ts';
import { errorMessage, removeTree } from './util.ts';

const LOG_LIMIT = 20000;

export const system: SystemStatus = {
  docker: { ok: false },
  sandbox: { state: 'checking' },
  image: { tag: imageTag(), state: 'unknown', log: '' },
  agents: { claude: { signedIn: false }, codex: { signedIn: false } },
  agentsChecked: false,
};

function publishSystem(): void {
  publish({ type: 'system', system, catalog: state.catalog });
}

export async function checkDocker(): Promise<boolean> {
  const wasOk = system.docker.ok;
  try {
    const version = await docker.version();
    system.docker = { ok: true, version: version.Version };
  } catch (error) {
    system.docker = { ok: false, error: errorMessage(error) };
  }
  if (wasOk !== system.docker.ok) publishSystem();
  return system.docker.ok;
}

let checkingSandboxes: Promise<void> | null = null;
let sandboxesReadyListener: () => void = () => {};

/** Called when workspaces can have VMs, having not been able to a moment ago. */
export function onSandboxesReady(listener: () => void): void {
  sandboxesReadyListener = listener;
}

/** Finds out whether new workspaces can have a VM. Safe to call often. */
export function checkSandboxes(): Promise<void> {
  checkingSandboxes ??= detectSandboxes().then((sandbox) => {
    const changed = JSON.stringify(sandbox) !== JSON.stringify(system.sandbox);
    const nowReady = sandbox.state === 'ready' && system.sandbox.state !== 'ready';
    system.sandbox = sandbox;
    if (system.image.state !== 'building') system.image.tag = shownImageTag();
    if (changed) publishSystem();
    if (nowReady) sandboxesReadyListener();
  }).finally(() => {
    checkingSandboxes = null;
  });
  return checkingSandboxes;
}

/** The image new workspaces use, which is the one to build a custom image from. */
const shownImageTag = () => (system.sandbox.state === 'ready' ? sandboxImageTag() : imageTag());

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
  system.image = { tag: shownImageTag(), state: 'building', log: '' };
  publishSystem();
}

function imageReady(): void {
  system.image = { tag: shownImageTag(), state: 'ready', log: '' };
  publishSystem();
}

function imageFailed(error: unknown): void {
  system.image = { tag: shownImageTag(), state: 'error', log: system.image.log, error: errorMessage(error) };
  publishSystem();
}

let building: Promise<string> | null = null;

async function runBuild(options: { fresh?: boolean }): Promise<string> {
  const tag = imageTag();
  imageBuilding();
  try {
    await buildImage(tag, options, imageLog());
    imageReady();
    // Containers from the previous image keep running; only the helper moves over now.
    await shareCodexLogin(TOOLS_CONTAINER).catch(() => {});
    await removeContainer(TOOLS_CONTAINER);
    return tag;
  } catch (error) {
    imageFailed(error);
    throw error;
  }
}

/** Returns the container image, building it the first time. The helper uses it whichever way workspaces run. */
export async function ensureImage(): Promise<string> {
  const tag = imageTag();
  if (await imageExists(tag)) {
    if (system.image.state !== 'ready' && !buildingSandbox) imageReady();
    return tag;
  }
  building ??= runBuild({}).finally(() => {
    building = null;
  });
  return building;
}

let buildingSandbox: Promise<string> | null = null;

async function runSandboxBuild(options: { fresh?: boolean }): Promise<string> {
  const tag = sandboxImageTag();
  imageBuilding();
  const staging = fs.mkdtempSync(path.join(LONCA_HOME, 'image-'));
  try {
    const onLog = imageLog();
    if (options.fresh || !(await imageExists(tag))) await buildImage(tag, { ...options, dockerfile: 'Dockerfile.sandbox' }, onLog);
    onLog('\nCopying the image to Docker Sandboxes…\n');
    const file = path.join(staging, 'image.tar');
    await saveImage(tag, file);
    await loadTemplate(file);
    imageReady();
    return tag;
  } catch (error) {
    imageFailed(error);
    throw error;
  } finally {
    await removeTree(staging);
  }
}

/** Returns the image sandboxes start from, building it and loading it into Docker Sandboxes the first time. */
export async function ensureSandboxImage(): Promise<string> {
  const tag = sandboxImageTag();
  if (!buildingSandbox && (await templateLoaded(tag))) {
    if (system.image.state !== 'ready') imageReady();
    return tag;
  }
  buildingSandbox ??= runSandboxBuild({}).finally(() => {
    buildingSandbox = null;
  });
  return buildingSandbox;
}

/** Loads a project's own image into Docker Sandboxes, which can't see the images Docker has. */
export async function ensureCustomTemplate(image: string): Promise<string> {
  if (await templateLoaded(image)) return image;
  const staging = fs.mkdtempSync(path.join(LONCA_HOME, 'image-'));
  try {
    const file = path.join(staging, 'image.tar');
    await saveImage(image, file);
    await loadTemplate(file);
    return image;
  } finally {
    await removeTree(staging);
  }
}

/** Rebuilds from scratch to pick up new versions of the agent CLIs. */
export function rebuildImage(): Promise<string> {
  building ??= runBuild({ fresh: true }).finally(() => {
    building = null;
  });
  if (system.sandbox.state !== 'ready') return building;
  return building.then(() => {
    buildingSandbox ??= runSandboxBuild({ fresh: true }).finally(() => {
      buildingSandbox = null;
    });
    return buildingSandbox;
  });
}

// A small always-on container for work that doesn't belong to a workspace: signing in,
// checking sign-in status and reading the Codex model catalog. It stays a container when
// workspaces are VMs because agents never run in it.
const TOOLS_CONTAINER = `${PREFIX}-tools`;

export async function toolsContainer(): Promise<string> {
  const image = await ensureImage();
  return ensureContainer({
    name: TOOLS_CONTAINER,
    hostname: 'lonca-tools',
    image: async () => image,
    env: [],
    network: 'internet',
  });
}

function claudeEnv(credential: string): string[] {
  return [`${credential.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'}=${credential}`];
}

/** Secrets exposed to agents and terminals, and to status checks. */
export function secretEnv(): string[] {
  const secrets = getSecrets();
  return [
    ...(secrets.claudeToken ? claudeEnv(secrets.claudeToken) : []),
    ...(secrets.githubToken ? [`GH_TOKEN=${secrets.githubToken}`] : []),
  ];
}

// `codex login` and `logout` unlink auth.json rather than writing through it, which turns the
// link to the shared directory into a private file: one workspace signed in, the rest not.
// Token refreshes do write through the link. Runs inline so it works on workspaces from any image.
//
// Signing in with a browser also asks the service for an API key. Codex doesn't use one with this
// login, every workspace can read what's shared, and a key outlives signing out, so it isn't shared.
// Startup uses the same script, and it also removes keys an older image already shared.
const SHARED_CODEX_LOGIN = `${CONTAINER_CREDENTIALS}/codex/auth.json`;
const SHARE_CODEX_LOGIN = fs.readFileSync(path.join(IMAGE_CONTEXT, 'lonca-share-codex-login'), 'utf8');

export async function shareCodexLogin(containerId: string): Promise<void> {
  await execText(containerId, ['bash', '-c', SHARE_CODEX_LOGIN, 'lonca-share-codex-login', SHARED_CODEX_LOGIN], { timeoutMs: 10000 });
}

export function parseClaudeStatus(output: string): boolean {
  try {
    return Boolean((JSON.parse(output) as { loggedIn?: boolean }).loggedIn);
  } catch {
    return false;
  }
}

export function parseCodexStatus(output: string, code: number | null): boolean {
  return code === 0 && !/not logged in/i.test(output.trim().split('\n')[0] ?? '');
}

export function describeClaudeSignIn(credential: string | undefined): Pick<AgentStatus, 'summary' | 'usesKey'> {
  if (!credential) return {};
  if (credential.startsWith('sk-ant-oat')) return { summary: 'Signed in with your Claude subscription', usesKey: false };
  return { summary: `Using an API key ending in ${credential.slice(-4)}`, usesKey: true };
}

/** Reads auth.json, which any workspace can write to, so nothing in it is relied on. */
export function describeCodexSignIn(authJson: string): Pick<AgentStatus, 'summary' | 'usesKey'> {
  try {
    const auth = JSON.parse(authJson) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { id_token?: unknown } };
    // A key beside a ChatGPT login isn't what Codex uses. See SHARE_CODEX_LOGIN.
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

async function readAgentStatus(): Promise<void> {
  const id = await toolsContainer();
  await shareCodexLogin(id);
  const [claude, codex, codexAuth] = await Promise.allSettled([
    exec(id, ['claude', 'auth', 'status'], { env: secretEnv(), timeoutMs: 30000 }),
    exec(id, ['codex', 'login', 'status'], { timeoutMs: 30000 }),
    exec(id, ['head', '-c', '65536', SHARED_CODEX_LOGIN], { timeoutMs: 10000 }),
  ]);
  // A status check that couldn't run or hit its time limit says nothing, so the last answer stands.
  const answered = (check: PromiseSettledResult<ExecResult>): check is PromiseFulfilledResult<ExecResult> => (
    check.status === 'fulfilled' && check.value.code !== 124 && check.value.code !== 137
  );
  if (answered(claude)) {
    const signedIn = parseClaudeStatus(claude.value.stdout.toString('utf8'));
    system.agents.claude = {
      signedIn,
      ...(signedIn ? describeClaudeSignIn(getSecrets().claudeToken) : {}),
      rejected: signedIn ? system.agents.claude.rejected : undefined,
    };
  }
  if (answered(codex)) {
    const signedIn = parseCodexStatus(codex.value.stdout.toString('utf8') + codex.value.stderr.toString('utf8'), codex.value.code);
    const auth = codexAuth.status === 'fulfilled' ? codexAuth.value.stdout.toString('utf8') : '';
    system.agents.codex = {
      signedIn,
      ...(signedIn ? describeCodexSignIn(auth) : {}),
      rejected: signedIn ? system.agents.codex.rejected : undefined,
    };
  }
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
  const id = await toolsContainer();
  const prompt = 'Reply with the word ok.';
  const result = await exec(id, [
    'claude', '-p', prompt, '--model', 'claude-haiku-5-5', '--output-format', 'json', '--tools', '',
    '--no-session-persistence', '--system-prompt', prompt,
  ], { env: claudeEnv(credential), workdir: '/tmp', timeoutMs: 60000 }).catch(() => null);
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
  const id = await toolsContainer();
  const result = await exec(
    id,
    ['bash', '-c', 'curl -s -o /dev/null -m 20 -w "%{http_code}" -H "Authorization: Bearer $KEY" https://api.openai.com/v1/models'],
    { env: [`KEY=${key}`], timeoutMs: 30000 },
  ).catch(() => null);
  const status = result?.stdout.toString('utf8').trim();
  if (status === '401') return 'refused';
  return status && status !== '000' ? 'accepted' : 'unknown';
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

/** The picker offers what the CLI in the image actually supports. */
export async function refreshCatalog(): Promise<void> {
  const id = await toolsContainer();
  const result = await exec(id, ['codex', 'debug', 'models'], { timeoutMs: 30000 });
  if (result.code !== 0) return;
  const models = parseCodexCatalog(result.stdout.toString('utf8'));
  if (models.length === 0) return;
  const catalog: Catalog = { ...state.catalog, codex: { label: 'Codex', models } };
  state.catalog = catalog;
  saveState();
  publishSystem();
}

export function agentLoginCommand(agent: AgentId, method: LoginMethod): string[] {
  if (agent === 'claude') return ['claude', 'setup-token'];
  return method === 'device' ? ['codex', 'login', '--device-auth'] : ['codex', 'login'];
}

export async function signOutCodex(): Promise<void> {
  const id = await toolsContainer();
  await shareCodexLogin(id);
  await execText(id, ['rm', '-f', SHARED_CODEX_LOGIN]);
}

export async function saveCodexApiKey(key: string): Promise<void> {
  const id = await toolsContainer();
  const result = await exec(id, ['codex', 'login', '--with-api-key'], { stdin: key });
  if (result.code !== 0) throw new Error(result.stderr.toString('utf8').trim() || 'Codex rejected the API key');
  await shareCodexLogin(id);
}
