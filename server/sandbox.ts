import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import type { SandboxStatus } from '../shared/types.ts';
import { PORTS_PER_WORKSPACE, RUNTIME_CHOICE, TTY_DIR } from './config.ts';
import type { ExecOptions, ExecResult, OutputStream, TtyProcess } from './docker.ts';
import { emptyAgent } from './ssh-agent.ts';
import { KeyedQueue, RuntimeStoppedError, errorMessage, newId, sleep } from './util.ts';

// Docker Sandboxes gives each workspace a microVM with its own kernel, driven through the `sbx`
// CLI. Where it isn't available, workspaces run in containers instead (see containers.ts).

const SANDBOX_USER = 'agent';
const HANDLE_PREFIX = 'sbx:';

const CREATE_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const LIST_CACHE_MS = 1500;

/** Stands for a sandbox wherever a container id is expected. A container's id can't contain a colon. */
export function sandboxHandle(name: string): string {
  return `${HANDLE_PREFIX}${name}`;
}

export function sandboxName(handle: string): string | null {
  return handle.startsWith(HANDLE_PREFIX) ? handle.slice(HANDLE_PREFIX.length) : null;
}

export class SandboxError extends Error {}

/** `sbx` isn't always on the PATH of a server started some other way than from a terminal. */
function findSbx(): string | null {
  if (process.env.LONCA_SBX) return fs.existsSync(process.env.LONCA_SBX) ? process.env.LONCA_SBX : null;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of dirs) {
    const candidate = path.join(dir || '.', 'sbx');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function sbxPath(): string {
  const found = findSbx();
  if (!found) throw new SandboxError('Lonca can’t find the sbx command, which this workspace needs. Reinstall Docker Sandboxes.');
  return found;
}

/**
 * The environment for `sbx`. A sandbox can get the SSH agent of the last command run in it, so the
 * user's never goes along: an agent with no keys does, which also takes back one that an
 * `sbx exec` from a terminal left there (see ssh-agent.ts). Lonca's own automated calls aren't
 * commands the user ran, so they're left out of Docker's usage figures.
 */
async function cliEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const { SSH_AUTH_SOCK: _omitted, ...env } = process.env;
  const agent = await emptyAgent();
  return { ...env, SBX_NO_TELEMETRY: '1', ...extra, SSH_AUTH_SOCK: agent };
}

function failureFrom(stderr: string, fallback: string): SandboxError {
  const text = stderr.trim();
  if (/not signed in/i.test(text)) return new SandboxError('Docker Sandboxes isn’t signed in. Run `sbx login` in a terminal, then try again.');
  return new SandboxError(text || fallback);
}

/** Runs an `sbx` management command and returns its stdout, rejecting if it fails. */
async function sbx(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const environment = await cliEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(sbxPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SandboxError(`sbx ${args[0]} took too long`));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(failureFrom(Buffer.concat(stderr).toString('utf8'), `sbx ${args[0]} exited with code ${code}`));
    });
  });
}

export function parseSandboxList(output: string): { name: string; running: boolean }[] {
  const parsed = JSON.parse(output.trim() || '[]') as { name?: unknown; status?: unknown }[] | null;
  return (parsed ?? [])
    .filter((entry) => typeof entry.name === 'string')
    .map((entry) => ({ name: entry.name as string, running: /^running/i.test(String(entry.status)) }));
}

let listing: Promise<{ name: string; running: boolean }[]> | null = null;
let listedAt = 0;

/** Pages ask about workspaces constantly, so one answer serves them for a moment. */
function listSandboxes(): Promise<{ name: string; running: boolean }[]> {
  if (listing && Date.now() - listedAt < LIST_CACHE_MS) return listing;
  listedAt = Date.now();
  const current = sbx(['ls', '--json']).then(parseSandboxList);
  listing = current;
  current.catch(() => {
    if (listing === current) listing = null;
  });
  return current;
}

function forgetListing(): void {
  listing = null;
}

export async function isSandboxRunning(name: string): Promise<boolean> {
  return await sandboxState(name) === 'running';
}

export async function sandboxState(name: string): Promise<'running' | 'stopped' | 'missing'> {
  // Lifecycle checks must not reuse a pre-stop listing: sbx exec would boot the
  // VM again if that cached answer still said it was running.
  forgetListing();
  const entry = (await listSandboxes()).find((entry) => entry.name === name);
  return entry ? entry.running ? 'running' : 'stopped' : 'missing';
}

async function exists(name: string): Promise<boolean> {
  forgetListing();
  return (await listSandboxes()).some((entry) => entry.name === name);
}

export async function stopSandbox(name: string): Promise<void> {
  if (await exists(name)) await sbx(['stop', name], { timeoutMs: CREATE_TIMEOUT_MS });
  forgetListing();
}

export async function removeSandbox(name: string): Promise<void> {
  booted.delete(name);
  environments.delete(name);
  if (await exists(name)) await sbx(['rm', '--force', name], { timeoutMs: CREATE_TIMEOUT_MS });
  forgetListing();
}

// Why Docker Sandboxes can't be used, in the terms the settings page explains it.

function missing(): SandboxStatus {
  if (process.platform === 'darwin' && process.arch !== 'arm64') {
    return { state: 'unsupported', detail: 'Docker Sandboxes needs a Mac with Apple silicon.' };
  }
  return {
    state: 'not-installed',
    ...(process.platform === 'darwin' ? { install: 'brew trust docker/tap && brew install docker/tap/sbx && sbx login' } : {}),
  };
}

let virtualizationChecked = false;

/** A machine without hardware virtualization, such as a VM with no nesting, can have `sbx` and still not run sandboxes. */
async function virtualizationProblem(): Promise<string | null> {
  if (virtualizationChecked) return null;
  try {
    const report = JSON.parse(await sbx(['diagnose', '--json'])) as { checks?: { name?: string; status?: string; message?: string; hint?: string }[] };
    const check = report.checks?.find((entry) => entry.name === 'Virtualization');
    if (check?.status === 'fail') return [check.message, check.hint].filter(Boolean).join('. ');
    virtualizationChecked = true;
    return null;
  } catch {
    // A failed report says nothing about the machine, and sbx itself just worked.
    return null;
  }
}

/** Decides whether new workspaces can have a VM. */
export async function detectSandboxes(): Promise<SandboxStatus> {
  if (RUNTIME_CHOICE === 'container') return { state: 'off' };
  if (!findSbx()) return missing();
  let version: string | undefined;
  try {
    version = /\bv?\d+\.\d+\.\d+\S*/.exec(await sbx(['version']))?.[0];
    await sbx(['ls', '--json']);
  } catch (error) {
    const message = errorMessage(error);
    return /signed in/i.test(message) ? { state: 'signed-out', version } : { state: 'unavailable', version, detail: message };
  }
  const problem = await virtualizationProblem();
  if (problem) return { state: 'unavailable', version, detail: problem };
  return { state: 'ready', version, sshAgentForwarding: await sshAgentForwarding() };
}

/** Whether Docker Sandboxes passes SSH agents into sandboxes at all, which it does unless told not to. */
async function sshAgentForwarding(): Promise<boolean> {
  try {
    return !/^\s*false\b/i.test(await sbx(['settings', 'get', 'ssh.agentForwardingEnabled']));
  } catch {
    return true;
  }
}

function imageReference(image: string): string {
  const slash = image.indexOf('/');
  const first = slash < 0 ? '' : image.slice(0, slash);
  if (!first || (!/[.:]/.test(first) && first !== 'localhost')) image = `docker.io/${image}`;
  image = image.replace(/^index\.docker\.io\//, 'docker.io/');
  if (image.startsWith('docker.io/') && !image.slice('docker.io/'.length).includes('/')) {
    image = `docker.io/library/${image.slice('docker.io/'.length)}`;
  }
  if (!image.includes('@') && image.lastIndexOf(':') < image.lastIndexOf('/')) image += ':latest';
  return image;
}

/** Matches whole references from `sbx template ls --quiet`, including Docker Hub's expanded names. */
export function templateListIncludes(listed: string, image: string): boolean {
  const wanted = imageReference(image);
  return listed.split(/\r?\n/).some((line) => line.trim() !== '' && imageReference(line.trim()) === wanted);
}

export async function templateLoaded(image: string): Promise<boolean> {
  return templateListIncludes(await sbx(['template', 'ls', '--quiet']), image);
}

/** Sandboxes have an image store of their own, separate from Docker's. */
export async function loadTemplate(tarFile: string): Promise<void> {
  await sbx(['template', 'load', tarFile], { timeoutMs: 15 * 60 * 1000 });
}

// The first sandbox on a machine needs a network policy to exist, and only an interactive
// terminal gets asked for one. "Balanced" is Docker's recommended starting point. Each sandbox
// then gets its own rules below, whatever this says. It fails harmlessly if there's one already.
let policyReady = false;

async function ensurePolicy(): Promise<void> {
  if (policyReady) return;
  await sbx(['policy', 'init', 'balanced']).catch(() => {});
  policyReady = true;
}

/** The host, the LAN, private ranges and cloud metadata addresses, as a container's firewall blocks them. */
export const BLOCKED_DESTINATIONS = [
  'localhost', 'host.docker.internal', '127.0.0.0/8', '::1/128',
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4', 'fc00::/7', 'fe80::/10',
];

export interface SandboxSpec {
  name: string;
  /** Only resolved when the sandbox has to be created. */
  image: () => Promise<string>;
  env: string[];
  /** Host paths mounted at the same path in the VM, so git's absolute paths resolve in both. */
  mounts: string[];
  /** Where the shared Codex login lives on the host. */
  credentials: string;
  /** A directory for what has to outlive the VM. */
  agentState: string;
  firstPort?: number;
  network: 'internet' | 'host';
  memoryGb?: number;
  cpus?: number;
}

export function createArgs(spec: SandboxSpec, image: string): string[] {
  const args = ['run', '--detach', '--name', spec.name, '--template', image, '--pull', 'never', '--skills', 'off'];
  if (spec.memoryGb) args.push('--memory', `${Math.round(spec.memoryGb * 1024)}m`);
  if (spec.cpus) args.push('--cpus', String(Math.ceil(spec.cpus)));
  if (spec.firstPort) {
    for (let port = spec.firstPort; port < spec.firstPort + PORTS_PER_WORKSPACE; port++) {
      args.push('--publish', `127.0.0.1:${port}:${port}`);
    }
  }
  if (spec.network === 'internet') {
    for (const destination of BLOCKED_DESTINATIONS) args.push('--deny-network', destination);
  }
  args.push('shell', ...spec.mounts, spec.credentials, spec.agentState);
  return args;
}

/** The global policy may only allow some sites. A workspace has the internet, as a container does. */
export function allowRule(network: SandboxSpec['network']): string {
  return network === 'host' ? '**,localhost' : '**';
}

const byName = new KeyedQueue();
const booted = new Set<string>();
// A sandbox has no environment of its own that reaches `sbx exec`, so it goes with each command.
const environments = new Map<string, string[]>();

/** Returns a ready sandbox's handle; `start: false` rejects stopped or missing sandboxes. */
export function ensureSandbox(spec: SandboxSpec, { start = true }: { start?: boolean } = {}): Promise<string> {
  return byName.run(spec.name, async () => {
    environments.set(spec.name, spec.env);
    const handle = sandboxHandle(spec.name);
    // A passive caller must not reuse a pre-stop listing or wait behind another
    // lookup and then start a VM which has since stopped.
    if (!start) forgetListing();
    const known = (await listSandboxes()).find((entry) => entry.name === spec.name);
    if (!start && !known?.running) throw new RuntimeStoppedError('The sandbox is stopped or was removed');
    if (known?.running && booted.has(spec.name)) return handle;
    for (const dir of [...spec.mounts, path.join(spec.credentials, 'codex'), spec.agentState]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!known) {
      const image = await spec.image();
      await ensurePolicy();
      await sbx(createArgs(spec, image), { timeoutMs: CREATE_TIMEOUT_MS });
      try {
        await sbx(['policy', 'allow', 'network', '--sandbox', spec.name, allowRule(spec.network)]);
      } catch (error) {
        // Starting it again wouldn't add the rule, so this one has to go for a retry to work.
        await sbx(['rm', '--force', spec.name]).catch(() => {});
        throw error;
      }
    } else if (!known.running) {
      await sbx(['run', '--detach', '--name', spec.name], { timeoutMs: CREATE_TIMEOUT_MS });
    }
    forgetListing();
    const boot = await sandboxExec(spec.name, ['lonca-boot', spec.credentials, spec.agentState], { timeoutMs: 30000 });
    if (boot.code !== 0) throw new SandboxError(`The sandbox didn’t finish starting: ${boot.stderr.toString('utf8').trim()}`);
    booted.add(spec.name);
    return handle;
  });
}

// Names that `sbx` itself needs from its environment, so a project's variable can't go there.
const OWN_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|DOCKER_.*|SBX_.*|XDG_.*|SSH_AUTH_SOCK)$/;

/**
 * Builds `sbx exec` arguments. Values travel in the CLI's environment with only their names on
 * the command line, since any process on the host can read a command line and these hold tokens.
 */
export function execArgs(
  name: string,
  cmd: string[],
  options: { env?: string[]; workdir?: string; interactive?: boolean },
): { args: string[]; env: Record<string, string> } {
  const args = ['exec'];
  // A command gets a pipe for stdin even without --interactive, and tools that check for piped
  // input then read it instead of their files: rg finds nothing. Docker gives these /dev/null.
  const command = options.interactive ? cmd : ['sh', '-c', 'exec "$@" </dev/null', 'sh', ...cmd];
  if (options.interactive) args.push('--interactive');
  args.push('--user', SANDBOX_USER);
  if (options.workdir) args.push('--workdir', options.workdir);
  // sbx plants placeholder keys in every sandbox, for its proxy to swap for real ones. Lonca hands
  // out credentials itself, and Claude would take this placeholder over a sign-in token.
  const values = new Map([['ANTHROPIC_API_KEY', '']]);
  for (const entry of [...(environments.get(name) ?? []), ...(options.env ?? [])]) {
    const equals = entry.indexOf('=');
    values.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  const env: Record<string, string> = {};
  for (const [key, value] of values) {
    if (OWN_ENV.test(key) || value === '') {
      args.push(`--env=${key}=${value}`);
    } else {
      env[key] = value;
      args.push(`--env=${key}`);
    }
  }
  args.push(name, '--', ...command);
  return { args, env };
}

/** The sandbox counterpart of `exec` in docker.ts, with the same limits for the same reasons. */
export async function sandboxExec(name: string, cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const hasStdin = options.stdin !== undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { args, env } = execArgs(name, ['timeout', '-k', '2', String(Math.ceil(timeoutMs / 1000)), ...cmd], { ...options, interactive: hasStdin });
  const environment = await cliEnv(env);
  return new Promise((resolve, reject) => {
    const child = spawn(sbxPath(), args, { stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: environment });
    let truncated = false;
    const collector = (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        if (bytes >= maxBytes) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        bytes += chunk.length;
        chunks.push(chunk);
      });
      return chunks;
    };
    const stdout = collector(child.stdout!);
    const stderr = collector(child.stderr!);
    // A little later than `timeout` itself, so a normal timeout reports its exit code.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SandboxError(`Timed out running ${cmd[0]} in the workspace’s sandbox`));
    }, timeoutMs + 5000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const errors = Buffer.concat(stderr);
      // 125 is sbx saying it couldn't run the command, as opposed to the command's own result.
      if (!truncated && (code === 125 || /^error: not signed in/m.test(errors.toString('utf8')))) {
        reject(failureFrom(errors.toString('utf8'), `sbx couldn’t run ${cmd[0]}`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(stdout), stderr: errors, truncated });
    });
    if (hasStdin) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(options.stdin);
    }
  });
}

/** Runs a command and streams its output without buffering it. */
export async function sandboxStream(name: string, cmd: string[], options: ExecOptions = {}): Promise<OutputStream> {
  const { args, env } = execArgs(name, cmd, options);
  const child = spawn(sbxPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: await cliEnv(env) });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const finished = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
  return { stdout, stderr, finished, stop: () => child.kill('SIGKILL') };
}

/**
 * Starts a command on a pseudo-terminal. `sbx exec -t` needs a real terminal on this side, which
 * a server doesn't have, so lonca-pty makes one inside the VM and the rest goes over plain pipes.
 */
export async function sandboxTty(
  name: string,
  cmd: string[],
  options: { env?: string[]; workdir?: string; cols?: number; rows?: number },
): Promise<TtyProcess> {
  const ttyFile = `${TTY_DIR}/${newId()}.tty`;
  const { args, env } = execArgs(
    name,
    ['lonca-pty', ttyFile, String(options.cols ?? 80), String(options.rows ?? 24), ...cmd],
    { ...options, interactive: true },
  );
  const child = spawn(sbxPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: await cliEnv(env) });
  child.stdin.on('error', () => {});
  const stream = new Duplex({
    read() {},
    write(chunk, encoding, done) {
      child.stdin.write(chunk, encoding, () => done());
    },
    destroy(error, done) {
      child.kill('SIGKILL');
      done(error);
    },
  });
  // What's inside the terminal all arrives on stdout, so stderr can only be sbx reporting a failure.
  child.stdout.on('data', (chunk: Buffer) => stream.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stream.push(chunk));
  let closed = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      closed = true;
      stream.push(null);
      resolve(code);
    });
    child.on('error', (error) => {
      closed = true;
      stream.destroy(error);
      resolve(null);
    });
  });
  stream.on('error', () => {});

  // A browser window being dragged resizes many times, and only the last size matters.
  let wanted: { cols: number; rows: number } | null = null;
  let resizing: Promise<void> | null = null;
  const resizeLoop = async () => {
    while (wanted) {
      const { cols, rows } = wanted;
      wanted = null;
      // Resizes can be queued while a stream is disconnecting. Observing a TTY
      // must not boot its stopped VM, even if the CLI hasn't reported exit yet.
      if (closed || stream.destroyed) continue;
      const running = await isSandboxRunning(name).catch(() => false);
      if (!running || closed || stream.destroyed) continue;
      await sandboxExec(
        name,
        ['bash', '-c', 'stty -F "$(head -c 64 "$0")" cols "$1" rows "$2"', ttyFile, String(cols), String(rows)],
        { timeoutMs: 10000 },
      ).catch(() => {});
    }
    resizing = null;
  };
  return {
    stream,
    resize: async (cols, rows) => {
      wanted = { cols, rows };
      resizing ??= sleep(0).then(resizeLoop);
      await resizing;
    },
    exitCode: () => exited,
  };
}
