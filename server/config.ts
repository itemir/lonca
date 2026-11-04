import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.LONCA_HOME ?? path.join(os.homedir(), '.lonca');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });

/** Resolved so bind mounts match the paths written into git's worktree metadata. */
export const LONCA_HOME = fs.realpathSync(home);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIST = path.join(REPO_ROOT, 'dist', 'web');
export const IMAGE_CONTEXT = path.join(REPO_ROOT, 'docker', 'workspace');

export const HTTP_PORT = Number(process.env.PORT ?? 4700);
export const DEV_MODE = process.env.LONCA_DEV === '1';

/** Keeps a second instance, such as a test run, from touching this one's Docker resources. */
export const INSTANCE = process.env.LONCA_INSTANCE ?? '';
export const PREFIX = INSTANCE ? `lonca-${INSTANCE}` : 'lonca';

/** `auto` gives new workspaces a VM wherever Docker Sandboxes can run one, and a container otherwise. */
export const RUNTIME_CHOICE = process.env.LONCA_RUNTIME ?? 'auto';

export const FIRST_WORKSPACE_PORT = Number(process.env.LONCA_FIRST_PORT ?? 20000);
export const PORTS_PER_WORKSPACE = 10;

export const paths = {
  state: path.join(LONCA_HOME, 'state.json'),
  secrets: path.join(LONCA_HOME, 'secrets.json'),
  token: path.join(LONCA_HOME, 'token'),
  sessions: path.join(LONCA_HOME, 'sessions'),
  /** The shared Codex login. Mounted into every workspace, so never read from the host. */
  credentials: path.join(LONCA_HOME, 'credentials'),
  /** What a sandbox has to keep when it's replaced. Written by agents, so never read from the host. */
  agentState: (workspaceId: string) => path.join(LONCA_HOME, 'agent-state', workspaceId),
  projects: path.join(LONCA_HOME, 'projects'),
  projectDir: (slug: string) => path.join(LONCA_HOME, 'projects', slug),
  repo: (slug: string) => path.join(LONCA_HOME, 'projects', slug, 'repo.git'),
  worktree: (slug: string, name: string) => path.join(LONCA_HOME, 'projects', slug, 'workspaces', name),
};

/** Inside a container. Writable by the agent, never read from the host. */
export const RUNS_DIR = '/var/tmp/lonca/agent-runs';
export const TTY_DIR = '/var/tmp/lonca/tty';
