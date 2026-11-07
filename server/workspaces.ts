import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Project, Session, StepId, Workspace, WorkspaceOperation, WorkspaceStep } from '../shared/types.ts';
import { codexSetup, proxySecrets } from './boundary.ts';
import { FIRST_WORKSPACE_PORT, PORTS_PER_WORKSPACE, PREFIX, paths } from './config.ts';
import { publish } from './events.ts';
import { pickWorkspaceName } from './names.ts';
import { makeCheckout, projectLifecycle } from './projects.ts';
import { type ProxySecret, addSandboxSecret, ensureSandbox, exec, execText, isSandboxRunning, removeSandbox, sandboxState, stopSandbox } from './sandbox.ts';
import { deleteTranscript, flushState, getProject, getSecrets, getWorkspace, saveState, state } from './store.ts';
import { checkSandboxes, ensureCustomTemplate, ensureSandboxImage, releaseTemplateImage, system, templateImageOf } from './system.ts';
import { HttpError, KeyedQueue, RuntimeStoppedError, errorMessage, newId, removeTree } from './util.ts';

const lifecycle = new KeyedQueue();
const codexSetups = new KeyedQueue();
// Names belong to a project, but ports on this computer are shared by every workspace.
const allocation = new KeyedQueue();

type ReadyListener = (workspace: Workspace) => void;
type TeardownListener = (workspace: Workspace) => Promise<void>;
type StartListener = (workspace: Workspace, sandbox: string) => Promise<void>;
type ScriptStarter = (workspace: Workspace, script: string) => Promise<void>;

const readyListeners: ReadyListener[] = [];
const teardownListeners: TeardownListener[] = [];
const startListeners: StartListener[] = [];
let startSetupScript: ScriptStarter = async () => {};

/** Called when a workspace can accept work, to start any messages sent while it was booting. */
export function onWorkspaceReady(listener: ReadyListener): void {
  readyListeners.push(listener);
}

/** Called before a workspace's sandbox goes away, so its processes can be wound down. */
export function onWorkspaceTeardown(listener: TeardownListener): void {
  teardownListeners.push(listener);
}

/** Called when Lonca has started a workspace's sandbox, before it takes work, to clear what its last run left. */
export function onWorkspaceStarted(listener: StartListener): void {
  startListeners.push(listener);
}

export function setSetupScriptStarter(starter: ScriptStarter): void {
  startSetupScript = starter;
}

export function publishWorkspace(workspace: Workspace): void {
  workspace.updatedAt = Date.now();
  publish({ type: 'workspace', workspace });
  saveState();
}

function setStep(workspace: Workspace, id: StepId, status: WorkspaceStep['status'], detail?: string): void {
  const step = workspace.steps.find((entry) => entry.id === id);
  if (step) {
    step.status = status;
    step.detail = detail;
  }
  publishWorkspace(workspace);
}

/** Whether nothing on this computer is listening on a port of its loopback. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Ports on this computer go to one workspace or forward at a time, so that two can't be given the same one. */
export function reserveHostPorts<T>(task: () => Promise<T>): Promise<T> {
  return allocation.run('workspaces', task);
}

/** Finds a block of ten ports not used by another workspace or anything else on the host. */
async function allocatePorts(): Promise<number> {
  const used = new Set(state.workspaces.map((workspace) => workspace.port));
  // A stopped workspace's forward isn't listening, but sbx can publish it again when that starts.
  const forwarded = state.workspaces.flatMap((workspace) => (workspace.forwards ?? []).map((forward) => forward.hostPort));
  for (let first = FIRST_WORKSPACE_PORT; first < 60000; first += PORTS_PER_WORKSPACE) {
    if (used.has(first)) continue;
    if (forwarded.some((port) => port >= first && port < first + PORTS_PER_WORKSPACE)) continue;
    const checks = await Promise.all(
      Array.from({ length: PORTS_PER_WORKSPACE }, (_, offset) => isPortFree(first + offset)),
    );
    if (checks.every(Boolean)) return first;
  }
  throw new Error('No free ports left for a new workspace');
}

function workspaceEnv(workspace: Workspace, project: Project): string[] {
  return [
    `LONCA_WORKSPACE_ID=${workspace.id}`,
    `LONCA_WORKSPACE_NAME=${workspace.name}`,
    `LONCA_WORKSPACE_PATH=${workspace.path}`,
    `LONCA_PROJECT=${project.name}`,
    // Terminal prompts go by this, as the VM's name does, rather than a name that can be changed.
    `LONCA_PROJECT_SLUG=${project.slug}`,
    `LONCA_DEFAULT_BRANCH=${workspace.baseBranch}`,
    `LONCA_PORT=${workspace.port}`,
  ];
}

/** Prepares a workspace's sandbox, starting or creating it unless `start` is false. */
function ensureWorkspaceSandbox(workspace: Workspace, project: Project, options: { start?: boolean } = {}): Promise<string> {
  const settings = project.settings;
  // Boot writes Codex's login too, so an update must wait until that write has finished.
  return codexSetups.run(workspace.id, () => ensureSandbox({
    name: workspace.sandboxName,
    image: async () => {
      const image = await (settings.image ? ensureCustomTemplate(settings.image) : ensureSandboxImage());
      // Not being able to tell only means that image might go while the VM still wants it.
      workspace.templateImage = await templateImageOf(image).catch(() => undefined);
      saveState();
      return image;
    },
    env: workspaceEnv(workspace, project),
    // Its checkout and nothing else of this computer, so workspaces can't reach each other's git.
    mounts: [workspace.path],
    agentState: paths.agentState(workspace.id),
    secrets: proxySecrets(),
    setup: () => codexSetup(project),
    firstPort: workspace.port,
    network: settings.network,
    memoryGb: settings.memoryGb,
    cpus: settings.cpus,
  }, { start: options.start }));
}

/** Starts a workspace's sandbox for it to take work. sbx brings back what its last run had, which this clears. */
async function startWorkspaceSandbox(workspace: Workspace, project: Project): Promise<string> {
  const sandbox = await ensureWorkspaceSandbox(workspace, project);
  for (const listener of startListeners) await listener(workspace, sandbox);
  return sandbox;
}

function projectOf(workspace: Workspace): Project {
  const project = getProject(workspace.projectId);
  if (!project) throw new HttpError(404, 'This workspace’s project no longer exists');
  return project;
}

/** One at a time in each VM, with the settings as they are by then, so that the last to run has the latest. */
export function setUpCodex(workspace: Workspace, project: Project = projectOf(workspace)): Promise<void> {
  return codexSetups.run(workspace.id, async () => {
    const { command, stdin } = codexSetup(project);
    await execText(workspace.sandboxName, command, { stdin });
  });
}

/** Update running VMs for project keys and for global API-key/ChatGPT endpoint changes. */
export async function applyCodexSetup(project: Project): Promise<void> {
  const workspaces = state.workspaces.filter((workspace) => workspace.projectId === project.id);
  await Promise.all(workspaces.map((workspace) => lifecycle.run(workspace.id, async () => {
    // Creation or rebuilding may already have written an older key. Wait for it to finish,
    // and check then: a Stop or deletion that came first mustn't be undone by this update.
    if (getWorkspace(workspace.id) !== workspace) return;
    try {
      if (await isSandboxRunning(workspace.sandboxName)) await setUpCodex(workspace, project);
    } catch (error) {
      console.error(`could not update Codex’s key in ${workspace.name}:`, errorMessage(error));
    }
  })));
}

/**
 * Which address Codex uses follows the kind of sign-in, which every project shares. Nothing waits
 * for this, because a turn, terminal or script sets Codex up before it starts anyway.
 */
export function applyCodexSetupEverywhere(): void {
  for (const project of state.projects) void applyCodexSetup(project);
}

/** A new sign-in has to reach workspaces that are already running, for their agents to use it. */
export async function addProxySecretEverywhere(secret: ProxySecret): Promise<void> {
  await Promise.all(state.workspaces.map((workspace) => addSandboxSecret(workspace.sandboxName, secret).catch((error) => {
    console.error(`could not give ${workspace.name} a new sign-in:`, errorMessage(error));
  })));
}

/** Runs something that Stop, Archive and Rebuild have to wait for, such as merging the workspace's pull request. */
export function underLifecycle<T>(workspace: Workspace, task: () => Promise<T>): Promise<T> {
  return lifecycle.run(workspace.id, task);
}

/** Observes a workspace's sandbox without waking it for reads or automatic terminals. */
export async function runningSandbox(workspace: Workspace): Promise<string> {
  if (workspace.status !== 'ready') {
    throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  }
  const checkedAt = workspace.updatedAt;
  try {
    const id = await ensureWorkspaceSandbox(workspace, projectOf(workspace), { start: false });
    if (workspace.status !== 'ready') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
    return id;
  } catch (error) {
    if (!(error instanceof RuntimeStoppedError)) throw error;
    // A lookup that overlapped a lifecycle operation must not overwrite its intent.
    if (getWorkspace(workspace.id) === workspace && workspace.status === 'ready' && !workspace.pendingOperation
      && workspace.updatedAt === checkedAt) {
      workspace.status = 'stopped';
      publishWorkspace(workspace);
    }
    throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  }
}

// A checkout is copied from Lonca's copy of the repository on this computer, but its files are
// written in the VM, since checking files out can run filters and make links that point anywhere.
const CHECKOUT_SCRIPT = String.raw`
set -euo pipefail
cd "$1"
# Without an index, the files were never all written: a new checkout, a restored one, or one cut short.
[ -e .git/index ] || { rm -f .git/index.lock; git reset --quiet --hard; }
mkdir -p .context
`;

const CHECKOUT_TIMEOUT_MS = 15 * 60 * 1000;

// A retry may resume after only some files were copied. Publish complete files atomically,
// and never replace a destination that already belongs to the workspace.
const COPY_FILE_SCRIPT = String.raw`
set -euo pipefail
file="$1"; mode="$2"
if [ -e "$file" ] || [ -L "$file" ]; then exit 0; fi
mkdir -p "$(dirname "$file")"
tmp=$(mktemp "$(dirname "$file")/.lonca-copy.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
# mktemp makes the file private. The copy keeps the original's permissions instead.
chmod "$mode" "$tmp"
if ln -T "$tmp" "$file" 2>/dev/null; then
  echo copied
elif [ -e "$file" ] || [ -L "$file" ]; then
  exit 0
# Not every file system takes hard links. A rename that won't replace anything does the same job.
elif mv -n -T "$tmp" "$file" 2>/dev/null && [ ! -e "$tmp" ]; then
  echo copied
elif [ ! -e "$file" ] && [ ! -L "$file" ]; then
  echo "Could not copy $file" >&2
  exit 1
fi
`;

/** Counts each file as it lands, so a retry after a failure partway through reports them all. */
async function copyFiles(workspace: Workspace, project: Project, sandbox: string): Promise<void> {
  if (!project.localPath) return;
  for (const pattern of project.settings.filesToCopy) {
    for (const relative of fs.globSync(pattern, { cwd: project.localPath })) {
      if (relative === '.git' || relative.startsWith(`.git${path.sep}`) || relative.startsWith('..')) continue;
      const source = path.join(project.localPath, relative);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) continue;
      // Written from inside the sandbox, so a tracked symlink at this path can't reach the host.
      const result = await execText(
        sandbox,
        ['bash', '-c', COPY_FILE_SCRIPT, 'lonca-copy', relative, (stat.mode & 0o777).toString(8)],
        { stdin: fs.readFileSync(source), workdir: workspace.path },
      );
      if (result.trim() === 'copied') workspace.filesCopied++;
    }
  }
}

export async function configuredSetupScript(workspace: Workspace, sandbox?: string): Promise<string> {
  const project = projectOf(workspace);
  if (project.settings.setupScript.trim()) return project.settings.setupScript;
  const file = await exec(sandbox ?? await runningSandbox(workspace), ['head', '-c', '65536', 'lonca.json'], { workdir: workspace.path, timeoutMs: 10000 });
  if (file.code !== 0) return '';
  try {
    const script = (JSON.parse(file.stdout.toString('utf8')) as { scripts?: { setup?: unknown } }).scripts?.setup;
    return typeof script === 'string' ? script : '';
  } catch {
    return '';
  }
}

async function provision(workspace: Workspace): Promise<void> {
  const project = projectOf(workspace);
  let currentStep: StepId = 'image';
  try {
    setStep(workspace, 'image', 'running');
    if (!project.settings.image) await ensureSandboxImage();
    setStep(workspace, 'image', 'done');

    // Before the VM, which mounts the checkout: once one has, git here leaves it alone. An archived
    // workspace still has its checkout's history, with the branch in it.
    currentStep = 'checkout';
    setStep(workspace, 'checkout', 'running');
    const fetchError = fs.existsSync(workspace.path)
      ? undefined
      : await makeCheckout(project, workspace.path, workspace.branch, workspace.baseBranch);
    if (fetchError) {
      console.error(`could not fetch for ${workspace.name}:`, fetchError);
      const hint = project.remoteUrl && !getSecrets().githubToken ? ' If this repository is private, connect GitHub in Settings.' : '';
      setStep(workspace, 'checkout', 'warning', `Could not fetch from ${project.remoteUrl ? 'origin' : project.localPath}, so this branch starts from the last fetched commit.${hint}`);
    } else {
      setStep(workspace, 'checkout', 'done');
    }

    currentStep = 'sandbox';
    setStep(workspace, 'sandbox', 'running');
    const sandbox = await startWorkspaceSandbox(workspace, project);
    setStep(workspace, 'sandbox', 'done');

    if (workspace.steps.find((step) => step.id === 'files')?.status !== 'done') {
      currentStep = 'files';
      setStep(workspace, 'files', 'running');
      await execText(sandbox, ['bash', '-c', CHECKOUT_SCRIPT, 'lonca-checkout', workspace.path], { timeoutMs: CHECKOUT_TIMEOUT_MS });
      await copyFiles(workspace, project, sandbox);
      setStep(workspace, 'files', 'done');
    }

    finishOperation(workspace, 'ready');
    // Setup has its own status and retry control. A launch failure must not turn a usable
    // checkout into another creation attempt, potentially while agents are already running.
    try {
      const setup = await configuredSetupScript(workspace, sandbox);
      if (setup.trim()) await startSetupScript(workspace, setup);
    } catch (error) {
      setStep(workspace, 'setup', 'error', errorMessage(error));
    }
  } catch (error) {
    const message = errorMessage(error);
    console.error(`could not provision ${workspace.name}:`, message);
    setStep(workspace, currentStep, 'error', message);
    throw error;
  }
}

function newSteps(): WorkspaceStep[] {
  const ids: StepId[] = ['image', 'checkout', 'sandbox', 'files', 'setup'];
  return ids.map((id) => ({ id, status: 'pending' }));
}

export interface NewWorkspaceOptions {
  baseBranch?: string;
}

// Docker Sandboxes takes names of at most 63 characters, as DNS does.
const MAX_SANDBOX_NAME = 63;

/** The name of a workspace's sandbox, kept short enough. */
export function sandboxNameFor(prefix: string, slug: string, name: string, id: string): string {
  const full = `${prefix}-${slug}-${name}`;
  if (full.length <= MAX_SANDBOX_NAME) return full;
  // A long project name is cut short, and a hash of all of it keeps two such projects apart.
  const hash = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 6);
  const room = MAX_SANDBOX_NAME - `${prefix}--${hash}-${name}`.length;
  const shortened = slug.slice(0, Math.max(0, room)).replace(/-+$/, '');
  const named = shortened ? `${prefix}-${shortened}-${hash}-${name}` : `${prefix}-${hash}-${name}`;
  if (named.length <= MAX_SANDBOX_NAME) return named;
  if (`${prefix}-${id}`.length <= MAX_SANDBOX_NAME) return `${prefix}-${id}`;
  throw new HttpError(500, 'LONCA_INSTANCE is too long to name workspaces after. Use a shorter one.');
}

const SANDBOX_PROBLEM: Record<string, string> = {
  checking: 'Lonca is still checking on Docker Sandboxes.',
  'not-installed': 'Workspaces need Docker Sandboxes, which isn’t installed. Settings says how to get it.',
  'signed-out': 'Docker Sandboxes isn’t signed in. Sign in to Docker in Lonca’s Settings, then try again.',
};

/** Workspaces can't run without Docker Sandboxes, so there's no use in starting one. */
async function requireSandboxes(): Promise<void> {
  await checkSandboxes();
  const { state: sandbox, detail } = system.sandbox;
  if (sandbox === 'ready') return;
  throw new HttpError(503, SANDBOX_PROBLEM[sandbox] ?? `Docker Sandboxes can’t run workspaces here: ${detail ?? sandbox}`);
}

export async function createWorkspace(project: Project, options: NewWorkspaceOptions, makeSession: (workspace: Workspace) => Session): Promise<{ workspace: Workspace; session: Session }> {
  return projectLifecycle.run(project.id, async () => {
    if (!getProject(project.id)) throw new HttpError(404, 'This project no longer exists');
    if (project.status !== 'ready') throw new HttpError(409, `${project.name} isn’t ready yet`);
    await requireSandboxes();
    return allocation.run('workspaces', async () => {
      const taken = new Set(state.workspaces.filter((entry) => entry.projectId === project.id).map((entry) => entry.name));
      const name = pickWorkspaceName(taken);
      const prefix = state.settings.branchPrefix.trim().replace(/\/+$/, '');
      const port = await allocatePorts();
      const now = Date.now();
      const id = newId();
      const workspace: Workspace = {
        id,
        projectId: project.id,
        name,
        title: null,
        branch: prefix ? `${prefix}/${name}` : name,
        baseBranch: options.baseBranch ?? project.settings.defaultBranch,
        path: paths.checkout(project.slug, name),
        sandboxName: sandboxNameFor(PREFIX, project.slug, name, id),
        port,
        status: 'creating',
        pendingOperation: 'create',
        steps: newSteps(),
        filesCopied: 0,
        diff: null,
        createdAt: now,
        updatedAt: now,
      };
      // Record both reservations before another request can allocate either one.
      state.workspaces.push(workspace);
      const session = makeSession(workspace);
      publishWorkspace(workspace);
      flushState();
      scheduleOperation(workspace, 'create');
      return { workspace, session };
    });
  });
}

const operationStatus: Record<WorkspaceOperation, Workspace['status']> = {
  create: 'creating', restore: 'restoring', start: 'starting', stop: 'stopping',
  rebuild: 'rebuilding', archive: 'archiving', delete: 'deleting',
};

const operationFailure: Record<WorkspaceOperation, string> = {
  create: 'Could not create the workspace', restore: 'Could not restore the workspace',
  start: 'Could not start the workspace', stop: 'Could not stop the workspace',
  rebuild: 'Could not rebuild the workspace', archive: 'Could not finish archiving', delete: 'Could not finish deleting',
};

function beginOperation(workspace: Workspace, operation: WorkspaceOperation): void {
  if (!getWorkspace(workspace.id)) throw new HttpError(404, 'This workspace no longer exists');
  workspace.pendingOperation = operation;
  workspace.status = operationStatus[operation];
  workspace.error = undefined;
  publishWorkspace(workspace);
  // A crash during the first side effect must still leave an unambiguous retry action.
  flushState({ required: true });
}

function finishOperation(workspace: Workspace, status: 'ready' | 'stopped' | 'archived'): void {
  workspace.status = status;
  workspace.error = undefined;
  delete workspace.pendingOperation;
  publishWorkspace(workspace);
  flushState({ required: true });
  if (status === 'ready') for (const listener of readyListeners) listener(workspace);
}

/** Called under the workspace lock, for both original requests and retries. */
async function performOperation(workspace: Workspace, operation: WorkspaceOperation): Promise<void> {
  if (!getWorkspace(workspace.id)) throw new HttpError(404, 'This workspace no longer exists');
  const previousImage = workspace.templateImage;
  // Archiving removed its VM, and with it everything that ran there.
  const hasSandbox = workspace.status !== 'archived';
  try {
    beginOperation(workspace, operation);
    switch (operation) {
      case 'create':
      case 'restore':
        await provision(workspace);
        break;
      case 'start':
        await startWorkspaceSandbox(workspace, projectOf(workspace));
        finishOperation(workspace, 'ready');
        break;
      case 'stop':
      case 'rebuild':
      case 'archive':
      case 'delete':
        // Operations that keep conversations need the stopped sandbox's unread
        // output. Explicit deletion only needs its processes confirmed dead.
        if (operation !== 'delete'
          && state.sessions.some((session) => session.workspaceId === workspace.id && session.activeRunId)
          && await sandboxState(workspace.sandboxName) === 'stopped') {
          await ensureWorkspaceSandbox(workspace, projectOf(workspace));
        }
        if (hasSandbox) for (const listener of teardownListeners) await listener(workspace);
        if (operation === 'stop') {
          await stopSandbox(workspace.sandboxName);
          finishOperation(workspace, 'stopped');
        } else if (operation === 'rebuild') {
          await removeSandbox(workspace.sandboxName);
          // Removing a sandbox lets go of every port it had, including any forward that couldn't be closed.
          workspace.forwards = undefined;
          await startWorkspaceSandbox(workspace, projectOf(workspace));
          finishOperation(workspace, 'ready');
        } else {
          // Once the VM has gone, nothing an agent left running can still be writing to the checkout.
          if (hasSandbox) await removeSandbox(workspace.sandboxName);
          workspace.templateImage = undefined;
          if (operation === 'archive') {
            await removeCheckoutFiles(workspace.path);
            workspace.diff = null;
            workspace.forwards = undefined;
            finishOperation(workspace, 'archived');
          } else {
            await removeTree(workspace.path);
            await removeTree(paths.agentState(workspace.id));
            const sessions = state.sessions.filter((session) => session.workspaceId === workspace.id);
            await Promise.all(sessions.map((session) => deleteTranscript(session.id)));
            const previousSessions = state.sessions;
            const previousWorkspaces = state.workspaces;
            state.sessions = state.sessions.filter((session) => session.workspaceId !== workspace.id);
            state.workspaces = state.workspaces.filter((entry) => entry.id !== workspace.id);
            try {
              flushState({ required: true });
            } catch (error) {
              state.sessions = previousSessions;
              state.workspaces = previousWorkspaces;
              throw error;
            }
            for (const session of sessions) publish({ type: 'session.removed', id: session.id });
            publish({ type: 'workspace.removed', id: workspace.id });
          }
        }
    }
  } catch (error) {
    // Keep intent even if cleanup already removed the checkout, branch, or sandbox.
    workspace.pendingOperation = operation;
    // Starting has an explicit retry control and accepts messages into the saved queue.
    workspace.status = operation === 'start' ? 'stopped' : 'error';
    workspace.error = `${operationFailure[operation]}: ${errorMessage(error)}`;
    publishWorkspace(workspace);
    flushState();
    throw error;
  } finally {
    if (previousImage && previousImage !== workspace.templateImage) releaseTemplateImage(previousImage);
  }
}

function scheduleOperation(workspace: Workspace, operation: WorkspaceOperation): void {
  // Reserve the transition now so a second retry/restore request cannot enqueue it twice.
  workspace.status = operationStatus[operation];
  workspace.pendingOperation = operation;
  workspace.error = undefined;
  publishWorkspace(workspace);
  void lifecycle.run(workspace.id, () => performOperation(workspace, operation))
    .catch((error) => console.error(`could not ${operation} ${workspace.name}:`, errorMessage(error)));
}

/** Retry the saved operation. */
export function retryWorkspace(workspace: Workspace): void {
  if (workspace.status !== 'error' || !workspace.pendingOperation) throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  scheduleOperation(workspace, workspace.pendingOperation);
}

export function restoreWorkspace(workspace: Workspace): void {
  if (workspace.status !== 'archived') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  workspace.steps = newSteps();
  workspace.filesCopied = 0;
  scheduleOperation(workspace, 'restore');
}

export function startWorkspace(workspace: Workspace): Promise<void> {
  return lifecycle.run(workspace.id, async () => {
    // Several messages can request the same wake while the sandbox is starting.
    if (workspace.status === 'ready' && await isSandboxRunning(workspace.sandboxName)) return;
    if (workspace.status !== 'stopped' && workspace.status !== 'ready') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
    await performOperation(workspace, 'start');
  });
}

export function stopWorkspace(workspace: Workspace): Promise<void> {
  return lifecycle.run(workspace.id, async () => {
    if (workspace.status !== 'ready') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
    await performOperation(workspace, 'stop');
  });
}

/** Replaces the sandbox to apply new project settings or a new template. Files and conversations are kept. */
export function rebuildWorkspace(workspace: Workspace): Promise<void> {
  return lifecycle.run(workspace.id, async () => {
    if (workspace.status !== 'ready' && workspace.status !== 'stopped') {
      throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
    }
    await performOperation(workspace, 'rebuild');
  });
}

/**
 * Removes all of a checkout but its history, which keeps the branch for the workspace to be restored
 * from. Without an index, restoring writes the files again. One entry at a time, so that nothing is
 * still being removed once a failure has ended the operation.
 */
async function removeCheckoutFiles(dir: string): Promise<void> {
  const isDirectory = async (entry: string) => (await fs.promises.lstat(entry).catch(() => null))?.isDirectory();
  if (!await isDirectory(dir)) return;
  // An agent can have taken away the permissions this needs. Its VM has gone, so nothing can
  // swap these for links by now.
  await fs.promises.chmod(dir, 0o700);
  for (const name of await fs.promises.readdir(dir)) {
    if (name !== '.git') await removeTree(path.join(dir, name));
  }
  const history = path.join(dir, '.git');
  if (await isDirectory(history)) {
    await fs.promises.chmod(history, 0o700);
    await removeTree(path.join(history, 'index'));
  }
}

/**
 * Removes the sandbox and the checkout's files, but keeps its history, with the branch, and chat
 * history. When the user wasn't asked first, it can refuse, and returns false to say they need
 * asking after all.
 */
export function archiveWorkspace(workspace: Workspace, { asked = true } = {}): Promise<boolean> {
  return lifecycle.run(workspace.id, async () => {
    if (workspace.status === 'archived') return true;
    // Checked again after counting, since an agent can start meanwhile.
    if (!asked && (mustAsk(workspace) || await mayHaveChanges(workspace) || mustAsk(workspace))) return false;
    await performOperation(workspace, 'archive');
    return true;
  });
}

/**
 * Even someone who said not to be asked before archiving is asked while an agent is working there,
 * and while it isn't running, since its uncommitted changes can't be counted then.
 */
function mustAsk(workspace: Workspace): boolean {
  return state.settings.confirmArchive || workspace.status !== 'ready' || agentWorkingIn(workspace);
}

export function agentWorkingIn(workspace: Workspace): boolean {
  return state.sessions.some((session) => session.workspaceId === workspace.id && session.status === 'running');
}

// A busy sandbox can be slow to answer, and then the user is asked instead.
const UNASKED_COUNT_MS = 3000;

/**
 * New files and changes in submodules count whatever the repository's settings say, and git failing
 * or taking too long isn't taken to mean there are none.
 */
async function mayHaveChanges(workspace: Workspace): Promise<boolean> {
  try {
    const command = ['git', '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'];
    const status = await exec(await runningSandbox(workspace), command, {
      workdir: workspace.path,
      timeoutMs: UNASKED_COUNT_MS,
    });
    return status.code !== 0 || status.stdout.length > 0;
  } catch {
    return true;
  }
}

/** Removes every trace of the workspace, including its branch. */
export function deleteWorkspace(workspace: Workspace): Promise<void> {
  return lifecycle.run(workspace.id, async () => {
    if (!getWorkspace(workspace.id)) return;
    await performOperation(workspace, 'delete');
  });
}

/**
 * Work saved as under way was cut off when the server stopped. This runs before the server takes
 * requests, so it can't mistake a workspace someone has only just created for one of those.
 */
export function markInterruptedWork(): void {
  for (const workspace of state.workspaces) {
    const setup = workspace.steps.find((step) => step.id === 'setup');
    if (setup?.status === 'running') {
      setup.status = 'error';
      setup.detail = 'Lonca restarted during the setup script, so its result isn’t known.';
    }
    if (Object.values(operationStatus).includes(workspace.status)) {
      workspace.status = 'error';
      workspace.error = `${operationFailure[workspace.pendingOperation!]}: Lonca stopped before it finished. Try again to finish this operation.`;
    }
  }
  saveState();
}

/**
 * Signing Docker Sandboxes out stops every sandbox on the computer, which nothing can ask about
 * until it's signed in again. Workspaces in the middle of something find out for themselves.
 */
export async function markStoppedBySignOut(onStopped: (workspace: Workspace) => void): Promise<void> {
  await Promise.all(state.workspaces.map((workspace) => lifecycle.run(workspace.id, async () => {
    if (workspace.status !== 'ready' || workspace.pendingOperation) return;
    workspace.status = 'stopped';
    publishWorkspace(workspace);
    onStopped(workspace);
  })));
}

/** Brings saved state in line with Docker Sandboxes, which can change while nothing is watching it. */
export async function reconcileWorkspaces(): Promise<void> {
  await Promise.all(state.workspaces.map((workspace) => lifecycle.run(workspace.id, async () => {
    if (workspace.status !== 'ready' && workspace.status !== 'stopped') return;
    // A failed start may have left a running sandbox that didn't finish booting.
    // Keep the explicit Start retry until it's been shown it can accept work.
    if (workspace.pendingOperation === 'start') return;
    // With Docker Sandboxes signed out, a VM can't be asked. Its record stands until it can be.
    if (system.sandbox.state !== 'ready') return;
    let status: Workspace['status'];
    try {
      status = (await isSandboxRunning(workspace.sandboxName)) ? 'ready' : 'stopped';
    } catch (error) {
      // One sandbox that can't be asked mustn't hold up the others. Its record stands for now.
      console.error(`could not check on ${workspace.name}:`, errorMessage(error));
      return;
    }
    if (status !== workspace.status) {
      workspace.status = status;
      publishWorkspace(workspace);
    }
  })));
}
