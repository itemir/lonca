import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Project, ProjectSettings } from '../shared/types.ts';
import { PREFIX, paths } from './config.ts';
import { LABEL, docker, removeContainer } from './docker.ts';
import { publish } from './events.ts';
import { githubGitAuth } from './git-auth.ts';
import { flushState, getSecrets, saveState, state } from './store.ts';
import { ensureImage } from './system.ts';
import { HttpError, KeyedQueue, errorMessage, newId, removeTree, slugify } from './util.ts';

// Keep workspace allocation and project removal from overlapping, including port probes.
export const projectLifecycle = new KeyedQueue();
const imports = new Map<string, { controller: AbortController; finished: Promise<void> }>();

// Git on the host runs only while setting up a repository, before any container has
// mounted it, or against the user's own checkout. See WORKTREE_SCRIPT in workspaces.ts.
const HOST_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
  GIT_HTTP_LOW_SPEED_LIMIT: '1000',
  GIT_HTTP_LOW_SPEED_TIME: '120',
};

function killGit(child: ChildProcess): void {
  if (!child.pid) return;
  // Git's SSH/HTTP helpers must stop too, before we remove their repository.
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

function hostGit(cwd: string, args: string[], signal?: AbortSignal, onProgress?: (line: string) => void, remoteUrl?: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const auth = githubGitAuth(remoteUrl, getSecrets().githubToken);
    const child = spawn('git', [...auth.args, ...args], { cwd, env: { ...HOST_GIT_ENV, ...auth.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cancel = () => killGit(child);
    signal?.addEventListener('abort', cancel, { once: true });
    const stdout: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        failure = new Error('Git output exceeded 16 MiB');
        killGit(child);
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = (stderr + text).slice(-4000);
      const last = text.split(/[\r\n]+/).filter(Boolean).at(-1);
      if (last) onProgress?.(last.trim());
    });
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim());
      else reject(new Error(stderr.replace(/^(remote: )?Counting.*$/gm, '').trim() || `git exited with code ${code}`));
    });
  });
}

async function hostGitProgress(cwd: string, args: string[], onProgress: (line: string) => void, signal: AbortSignal, remoteUrl?: string): Promise<void> {
  await hostGit(cwd, args, signal, onProgress, remoteUrl);
}

/** Workspaces can read the remote URL, so a token embedded in one must not reach them. */
export function stripUrlCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/, '$1');
}

/** Accepts `owner/repo` shorthand as well as https and ssh URLs. */
export function normalizeRemoteUrl(input: string): string {
  const url = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url.replace(/\.git$/, '')}.git`;
  if (stripUrlCredentials(url) !== url) {
    throw new HttpError(400, 'Remove the username or token from the URL. Workspaces can read it, so connect GitHub in Settings instead.');
  }
  if (/^(https?|ssh):\/\/[^\s]+$/.test(url) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(url)) return url;
  throw new HttpError(400, 'Enter a GitHub URL, such as https://github.com/owner/repo or owner/repo');
}

export function parseGithubOwner(url: string | null): string | null {
  if (!url) return null;
  return /github\.com[/:]([\w.-]+)\/[\w.-]+?(\.git)?\/?$/.exec(url)?.[1] ?? null;
}

export function repoNameFromUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).at(-1) || 'project';
}

// A directory on disk counts as taken even with no project attached. If one survived a
// failed delete, an agent's hooks could be in it, and git on the host would run them.
function uniqueSlug(name: string): string {
  const base = slugify(name);
  const taken = new Set(state.projects.map((project) => project.slug));
  const available = (slug: string) => !taken.has(slug) && !fs.existsSync(paths.projectDir(slug));
  if (available(base)) return base;
  for (let n = 2; ; n++) {
    if (available(`${base}-${n}`)) return `${base}-${n}`;
  }
}

function defaultProjectSettings(): ProjectSettings {
  return {
    defaultBranch: 'main',
    setupScript: '',
    filesToCopy: [],
    image: '',
    network: 'internet',
    memoryGb: 0,
    cpus: 0,
    env: {},
  };
}

export function publishProject(project: Project): void {
  if (!state.projects.includes(project)) return;
  publish({ type: 'project', project });
  saveState();
}

async function detectDefaultBranch(repo: string, signal?: AbortSignal, remoteUrl?: string | null): Promise<string> {
  try {
    await hostGit(repo, ['remote', 'set-head', 'origin', '--auto'], signal, undefined, remoteUrl);
    return (await hostGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], signal)).replace(/^origin\//, '');
  } catch {
    signal?.throwIfAborted();
    const branches = (await hostGit(repo, ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'], signal))
      .split('\n')
      .filter(Boolean);
    return branches.find((branch) => branch === 'main') ?? branches.find((branch) => branch === 'master') ?? branches[0] ?? '';
  }
}

async function importRepository(project: Project, signal: AbortSignal): Promise<void> {
  const repo = paths.repo(project.slug);
  let lastPublish = 0;
  const onProgress = (line: string) => {
    project.progress = line;
    if (Date.now() - lastPublish > 300) {
      lastPublish = Date.now();
      publishProject(project);
    }
  };
  try {
    fs.mkdirSync(paths.projectDir(project.slug), { recursive: true });
    fs.mkdirSync(repo);
    await hostGit(repo, ['init', '--quiet', '--bare', '--template='], signal);
    await hostGit(repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], signal);
    if (project.localPath) {
      // Importing objects from disk first makes the fetch from the remote nearly free.
      await hostGitProgress(repo, ['fetch', '--progress', project.localPath, '+refs/heads/*:refs/remotes/origin/*'], onProgress, signal);
    }
    if (project.remoteUrl) {
      await hostGit(repo, ['config', 'remote.origin.url', project.remoteUrl], signal);
      const fetch = hostGitProgress(repo, ['fetch', '--progress', '--tags', 'origin'], onProgress, signal, project.remoteUrl);
      // A local checkout is usable even if its remote can't be reached right now.
      if (project.localPath) await fetch.catch(() => { signal.throwIfAborted(); });
      else await fetch;
    }
    const branch = project.localPath && !project.remoteUrl
      ? await hostGit(project.localPath, ['symbolic-ref', '--short', 'HEAD'], signal).catch(() => '')
      : await detectDefaultBranch(repo, signal, project.remoteUrl);
    const hasBranch = branch && (await hostGit(repo, ['for-each-ref', `refs/remotes/origin/${branch}`], signal));
    const fallback = hasBranch ? branch : await detectDefaultBranch(repo, signal, project.remoteUrl);
    if (!fallback) throw new Error('This repository has no commits yet. Push a first commit, then add it again.');
    project.settings.defaultBranch = fallback;
    project.status = 'ready';
    project.progress = undefined;
  } catch (error) {
    if (signal.aborted) return;
    project.status = 'error';
    project.error = errorMessage(error);
    project.progress = undefined;
  }
  publishProject(project);
}

function startImport(project: Project): void {
  const controller = new AbortController();
  const finished = importRepository(project, controller.signal).finally(() => imports.delete(project.id));
  imports.set(project.id, { controller, finished });
}

export async function addProjectFromUrl(input: string): Promise<Project> {
  const remoteUrl = normalizeRemoteUrl(input);
  if (state.projects.some((project) => project.remoteUrl === remoteUrl && !project.localPath)) {
    throw new HttpError(409, 'This repository has already been added');
  }
  const name = repoNameFromUrl(remoteUrl);
  const project: Project = {
    id: newId(),
    name,
    slug: uniqueSlug(name),
    remoteUrl,
    localPath: null,
    githubOwner: parseGithubOwner(remoteUrl),
    status: 'cloning',
    createdAt: Date.now(),
    settings: defaultProjectSettings(),
  };
  state.projects.push(project);
  publishProject(project);
  // Saved before the reply, so a crash a moment later can't lose a project someone just added.
  flushState();
  startImport(project);
  return project;
}

export async function addProjectFromPath(input: string): Promise<Project> {
  const resolved = path.resolve(input.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  let root: string;
  try {
    root = fs.realpathSync(await hostGit(resolved, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new HttpError(400, `${resolved} is not a git repository`);
  }
  if (state.projects.some((project) => project.localPath === root)) {
    throw new HttpError(409, 'This repository has already been added');
  }
  const origin = await hostGit(root, ['remote', 'get-url', 'origin']).catch(() => null);
  const remoteUrl = origin === null ? null : stripUrlCredentials(origin);
  const name = path.basename(root);
  const project: Project = {
    id: newId(),
    name,
    slug: uniqueSlug(name),
    remoteUrl,
    localPath: root,
    githubOwner: parseGithubOwner(remoteUrl),
    status: 'cloning',
    createdAt: Date.now(),
    settings: defaultProjectSettings(),
  };
  state.projects.push(project);
  publishProject(project);
  // Saved before the reply, so a crash a moment later can't lose a project someone just added.
  flushState();
  startImport(project);
  return project;
}

const IMPORT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Brings new commits from a local repository with no remote into the project. The project's
 * repository may have been written to by an agent, so git touches it only in a throwaway
 * container, and that container sees just a bundle of the branches, not the local `.git`.
 */
export async function refreshFromLocalRepo(project: Project): Promise<void> {
  if (!project.localPath || project.remoteUrl) return;
  const repo = paths.repo(project.slug);
  const staging = fs.mkdtempSync(path.join(paths.projectDir(project.slug), 'import-'));
  const bundle = path.join(staging, 'local.bundle');
  const name = `${PREFIX}-import-${project.id}`;
  try {
    await hostGit(project.localPath, ['bundle', 'create', '--quiet', bundle, '--branches']);
    await removeContainer(name);
    const container = await docker.createContainer({
      name,
      Image: await ensureImage(),
      Entrypoint: ['git', '-C', repo, '-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', bundle, '+refs/heads/*:refs/remotes/origin/*'],
      Cmd: [],
      User: 'lonca',
      Labels: { [LABEL]: PREFIX },
      HostConfig: {
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        Binds: [`${repo}:${repo}:rw`, `${bundle}:${bundle}:ro`],
      },
    });
    await container.start();
    const finished = await Promise.race([
      container.wait() as Promise<{ StatusCode: number }>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), IMPORT_TIMEOUT_MS)),
    ]);
    if (finished === null) throw new Error('Importing new commits took too long');
    if (finished.StatusCode !== 0) {
      const logs = await container.logs({ stdout: true, stderr: true });
      throw new Error(logs.toString('utf8').trim() || `git fetch exited with code ${finished.StatusCode}`);
    }
  } finally {
    await removeContainer(name);
    await removeTree(staging);
  }
}

const MAX_PACKED_REFS_BYTES = 8 * 1024 * 1024;
const MAX_BRANCHES = 5000;

/** Reads a file that an agent could have swapped for a link or a FIFO, which would hang a plain read. */
function readRegularFile(file: string, maxBytes: number): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Reads remote branch names directly from the ref files. Parsing them is safe where
 * running git on this agent-writable repository wouldn't be.
 */
export function listBranches(project: Project): string[] {
  const repo = paths.repo(project.slug);
  const branches = new Set<string>();
  const packedRefs = readRegularFile(path.join(repo, 'packed-refs'), MAX_PACKED_REFS_BYTES) ?? '';
  for (const line of packedRefs.split('\n')) {
    const match = /^[0-9a-f]{40,} refs\/remotes\/origin\/(.+)$/.exec(line);
    if (match) branches.add(match[1]);
    if (branches.size >= MAX_BRANCHES) break;
  }
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[] = [];
    try {
      if (!fs.lstatSync(dir).isDirectory()) return;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (branches.size >= MAX_BRANCHES) return;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) branches.add(`${prefix}${entry.name}`);
    }
  };
  const parents = [path.join(repo, 'refs'), path.join(repo, 'refs', 'remotes')];
  const realDirectory = (dir: string) => {
    try {
      return fs.lstatSync(dir).isDirectory();
    } catch {
      return false;
    }
  };
  if (parents.every(realDirectory)) walk(path.join(repo, 'refs', 'remotes', 'origin'), '');
  branches.delete('HEAD');
  return [...branches].sort((a, b) => a.localeCompare(b));
}

/** An import can't survive a restart; say so instead of showing it in progress forever. */
export function reconcileProjects(): void {
  for (const project of state.projects) {
    if (project.status === 'cloning') {
      project.status = 'error';
      project.error = 'Lonca stopped while importing this repository. Remove the project and add it again.';
      project.progress = undefined;
      publishProject(project);
    }
  }
}

/** Ends every import now, including its Git processes. For shutting down. */
export function abortImports(): void {
  for (const { controller } of imports.values()) controller.abort();
}

export async function removeProject(project: Project): Promise<void> {
  state.projects = state.projects.filter((entry) => entry.id !== project.id);
  flushState();
  publish({ type: 'project.removed', id: project.id });
  const importing = imports.get(project.id);
  importing?.controller.abort();
  await importing?.finished;
  await removeTree(paths.projectDir(project.slug));
}
