import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Project, ProjectSettings } from '../shared/types.ts';
import { paths } from './config.ts';
import { publish } from './events.ts';
import { githubGitAuth } from './git-auth.ts';
import { flushState, getSecrets, saveState, state } from './store.ts';
import { HttpError, KeyedQueue, errorMessage, newId, removeTree, slugify } from './util.ts';

// Keep workspace allocation and project removal from overlapping, including port probes.
export const projectLifecycle = new KeyedQueue();
const imports = new Map<string, { controller: AbortController; finished: Promise<void> }>();

// Git on this computer runs only on Lonca's own copy of a repository, which no VM mounts, on the
// user's own checkout, and on a workspace's new checkout before any VM has seen it. Once a VM has
// mounted a checkout, its config and hooks are an agent's to write, so git here never touches it.
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

// So that shutting down can end them, since they'd outlive this process, some with the GitHub token.
const running = new Set<ChildProcess>();

function hostGit(cwd: string, args: string[], signal?: AbortSignal, onProgress?: (line: string) => void, remoteUrl?: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const auth = githubGitAuth(remoteUrl, getSecrets().githubToken);
    const child = spawn('git', [...auth.args, ...args], { cwd, env: { ...HOST_GIT_ENV, ...auth.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
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
      running.delete(child);
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
// failed delete, its checkouts hold whatever agents left there, which a new project mustn't reuse.
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

/** Can be run again, so it also finishes a copy that was cut short, or makes one that was removed. */
async function initCache(project: Project, signal?: AbortSignal): Promise<string> {
  const cache = paths.cache(project.slug);
  fs.mkdirSync(cache, { recursive: true });
  await hostGit(cache, ['init', '--quiet', '--bare', '--template='], signal);
  await hostGit(cache, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], signal);
  if (project.remoteUrl) await hostGit(cache, ['config', 'remote.origin.url', project.remoteUrl], signal);
  return cache;
}

async function importRepository(project: Project, signal: AbortSignal): Promise<void> {
  let lastPublish = 0;
  const onProgress = (line: string) => {
    project.progress = line;
    if (Date.now() - lastPublish > 300) {
      lastPublish = Date.now();
      publishProject(project);
    }
  };
  try {
    const cache = await initCache(project, signal);
    if (project.localPath) {
      // Importing objects from disk first makes the fetch from the remote nearly free.
      await hostGitProgress(cache, ['fetch', '--progress', project.localPath, '+refs/heads/*:refs/remotes/origin/*'], onProgress, signal);
    }
    if (project.remoteUrl) {
      const fetch = hostGitProgress(cache, ['fetch', '--progress', '--tags', 'origin'], onProgress, signal, project.remoteUrl);
      // A local checkout is usable even if its remote can't be reached right now.
      if (project.localPath) await fetch.catch(() => { signal.throwIfAborted(); });
      else await fetch;
    }
    const branch = project.localPath && !project.remoteUrl
      ? await hostGit(project.localPath, ['symbolic-ref', '--short', 'HEAD'], signal).catch(() => '')
      : await detectDefaultBranch(cache, signal, project.remoteUrl);
    const hasBranch = branch && (await hostGit(cache, ['for-each-ref', `refs/remotes/origin/${branch}`], signal));
    const fallback = hasBranch ? branch : await detectDefaultBranch(cache, signal, project.remoteUrl);
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

const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const cacheLock = new KeyedQueue();
const execFileAsync = promisify(execFile);

/** From origin, or else from the checkout the project was imported from. */
async function fetchCache(project: Project, cache: string): Promise<void> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  if (project.remoteUrl) await hostGit(cache, ['fetch', '--prune', '--quiet', 'origin'], signal, undefined, project.remoteUrl);
  else if (project.localPath) await hostGit(cache, ['fetch', '--prune', '--quiet', project.localPath, '+refs/heads/*:refs/remotes/origin/*'], signal);
}

/**
 * Makes a new workspace's checkout at `dir`: a copy of Lonca's copy of the repository, with the
 * branch at the tip of its base. Its files are written later, in the workspace's VM. Returns why
 * fetching failed, if it did, since the branch then starts from the last commit fetched.
 */
export function makeCheckout(project: Project, dir: string, branch: string, base: string): Promise<string | undefined> {
  return cacheLock.run(project.id, async () => {
    const cache = await initCache(project);
    const fetchError = await fetchCache(project, cache).then(() => undefined, errorMessage);
    if (!await hostGit(cache, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]).catch(() => '')) {
      throw new Error(`There’s no ${base} branch to start from.${fetchError ? ` Fetching it failed: ${fetchError}` : ''}`);
    }
    // Made beside the workspace and moved into place, so a checkout that's there is complete.
    const staging = path.join(path.dirname(dir), `.${path.basename(dir)}.new`);
    await removeTree(staging);
    try {
      fs.mkdirSync(staging, { recursive: true });
      const gitDir = path.join(staging, '.git');
      // Copy-on-write where the file system allows it, so a copy takes space only as it changes.
      // APFS has to be asked; elsewhere cp tries by itself, and copies otherwise.
      await execFileAsync('cp', [...(process.platform === 'darwin' ? ['-c'] : []), '-R', cache, gitDir]);
      const git = (...args: string[]) => hostGit(staging, ['--git-dir', gitDir, ...args]);
      await git('config', 'core.bare', 'false');
      await git('update-ref', `refs/heads/${branch}`, `refs/remotes/origin/${base}`);
      await git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
      fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '.context/\n');
      fs.renameSync(staging, dir);
    } catch (error) {
      // A copy cut short, by a full disk say, can be large, and nothing else would remove it.
      await removeTree(staging);
      throw error;
    }
    return fetchError;
  });
}

/** The branches of origin, as of the last fetch. */
export async function listBranches(project: Project): Promise<string[]> {
  const cache = paths.cache(project.slug);
  if (!fs.existsSync(cache)) return [];
  const listed = await hostGit(cache, ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin']).catch(() => '');
  return listed.split('\n').filter((branch) => branch && branch !== 'HEAD').sort((a, b) => a.localeCompare(b));
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

/** Ends every import now, and any other Git still running. For shutting down. */
export function stopHostGit(): void {
  for (const { controller } of imports.values()) controller.abort();
  for (const child of running) killGit(child);
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
