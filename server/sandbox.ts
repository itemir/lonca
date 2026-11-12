import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import type { SandboxStatus } from '../shared/types.ts';
import { LONCA_HOME, PORTS_PER_WORKSPACE, PREFIX, TEMPLATE_DIR, TEMPLATE_NAME, TTY_DIR } from './config.ts';
import { forgetSbxLogin, recordSbxLogin } from './sbx-login-pid.ts';
import { emptyAgent } from './ssh-agent.ts';
import { KeyedQueue, RuntimeStoppedError, errorMessage, newId, removeTree, sleep } from './util.ts';

// Docker Sandboxes gives each workspace a microVM with its own kernel, driven through the `sbx`
// CLI. It's the only place Lonca runs anything other than its own server.

const SANDBOX_USER = 'agent';

const CREATE_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const LIST_CACHE_MS = 1500;

export class SandboxError extends Error {}

/**
 * Docker Sandboxes didn't answer in time, which is no fault in Lonca. A sandbox can be slow to come
 * back, and on a Mac, Node's timers count time asleep: a command that was waiting when the computer
 * went to sleep is overdue as it wakes if it slept for longer than the command had left.
 */
export class SandboxTimeoutError extends SandboxError {
  readonly status = 504;
  readonly sandbox: string | undefined;
  constructor(message: string, sandbox?: string) {
    super(message);
    this.sandbox = sandbox;
  }
}

export interface ExecOptions {
  env?: string[];
  workdir?: string;
  stdin?: Buffer | string;
  timeoutMs?: number;
  /** Stops reading beyond this many bytes of stdout or stderr. */
  maxBytes?: number;
  /** Only for preparing a VM. Everything else runs as the unprivileged user. */
  user?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
}

export interface OutputStream {
  stdout: PassThrough;
  stderr: PassThrough;
  finished: Promise<void>;
  stop(): void;
}

export interface TtyProcess {
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  exitCode(): Promise<number | null>;
}

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

const SIGNED_OUT = 'Docker Sandboxes isn’t signed in. Sign in to Docker in Lonca’s Settings, then try again.';

function failureFrom(stderr: string, fallback: string): SandboxError {
  const text = stderr.trim();
  if (/not signed in/i.test(text)) return new SandboxError(SIGNED_OUT);
  return new SandboxError(text || fallback);
}

/** Runs an `sbx` management command and returns its stdout, rejecting if it fails. */
async function sbx(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const environment = await cliEnv();
  // Starting one is the other way to undo what signing out is doing, and publishing a port on a
  // stopped one starts it.
  if (args[0] === 'run' || args[0] === 'ports') refuseWhileSigningOut();
  return new Promise((resolve, reject) => {
    const child = spawn(sbxPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SandboxTimeoutError(`sbx ${args[0]} took too long`));
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

export interface SbxLogin {
  stdout: NodeJS.ReadableStream;
  exited: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

/**
 * Starts `sbx login` on this computer, not in a VM: it's the user's own login, which the helper
 * needs as much as any workspace. It prints a one-time code and waits until someone's used it.
 * Its own prompts would be no use here, so it gets no input.
 */
export async function startSbxLogin(): Promise<SbxLogin> {
  const environment = await cliEnv();
  const sbxCommand = sbxPath();
  const child = spawn(sbxCommand, ['login'], { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  // For the next server, should this one be killed before it can end it.
  if (child.pid) recordSbxLogin(child.pid, `${sbxCommand} login`);
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const finish = (code: number | null) => resolve({ code, stderr: Buffer.concat(stderr).toString('utf8').slice(-4096) });
    child.on('close', finish);
    child.on('error', (error) => {
      stderr.push(Buffer.from(`error: ${errorMessage(error)}\n`));
      finish(null);
    });
  });
  let closed = false;
  // A sign-in nobody's following any more shouldn't stay waiting for one.
  const leaving = () => child.kill('SIGTERM');
  process.once('exit', leaving);
  void exited.then(() => {
    closed = true;
    process.off('exit', leaving);
    if (child.pid) forgetSbxLogin(child.pid);
  });
  return {
    stdout: child.stdout,
    exited,
    // Asked first, so it can tell Docker it's given up, and then made to.
    kill: () => {
      if (closed) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 5000).unref();
    },
  };
}

// While sbx is stopping every sandbox, `sbx exec` would start one again, and a check just before
// can't tell. So nothing new runs in one until it's done, by which time it isn't signed in.
let signingOut: Promise<void> | null = null;

function refuseWhileSigningOut(): void {
  if (signingOut) throw new SandboxError('Docker Sandboxes is signing out.');
}

/**
 * Signs this computer's Docker Sandboxes out, which stops every sandbox running on it, Lonca's or
 * not. Asking again meanwhile waits for the same one, and gets its answer.
 */
export function sbxLogout(): Promise<void> {
  signingOut ??= sbx(['logout', '--force'], { timeoutMs: CREATE_TIMEOUT_MS }).then(() => {}).finally(() => {
    signingOut = null;
    afterSignInChange();
  });
  return signingOut;
}

/** What Lonca knew about sandboxes may no longer be so, once someone else may be signed in. */
export function afterSignInChange(): void {
  forgetListing();
  booted.clear();
  // Harmless if a policy is there, and it may not be for an account that's new to this computer.
  policyReady = false;
}

// Why Docker Sandboxes can't be used, in the terms the settings page explains it.

function missing(): SandboxStatus {
  if (process.platform === 'darwin' && process.arch !== 'arm64') {
    return { state: 'unsupported', detail: 'Docker Sandboxes needs a Mac with Apple silicon.' };
  }
  return {
    state: 'not-installed',
    ...(process.platform === 'darwin' ? { install: 'brew trust docker/tap && brew install docker/tap/sbx' } : {}),
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

/** Decides whether workspaces can run. */
export async function detectSandboxes(): Promise<SandboxStatus> {
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

export interface TemplateImage {
  id: string;
  repository: string;
  tag: string;
}

export function parseTemplateList(output: string): TemplateImage[] {
  return (JSON.parse(output.trim() || '[]') as TemplateImage[] | null) ?? [];
}

export async function listTemplates(): Promise<TemplateImage[]> {
  return parseTemplateList(await sbx(['template', 'ls', '--json']));
}

const isOwnTemplate = (image: TemplateImage) => image.repository === `docker.io/library/${TEMPLATE_NAME}`;
// Docker Sandboxes gives a template this second name when a VM is first made from it, and an image
// stays on disk until all its names have gone. Saving over a template leaves it with only this one.
const isVmCopy = (image: TemplateImage) => image.repository === 'docker.io/library/sandbox-kit-assembled';

/** The image a template's name points to now. */
export function imageNamed(images: TemplateImage[], name: string): string | undefined {
  return images.find((image) => `${image.repository}:${image.tag}` === imageReference(name))?.id;
}

export function ownTemplateImages(images: TemplateImage[]): string[] {
  return images.filter(isOwnTemplate).map((image) => image.id);
}

/**
 * Which of these can go: those still there, apart from any to keep or with a name that isn't
 * Lonca's to remove, such as a project's own template or Docker's that Lonca's are built from.
 */
export function removableImages(images: TemplateImage[], candidates: string[], keep: Set<string | undefined>): string[] {
  const listed = new Set(images.map((image) => image.id));
  const namedByOthers = new Set(images.filter((image) => !isOwnTemplate(image) && !isVmCopy(image)).map((image) => image.id));
  return [...new Set(candidates)].filter((id) => listed.has(id) && !keep.has(id) && !namedByOthers.has(id));
}

/** By ID, which takes all its names at once, and can't catch a newer image that's taken one of them. */
export async function removeTemplateImage(id: string): Promise<void> {
  await sbx(['template', 'rm', '--force', id]);
}

let tag: string | undefined;

/** Changes with what a template is made from, so upgrades rebuild it by themselves. Read once, so that editing those files doesn't rebuild it under a running server. */
export function templateTag(): string {
  if (!tag) {
    const hash = crypto.createHash('sha256');
    for (const name of fs.readdirSync(TEMPLATE_DIR).sort()) {
      hash.update(name);
      hash.update(fs.readFileSync(path.join(TEMPLATE_DIR, name)));
    }
    tag = `${TEMPLATE_NAME}:${hash.digest('hex').slice(0, 12)}`;
  }
  return tag;
}

const BUILD_TIMEOUT_MS = 20 * 60 * 1000;
// Docker's fullest, with compilers and Java, rather than the smaller one `sbx run shell` picks.
const BASE_TEMPLATE = 'docker/sandbox-templates:shell-docker';
const BUILDER = `${PREFIX}-template`;
const BUILD_DIR = path.join(LONCA_HOME, 'template-build');

/** Clears what building a template leaves while it runs, which a server stopping partway leaves behind. */
export async function cleanUpTemplateBuild(): Promise<void> {
  await removeSandbox(BUILDER);
  await removeTree(BUILD_DIR);
}

/**
 * Makes the template new workspaces start from: a VM from Docker's own, with what Lonca adds
 * installed in it, saved. Returns the image that saving over the template took its name from,
 * which would otherwise be forgotten and stay on disk under its VM copy.
 */
export async function buildTemplate(tag: string, options: { fresh?: boolean }, onLog: (text: string) => void): Promise<string | undefined> {
  const name = BUILDER;
  const staging = BUILD_DIR;
  const replaced = imageNamed(await listTemplates().catch(() => []), tag);
  try {
    await cleanUpTemplateBuild();
    fs.cpSync(TEMPLATE_DIR, staging, { recursive: true });
    await ensurePolicy();
    onLog('Starting a virtual machine to build it in…\n');
    await sbx(['run', '--detach', '--name', name, '--template', BASE_TEMPLATE, '--pull', options.fresh ? 'always' : 'missing', '--skills', 'off', 'shell', staging], { timeoutMs: BUILD_TIMEOUT_MS });
    await sbx(['policy', 'allow', 'network', '--sandbox', name, '**']);
    onLog('Installing Claude Code and Codex…\n');
    const build = await exec(name, ['bash', path.join(staging, 'build.sh'), staging], { user: 'root', timeoutMs: BUILD_TIMEOUT_MS });
    onLog(build.stdout.toString('utf8') + build.stderr.toString('utf8'));
    if (build.code !== 0) throw new SandboxError(`Installing into the template failed with code ${build.code}`);
    onLog('Saving it…\n');
    await sbx(['stop', name], { timeoutMs: CREATE_TIMEOUT_MS });
    await sbx(['template', 'save', name, tag], { timeoutMs: BUILD_TIMEOUT_MS });
    return replaced;
  } finally {
    await cleanUpTemplateBuild().catch(() => {});
  }
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

/** The host, the LAN, private ranges and cloud metadata addresses, kept out of every sandbox on the internet-only setting. */
export const BLOCKED_DESTINATIONS = [
  'localhost', 'host.docker.internal', '127.0.0.0/8', '::1/128',
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4', 'fc00::/7', 'fe80::/10',
];

/** A credential the proxy adds for one sandbox, from a file on this computer that no sandbox has mounted. */
export type ProxySecret = { file: string } & (
  /** A service sbx knows about, which has a placeholder of its own. */
  | { service: string }
  /** Anything else. The proxy swaps the placeholder in request headers, on these hosts only. */
  | { hosts: string[]; placeholder: string }
);

/** The file may not exist yet, which only means not signed in, so nothing checks it now. */
export function secretArgs(sandbox: string, secret: ProxySecret): string[] {
  const source = ['--sandbox', sandbox, '--command', `/bin/cat '${secret.file.replaceAll("'", "'\\''")}'`, '--refresh', 'on-demand', '--no-verify'];
  return 'service' in secret
    ? ['secret', 'set', secret.service, ...source, '--force']
    : ['secret', 'set-custom', ...secret.hosts.flatMap((host) => ['--host', host]), '--placeholder', secret.placeholder, ...source];
}

export interface SandboxSetup {
  command: string[];
  stdin?: string;
}

export interface SandboxSpec {
  name: string;
  /** Only resolved when the sandbox has to be created. */
  image: () => Promise<string>;
  env: string[];
  /** Host paths mounted at the same path in the VM, so git's absolute paths resolve in both. */
  mounts: string[];
  /** A directory for what has to outlive the VM. */
  agentState: string;
  /** Applied before anything runs in the VM, including one that was made before these changed. */
  secrets: ProxySecret[];
  /** Finishes preparing the VM once it's booted, which can be a long time after this is asked for. */
  setup?: () => SandboxSetup;
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
      args.push('--publish', portSpec(port, port));
    }
  }
  if (spec.network === 'internet') {
    for (const destination of BLOCKED_DESTINATIONS) args.push('--deny-network', destination);
  }
  args.push('shell', ...spec.mounts, spec.agentState);
  return args;
}

/** On loopback only, as the ten a workspace is created with are. Unpublishing names it the same way. */
export function portSpec(hostPort: number, port: number): string {
  return `127.0.0.1:${hostPort}:${port}`;
}

/** Forwards a port of this computer to one in a sandbox. sbx publishes it again whenever the sandbox restarts. */
export async function publishPort(name: string, hostPort: number, port: number): Promise<void> {
  await sbx(['ports', name, '--publish', portSpec(hostPort, port)]);
}

export async function unpublishPort(name: string, hostPort: number, port: number): Promise<void> {
  await sbx(['ports', name, '--unpublish', portSpec(hostPort, port)]);
}

/** The global policy may only allow some sites. A workspace has the internet. */
export function allowRule(network: SandboxSpec['network']): string {
  return network === 'host' ? '**,localhost' : '**';
}

const TERMINAL_PROMPT = fs.readFileSync(new URL('./terminal-prompt.sh', import.meta.url), 'utf8').trimEnd();

// A sandbox doesn't run an entrypoint of ours, so this runs after starting one. It's sent rather
// than kept in the template so that it also works on VMs made from older ones.
export const SANDBOX_BOOT = String.raw`
set -eu
state="$1"
mkdir -p "$HOME/.claude" "$HOME/.codex"
[ -e "$HOME/.claude.json" ] || echo '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}' > "$HOME/.claude.json"

# Its disks are sparse files on the host. The root one gives back what's deleted from it by itself,
# Docker's only when mounted to, and every boot mounts it afresh.
sudo -n mount -o remount,discard /var/lib/docker 2>/dev/null || true

# Rebuilding a workspace replaces its VM, and conversations have to outlive that to be resumed.
mkdir -p "$state/claude-projects" "$state/codex-sessions"
ln -sfn "$state/claude-projects" "$HOME/.claude/projects"
ln -sfn "$state/codex-sessions" "$HOME/.codex/sessions"

# Terminal attachments end at reboot. Agent output survives until Lonca has read and saved it.
boot=$(cat /proc/sys/kernel/random/boot_id)
if [ "$(cat /var/tmp/lonca/boot 2>/dev/null)" != "$boot" ]; then
  rm -rf /var/tmp/lonca/tty
  mkdir -p /var/tmp/lonca/tty
  echo "$boot" > /var/tmp/lonca/boot
fi

# Terminals go by the project and branch. ~/.bashrc sets a prompt of its own, so its end sources
# this. A VM where that can't be done still works, with the prompt it had.
{
  cat > /var/tmp/lonca/terminal-prompt.sh <<'LONCA_PROMPT'
${TERMINAL_PROMPT}
LONCA_PROMPT
  grep -qsF /var/tmp/lonca/terminal-prompt.sh "$HOME/.bashrc" ||
    printf '\n[ ! -f /var/tmp/lonca/terminal-prompt.sh ] || . /var/tmp/lonca/terminal-prompt.sh\n' >> "$HOME/.bashrc"
} || true
`;

const byName = new KeyedQueue();
const booted = new Set<string>();
// A sandbox has no environment of its own that reaches `sbx exec`, so it goes with each command.
const environments = new Map<string, string[]>();

/** Returns a ready sandbox's name; `start: false` rejects stopped or missing sandboxes. */
export function ensureSandbox(spec: SandboxSpec, { start = true }: { start?: boolean } = {}): Promise<string> {
  return byName.run(spec.name, async () => {
    environments.set(spec.name, spec.env);
    // A passive caller must not reuse a pre-stop listing or wait behind another
    // lookup and then start a VM which has since stopped.
    if (!start) forgetListing();
    const known = (await listSandboxes()).find((entry) => entry.name === spec.name);
    if (!start && !known?.running) throw new RuntimeStoppedError('The sandbox is stopped or was removed');
    if (known?.running && booted.has(spec.name)) return spec.name;
    for (const dir of [...spec.mounts, spec.agentState]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
    for (const secret of spec.secrets) await sbx(secretArgs(spec.name, secret));
    const boot = (): SandboxSetup => ({ command: ['bash', '-c', SANDBOX_BOOT, 'lonca-boot', spec.agentState] });
    for (const step of [boot, ...(spec.setup ? [spec.setup] : [])]) {
      const { command, stdin } = step();
      const result = await exec(spec.name, command, { stdin, timeoutMs: 30000 });
      if (result.code !== 0) throw new SandboxError(`The sandbox didn’t finish starting: ${result.stderr.toString('utf8').trim()}`);
    }
    booted.add(spec.name);
    return spec.name;
  });
}

/**
 * A sandbox is given its secrets as it boots, so one added since, for a new sign-in, goes to those
 * already running here. One that isn't gets them all the next time it starts, and so does one this
 * fails for, the next time anything uses it.
 */
export function addSandboxSecret(name: string, secret: ProxySecret): Promise<void> {
  return byName.run(name, async () => {
    if (!booted.has(name)) return;
    try {
      if (await sandboxState(name) !== 'running') return;
      await sbx(secretArgs(name, secret));
    } catch (error) {
      booted.delete(name);
      throw error;
    }
  });
}

// Names that `sbx` itself needs from its environment, so a project's variable can't go there.
const OWN_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|DOCKER_.*|SBX_.*|XDG_.*|SSH_AUTH_SOCK)$/;

// A template saved from a VM can't carry an environment, so these go with every command.
const BASE_ENV: Record<string, string> = {
  DISABLE_AUTOUPDATER: '1',
  CODEX_DISABLE_UPDATE_CHECK: '1',
  GIT_TERMINAL_PROMPT: '0',
  PIP_BREAK_SYSTEM_PACKAGES: '1',
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  // Some versions of sbx plant a placeholder key of their own, for a service Lonca doesn't use for
  // Claude, and Claude would take that over the placeholder for a sign-in token.
  ANTHROPIC_API_KEY: '',
};

/**
 * Builds `sbx exec` arguments. Values travel in the CLI's environment with only their names on
 * the command line, since any process on the host can read a command line and these hold tokens.
 */
export function execArgs(
  name: string,
  cmd: string[],
  options: { env?: string[]; workdir?: string; interactive?: boolean; user?: string },
): { args: string[]; env: Record<string, string> } {
  const args = ['exec'];
  // A command gets a pipe for stdin even without --interactive, and tools that check for piped
  // input then read it instead of their files: rg finds nothing. So they get /dev/null.
  const command = options.interactive ? cmd : ['sh', '-c', 'exec "$@" </dev/null', 'sh', ...cmd];
  if (options.interactive) args.push('--interactive');
  args.push('--user', options.user ?? SANDBOX_USER);
  if (options.workdir) args.push('--workdir', options.workdir);
  const values = new Map(Object.entries(BASE_ENV));
  for (const entry of [...(environments.get(name) ?? []), ...(options.env ?? [])]) {
    const equals = entry.indexOf('=');
    values.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  const env: Record<string, string> = {};
  for (const [key, value] of values) {
    if (OWN_ENV.test(key) || value === '' || value === BASE_ENV[key]) {
      args.push(`--env=${key}=${value}`);
    } else {
      env[key] = value;
      args.push(`--env=${key}`);
    }
  }
  args.push(name, '--', ...command);
  return { args, env };
}

/**
 * Runs a command in a sandbox as the unprivileged user and collects its output.
 *
 * Agents control what's in a sandbox, so any file read here could be a FIFO that never ends or a
 * link to /dev/zero. Nothing is allowed to run or grow without limit: `timeout` makes sure the
 * process dies, not just the wait for it.
 */
export async function exec(name: string, cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const hasStdin = options.stdin !== undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { args, env } = execArgs(name, ['timeout', '-k', '2', String(Math.ceil(timeoutMs / 1000)), ...cmd], { ...options, interactive: hasStdin });
  const environment = await cliEnv(env);
  refuseWhileSigningOut();
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
      reject(new SandboxTimeoutError(`Timed out running ${cmd[0]} in the workspace’s sandbox`, name));
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

/** Like `exec`, but rejects on a non-zero exit and returns stdout as text. */
export async function execText(name: string, cmd: string[], options: ExecOptions = {}): Promise<string> {
  const result = await exec(name, cmd, options);
  if (result.code !== 0) {
    const message = result.stderr.toString('utf8').trim() || result.stdout.toString('utf8').trim();
    throw new Error(message || `${cmd[0]} exited with code ${result.code}`);
  }
  return result.stdout.toString('utf8');
}

/** Runs a command and streams its output without buffering it. */
export async function execStream(name: string, cmd: string[], options: ExecOptions = {}): Promise<OutputStream> {
  const { args, env } = execArgs(name, cmd, options);
  const environment = await cliEnv(env);
  refuseWhileSigningOut();
  const child = spawn(sbxPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
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
export async function execTty(
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
  const environment = await cliEnv(env);
  refuseWhileSigningOut();
  const child = spawn(sbxPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: environment });
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
      await exec(
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
