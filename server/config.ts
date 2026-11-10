import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.LONCA_HOME ?? path.join(os.homedir(), '.lonca');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });

/** Resolved, so that a checkout has one path, on this computer and in its VM. */
export const LONCA_HOME = fs.realpathSync(home);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIST = path.join(REPO_ROOT, 'dist', 'web');
/** What the template new workspaces start from is made of. */
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'template');

export const DEFAULT_HTTP_PORT = 4700;
export const HTTP_PORT = Number(process.env.PORT ?? DEFAULT_HTTP_PORT);
export const DEV_MODE = process.env.LONCA_DEV === '1';
/** Where Vite serves the web app in development, passing the API on to the server. */
export const DEV_PORT = 5173;

/** Keeps a second instance, such as a test run, from touching this one's sandboxes. */
export const INSTANCE = process.env.LONCA_INSTANCE ?? '';
export const PREFIX = INSTANCE ? `lonca-${INSTANCE}` : 'lonca';
/** Or its templates, which Lonca removes once it's done with them. Second instances share one, since a build takes minutes. */
export const TEMPLATE_NAME = INSTANCE ? 'lonca-instance-sandbox' : 'lonca-sandbox';


export const FIRST_WORKSPACE_PORT = Number(process.env.LONCA_FIRST_PORT ?? 20000);
export const PORTS_PER_WORKSPACE = 10;

export const paths = {
  state: path.join(LONCA_HOME, 'state.json'),
  secrets: path.join(LONCA_HOME, 'secrets.json'),
  token: path.join(LONCA_HOME, 'token'),
  /** Every port Lonca's pages have been served on. */
  uiPorts: path.join(LONCA_HOME, 'ui-ports'),
  /** Instructions for every project's Leads. Never mounted into a workspace. */
  playbook: path.join(LONCA_HOME, 'lead.md'),
  /** A project's own. Beside its repository rather than in it, so agents can't reach it. */
  projectPlaybook: (slug: string) => path.join(LONCA_HOME, 'projects', slug, 'lead.md'),
  sessions: path.join(LONCA_HOME, 'sessions'),
  /** Codex's sign-in. No virtual machine mounts it. */
  helperCredentials: path.join(LONCA_HOME, 'helper-credentials'),
  /** Where Codex's sign-in used to be. Older workspaces can't lose the mount, so it's kept, and kept empty. */
  oldCredentials: path.join(LONCA_HOME, 'credentials'),
  /** What Docker Sandboxes' proxy reads to fill in credentials. Never mounted into anything. */
  boundary: path.join(LONCA_HOME, 'boundary'),
  /** What a sandbox has to keep when it's replaced. Written by agents, so never read from the host. */
  agentState: (workspaceId: string) => path.join(LONCA_HOME, 'agent-state', workspaceId),
  projects: path.join(LONCA_HOME, 'projects'),
  projectDir: (slug: string) => path.join(LONCA_HOME, 'projects', slug),
  /** Lonca's own copy of a repository, which new checkouts are copied from. No VM mounts it. */
  cache: (slug: string) => path.join(LONCA_HOME, 'projects', slug, 'cache.git'),
  checkout: (slug: string, name: string) => path.join(LONCA_HOME, 'projects', slug, 'workspaces', name),
};

/** Inside a sandbox. Writable by the agent, never read from the host. */
export const RUNS_DIR = '/var/tmp/lonca/agent-runs';
export const TTY_DIR = '/var/tmp/lonca/tty';
/** Where a Lead's agent keeps its notes, away from the checkout everyone reads. */
export const SCRATCH_DIR = '/var/tmp/lonca/agent-scratch';
