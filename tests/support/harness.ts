// Starts a real Lonca server in a throwaway home directory with its own Docker
// resources, so tests never touch a user's data, and cleans all of it up afterwards.
import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { ChatItem, Session, SessionSnapshot, Workspace } from '../../shared/types.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

// Whose sandboxes this run uses: tests/support/fake-sbx's, which are Docker containers (`fake`), or
// the real `sbx`'s (`sandbox`), which needs Docker Sandboxes installed and signed in.
export const RUNTIME = process.env.LONCA_TEST_RUNTIME ?? 'fake';
export const REAL_SANDBOX = RUNTIME === 'sandbox';
export const FAKE_SANDBOX = !REAL_SANDBOX;
export const FAKE_SBX = path.join(REPO_ROOT, 'tests', 'support', 'fake-sbx');
export const FAKE_SBX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-fake-sbx-'));
process.on('exit', () => fs.rmSync(FAKE_SBX_DIR, { recursive: true, force: true }));

const fakeSbxEnv = { FAKE_SBX_DIR, LONCA_SBX: FAKE_SBX };
// sbx 0.50 hands a sandbox the SSH agent of whoever runs a command in it, so the tests' own
// commands mustn't bring this machine's.
const { SSH_AUTH_SOCK: _ownAgent, ...withoutAgent } = process.env;
const sbxEnv = { ...withoutAgent, FAKE_SBX_DIR };
const SBX = REAL_SANDBOX ? 'sbx' : FAKE_SBX;

export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function sbx(...args: string[]): string {
  return execFileSync(SBX, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: sbxEnv }).trim();
}

function execCommand(sandbox: string, script: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { file: SBX, args: ['exec', '--user', 'agent', sandbox, '--', 'bash', '-c', script], env: sbxEnv };
}

/**
 * How many SSH keys a process in a sandbox can list: through its own agent socket, then straight
 * through sbx's relay on the gateway, which is still there when the sandbox has no socket for it.
 */
export function sandboxSshKeys(sandbox: string): string {
  return sandboxExec(sandbox, `
count() { timeout 5 ssh-add -l 2>/dev/null | grep -c SHA256; }
socat UNIX-LISTEN:/tmp/relay.sock,fork TCP:gateway.docker.internal:3129 2>/dev/null &
relay=$!
sleep 0.5
echo "$(count) $(SSH_AUTH_SOCK=/tmp/relay.sock count)"
kill $relay 2>/dev/null
rm -f /tmp/relay.sock
`).output;
}

/** Runs a script as root in a sandbox, for setting up a test. */
export function asRoot(sandbox: string, script: string): string {
  return execFileSync(SBX, ['exec', '--user', 'root', sandbox, '--', 'bash', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: sbxEnv }).trim();
}

/** Whether a sandbox exists and is running. */
export function sandboxRunning(name: string): boolean | null {
  const found = (JSON.parse(sbx('ls', '--json')) as { name: string; status: string }[]).find((entry) => entry.name === name);
  return found ? /^running/.test(found.status) : null;
}

export function removeSandbox(name: string): void {
  sbx('rm', '--force', name);
}

export function templateImages(): { id: string; repository: string; tag: string }[] {
  return JSON.parse(sbx('template', 'ls', '--json'));
}

/** Which image a template's name points to, if it's there. */
export function templateImage(name: string): string | undefined {
  return templateImages().find((image) => `${image.repository}:${image.tag}` === `docker.io/library/${name}`)?.id;
}

/** Removes a template by its image, as that takes the second name it gets when a VM's made from it. */
export function removeTemplate(name: string): void {
  const id = templateImage(name);
  if (id) sbx('template', 'rm', '--force', id);
}

export function sandboxExec(sandbox: string, script: string): { code: number; output: string } {
  const { file, args, env } = execCommand(sandbox, script);
  try {
    const output = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      // This blocks the test runner, so its own timeouts can't end a command that never returns.
      timeout: 180000,
    });
    return { code: 0, output: output.trim() };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() };
  }
}

/** Like `sandboxExec`, but leaves this process free to answer, for commands that call the mock. */
export function sandboxExecAsync(sandbox: string, script: string): Promise<{ code: number; output: string }> {
  const { file, args, env } = execCommand(sandbox, script);
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, output: `${stdout}${error ? stderr : ''}`.trim() });
    });
  });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' },
  }).trim();
}

export function makeFixtureRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-fixture-')));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n\nA small repository for tests.\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'Initial commit');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=from-local-checkout\n');
  return dir;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(what: string, check: () => T | Promise<T>, timeoutMs = 120000, everyMs = 200): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

export interface LoncaOptions {
  port: number;
  instance: string;
  firstWorkspacePort: number;
}

export class Lonca {
  home: string;
  port: number;
  instance: string;
  firstWorkspacePort: number;
  private process: ChildProcess | null = null;
  log = '';
  env: Record<string, string> = {};

  constructor(options: LoncaOptions) {
    this.port = options.port;
    this.instance = options.instance;
    this.firstWorkspacePort = options.firstWorkspacePort;
    this.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-home-')));
  }

  get prefix(): string {
    return `lonca-${this.instance}`;
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  get token(): string {
    return fs.readFileSync(path.join(this.home, 'token'), 'utf8').trim();
  }

  get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async start(): Promise<void> {
    this.process = spawn('node', [path.join(REPO_ROOT, 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LONCA_HOME: this.home,
        LONCA_INSTANCE: this.instance,
        LONCA_FIRST_PORT: String(this.firstWorkspacePort),
        LONCA_NO_OPEN: '1',
        LONCA_NO_NOTIFY: '1',
        // Saving a made-up key shouldn't need the real service to accept it. Most tests want that.
        LONCA_SKIP_CREDENTIAL_CHECK: '1',
        ...(REAL_SANDBOX ? {} : fakeSbxEnv),
        PORT: String(this.port),
        ...this.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (chunk: Buffer) => {
      this.log += chunk.toString('utf8');
    };
    this.process.stdout!.on('data', collect);
    this.process.stderr!.on('data', collect);
    await until('the server to listen', async () => (await fetch(`${this.url}/api/state`, { headers: this.headers })).ok, 30000);
  }

  /**
   * Cuts this server off from Docker Sandboxes, or reconnects it. Its sandboxes keep running, and
   * so do the test's own commands. Only the stand-in for `sbx` can do this. Commands the server
   * already has running lose their connection too, as they would if the daemon went away.
   */
  setOffline(offline: boolean): void {
    const flag = path.join(FAKE_SBX_DIR, `offline-${this.instance}`);
    if (!offline) {
      fs.rmSync(flag, { force: true });
      return;
    }
    fs.writeFileSync(flag, '');
    if (this.process?.pid) spawnSync('pkill', ['-KILL', '-P', String(this.process.pid)]);
  }

  /** The helper only runs when something needs it, and a sign-in is the first thing to. */
  async startHelper(): Promise<string> {
    const helper = `${this.prefix}-tools`;
    await this.api('POST', '/profiles/claude/login');
    await until('the helper', () => sandboxExec(helper, 'true').code === 0, 300000, 500);
    await this.api('DELETE', '/profiles/claude/login');
    return helper;
  }

  /** Stops the server the way Ctrl-C does. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) return resolve();
      const child = this.process;
      child.once('exit', () => {
        if (this.process === child) this.process = null;
        resolve();
      });
      child.kill('SIGINT');
    });
  }

  /** Stops the server the way a crash would, without any chance to clean up. */
  kill(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) return resolve();
      const gone = this.process.exitCode !== null || this.process.signalCode !== null;
      this.process.once('exit', () => resolve());
      this.process.kill('SIGKILL');
      this.process = null;
      if (gone) resolve();
    });
  }

  async api<T = any>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url}/api${route}`, {
      method,
      headers: { ...this.headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${route} → ${response.status}: ${await response.text()}`);
    const type = response.headers.get('content-type') ?? '';
    if (response.status === 204 || response.status === 202) return undefined as T;
    return (type.includes('json') ? await response.json() : await response.text()) as T;
  }

  async workspace(id: string): Promise<Workspace> {
    const state = await this.api('GET', '/state');
    return state.workspaces.find((entry: Workspace) => entry.id === id);
  }

  async session(id: string): Promise<Session> {
    return (await this.api<SessionSnapshot>('GET', `/sessions/${id}`)).session;
  }

  async items(id: string): Promise<ChatItem[]> {
    return (await this.api<SessionSnapshot>('GET', `/sessions/${id}`)).items;
  }

  async waitForWorkspace(id: string, status = 'ready'): Promise<Workspace> {
    let failure: string | undefined;
    const workspace = await until(`workspace ${id} to be ${status}`, async () => {
      const current = await this.workspace(id);
      if (current.status === 'error' && status !== 'error') failure = current.error;
      return failure || current.status === status ? current : null;
    }, 300000);
    if (failure) throw new Error(`Workspace ${workspace.name} failed: ${failure}`);
    return workspace;
  }

  async waitForIdle(sessionId: string, timeoutMs = 120000): Promise<ChatItem[]> {
    await until(`session ${sessionId} to finish`, async () => {
      const session = await this.session(sessionId);
      return session.status === 'idle' && session.queue.length === 0;
    }, timeoutMs);
    return this.items(sessionId);
  }

  async waitForProject(id: string): Promise<any> {
    const project = await until(`project ${id} to be ready`, async () => {
      const state = await this.api('GET', '/state');
      const current = state.projects.find((entry: { id: string }) => entry.id === id);
      return current?.status === 'ready' || current?.status === 'error' ? current : null;
    }, 120000);
    if (project.status === 'error') throw new Error(`Project ${project.name} failed: ${project.error}`);
    return project;
  }

  openTerminal(id: string): Promise<{ socket: WebSocket; output: () => string; send: (text: string) => void }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${this.port}/ws/terminals/${id}?token=${this.token}`, {
        headers: { origin: this.url },
      });
      let buffer = '';
      socket.on('message', (data, isBinary) => {
        if (isBinary) buffer += data.toString();
      });
      socket.on('open', () => resolve({
        socket,
        output: () => buffer,
        send: (text) => socket.send(Buffer.from(text), { binary: true }),
      }));
      socket.on('error', reject);
    });
  }

  /** What was replaced while a workspace was on it. The server frees that as a workspace goes, but this one's gone first. */
  private removeReplacedTemplates(): void {
    const saved = path.join(this.home, 'state.json');
    if (!fs.existsSync(saved)) return;
    const used = (JSON.parse(fs.readFileSync(saved, 'utf8')) as { workspaces: Workspace[] }).workspaces.map((workspace) => workspace.templateImage);
    const images = templateImages();
    const named = new Set(images.filter((image) => !image.repository.endsWith('/sandbox-kit-assembled')).map((image) => image.id));
    for (const id of new Set(images.map((image) => image.id))) {
      if (used.includes(id) && !named.has(id)) sbx('template', 'rm', '--force', id);
    }
  }

  /** Removes the server, its home directory and every Docker resource it created. */
  async destroy(): Promise<void> {
    this.setOffline(false);
    await this.kill();
    const sandboxes = (JSON.parse(sbx('ls', '--json')) as { name: string }[]).map((entry) => entry.name);
    for (const name of sandboxes.filter((entry) => entry.startsWith(`${this.prefix}-`))) sbx('rm', '--force', name);
    this.removeReplacedTemplates();
    fs.rmSync(this.home, { recursive: true, force: true });
  }
}

/** Points the real CLIs in a sandbox at tests/support/fake-signin.mjs instead of the real services. */
export function installFakeSignIn(sandbox: string): void {
  // Claude is told not to check certificates. Codex does check them, so it gets a CA to trust.
  sandboxExec(sandbox, `mkdir -p /tmp/fake-signin && cd /tmp/fake-signin \
    && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=fake-signin -keyout ca-key.pem -out ca.pem 2>/dev/null \
    && openssl req -newkey rsa:2048 -nodes -subj /CN=auth.openai.com -keyout key.pem -out cert.csr 2>/dev/null \
    && printf 'subjectAltName=DNS:auth.openai.com,DNS:platform.claude.com,DNS:claude.com,DNS:api.anthropic.com\nbasicConstraints=CA:FALSE\n' > cert.ext \
    && openssl x509 -req -days 2 -in cert.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -extfile cert.ext -out cert.pem 2>/dev/null`);
  sbx('cp', path.join(REPO_ROOT, 'tests', 'support', 'fake-signin.mjs'), `${sandbox}:/tmp/fake-signin/server.mjs`);
  // As root, because in a VM only root can have port 443.
  asRoot(sandbox, '(nohup node /tmp/fake-signin/server.mjs </dev/null) >/dev/null 2>&1 &');
  sandboxExec(sandbox, 'for _ in $(seq 1 100); do curl -s -o /dev/null http://127.0.0.1:8080/ && exit 0; sleep 0.1; done; exit 1');
  asRoot(sandbox, `
    echo '127.0.0.1 platform.claude.com claude.com api.anthropic.com auth.openai.com' >> /etc/hosts
    claude=$(command -v claude)
    codex=$(command -v codex)
    mv "$claude" "$claude.real"
    mv "$codex" "$codex.real"
    # The VM's proxy would go to the real service, whatever /etc/hosts says.
    direct='unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy'
    printf '#!/bin/bash\\n%s\\nexport NODE_TLS_REJECT_UNAUTHORIZED=0\\nexec %s.real "$@"\\n' "$direct" "$claude" > "$claude"
    printf '#!/bin/bash\\n%s\\nexport CODEX_CA_CERTIFICATE=/tmp/fake-signin/ca.pem\\nif [ "$1 $2" = "login --device-auth" ]; then exec %s.real login --device-auth --experimental_issuer http://127.0.0.1:8080; fi\\nexec %s.real "$@"\\n' "$direct" "$codex" "$codex" > "$codex"
    chmod +x "$claude" "$codex"
  `);
}

export function setFakeSignIn(sandbox: string, options: { mode?: 'ok' | 'rejected' | 'disabled' | 'denied'; approved?: boolean }): void {
  const lines = [];
  if (options.mode) lines.push(`echo ${options.mode} > /tmp/fake-signin/mode`);
  if (options.approved === true) lines.push('touch /tmp/fake-signin/approved');
  if (options.approved === false) lines.push('rm -f /tmp/fake-signin/approved');
  sandboxExec(sandbox, lines.join('; '));
}

export function removeFakeSignIn(sandbox: string): void {
  asRoot(sandbox, `
    pkill -f '^node /tmp/fake-signin/server.mjs'
    claude=$(command -v claude)
    codex=$(command -v codex)
    mv -f "$claude.real" "$claude"
    mv -f "$codex.real" "$codex"
    grep -v platform.claude.com /etc/hosts > /tmp/hosts.clean && cat /tmp/hosts.clean > /etc/hosts
    rm -rf /tmp/hosts.clean /tmp/fake-signin
    true
  `);
}
