import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, type Duplex } from 'node:stream';
import Docker from 'dockerode';
import { IMAGE_CONTEXT, PREFIX } from './config.ts';
import { removeSandbox, sandboxExec, sandboxName, sandboxStream, sandboxTty } from './sandbox.ts';

function connect(): Docker {
  let host = process.env.DOCKER_HOST;
  if (!host) {
    try {
      // Docker Desktop's socket isn't at the default path, but its context says where it is.
      host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      host = undefined;
    }
  }
  if (host?.startsWith('unix://')) return new Docker({ socketPath: host.slice('unix://'.length) });
  if (host?.startsWith('tcp://')) {
    const url = new URL(host);
    return new Docker({ host: url.hostname, port: Number(url.port) || 2375 });
  }
  return new Docker();
}

export const docker = connect();

export const LABEL = 'dev.lonca.instance';
export const NETWORK = `${PREFIX}-net`;
export const homeVolume = (workspaceId: string) => `${PREFIX}-home-${workspaceId}`;

export const CONTAINER_UID = process.platform === 'darwin' ? 1000 : process.getuid!();
export const CONTAINER_GID = process.platform === 'darwin' ? 1000 : process.getgid!();

export function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 404;
}

export interface ExecOptions {
  env?: string[];
  workdir?: string;
  stdin?: Buffer | string;
  timeoutMs?: number;
  /** Stops reading beyond this many bytes of stdout or stderr. */
  maxBytes?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Runs a command in a workspace as the unprivileged user and collects its output. `containerId`
 * can be a sandbox's handle: everything from here on works on either.
 *
 * Agents control what's in a container, so any file read here could be a FIFO that never
 * ends or a link to /dev/zero. Nothing is allowed to run or grow without limit: `timeout`
 * makes sure the process dies, not just the wait for it.
 */
export async function exec(containerId: string, cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const sandbox = sandboxName(containerId);
  if (sandbox) return sandboxExec(sandbox, cmd, options);
  const hasStdin = options.stdin !== undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const execution = await docker.getContainer(containerId).exec({
    Cmd: ['timeout', '-k', '2', String(Math.ceil(timeoutMs / 1000)), ...cmd],
    User: 'lonca',
    WorkingDir: options.workdir,
    Env: options.env,
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: hasStdin,
  });
  const stream = (await execution.start({ hijack: hasStdin, stdin: hasStdin })) as Duplex;

  let truncated = false;
  const collector = () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const output = new PassThrough();
    output.on('data', (chunk: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        stream.destroy();
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    });
    return { output, chunks };
  };
  const stdout = collector();
  const stderr = collector();
  docker.modem.demuxStream(stream, stdout.output, stderr.output);

  await new Promise<void>((resolve, reject) => {
    // A little later than `timeout` itself, so a normal timeout reports its exit code.
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`Timed out running ${cmd[0]} in the workspace container`));
    }, timeoutMs + 3000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', (error) => {
      clearTimeout(timer);
      // Destroying the stream on purpose isn't a failure.
      if (truncated) resolve();
      else reject(error);
    });
    if (hasStdin) stream.end(options.stdin);
  });

  const info = await execution.inspect();
  return {
    code: info.ExitCode ?? null,
    stdout: Buffer.concat(stdout.chunks),
    stderr: Buffer.concat(stderr.chunks),
    truncated,
  };
}

/** Like `exec`, but rejects on a non-zero exit and returns stdout as text. */
export async function execText(containerId: string, cmd: string[], options: ExecOptions = {}): Promise<string> {
  const result = await exec(containerId, cmd, options);
  if (result.code !== 0) {
    const message = result.stderr.toString('utf8').trim() || result.stdout.toString('utf8').trim();
    throw new Error(message || `${cmd[0]} exited with code ${result.code}`);
  }
  return result.stdout.toString('utf8');
}

export interface OutputStream {
  stdout: PassThrough;
  stderr: PassThrough;
  finished: Promise<void>;
  stop(): void;
}

/** Runs a command and streams its output without buffering it. */
export async function execStream(containerId: string, cmd: string[], options: ExecOptions = {}): Promise<OutputStream> {
  const sandbox = sandboxName(containerId);
  if (sandbox) return sandboxStream(sandbox, cmd, options);
  const execution = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    User: 'lonca',
    WorkingDir: options.workdir,
    Env: options.env,
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = (await execution.start({})) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  const finished = new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', () => resolve());
  });
  return { stdout, stderr, finished, stop: () => stream.destroy() };
}

export interface TtyProcess {
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  exitCode(): Promise<number | null>;
}

/** Starts a command on a pseudo-terminal in a container. */
export async function execTty(
  containerId: string,
  cmd: string[],
  options: { env?: string[]; workdir?: string; cols?: number; rows?: number },
): Promise<TtyProcess> {
  const sandbox = sandboxName(containerId);
  if (sandbox) return sandboxTty(sandbox, cmd, options);
  const execution = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    User: 'lonca',
    WorkingDir: options.workdir,
    Env: options.env,
    Tty: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    ConsoleSize: [options.rows ?? 24, options.cols ?? 80],
  } as Docker.ExecCreateOptions);
  const stream = (await execution.start({ hijack: true, stdin: true, Tty: true })) as Duplex;
  return {
    stream,
    resize: async (cols, rows) => {
      await execution.resize({ h: rows, w: cols });
    },
    exitCode: async () => (await execution.inspect()).ExitCode ?? null,
  };
}

let creatingNetwork: Promise<void> | null = null;

async function createNetworkIfMissing(): Promise<void> {
  try {
    await docker.getNetwork(NETWORK).inspect();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await docker.createNetwork({
      Name: NETWORK,
      Driver: 'bridge',
      Labels: { [LABEL]: PREFIX },
      // Containers on this network can't talk to each other, whatever their firewall says.
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
    });
  }
}

/** Safe to call concurrently: the first workspaces often start at the same moment. */
export function ensureNetwork(): Promise<void> {
  creatingNetwork ??= createNetworkIfMissing().finally(() => {
    creatingNetwork = null;
  });
  return creatingNetwork;
}

export async function removeVolume(name: string): Promise<void> {
  try {
    await docker.getVolume(name).remove();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function removeContainer(name: string): Promise<void> {
  const sandbox = sandboxName(name);
  if (sandbox) return removeSandbox(sandbox);
  try {
    await docker.getContainer(name).remove({ force: true });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 404) throw error;
  }
}

function imageHash(): string {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(IMAGE_CONTEXT).sort()) {
    hash.update(name);
    hash.update(fs.readFileSync(path.join(IMAGE_CONTEXT, name)));
  }
  hash.update(`${CONTAINER_UID}:${CONTAINER_GID}`);
  return hash.digest('hex').slice(0, 12);
}

/** The tags change whenever the images' inputs do, so upgrades rebuild them automatically. */
export const imageTag = () => `lonca-workspace:${imageHash()}`;
export const sandboxImageTag = () => `lonca-sandbox:${imageHash()}`;

export async function imageExists(tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function buildImage(tag: string, options: { fresh?: boolean; dockerfile?: string }, onLog: (text: string) => void): Promise<void> {
  const args = [
    'build',
    '--file', path.join(IMAGE_CONTEXT, options.dockerfile ?? 'Dockerfile'),
    '--build-arg', `LONCA_UID=${CONTAINER_UID}`,
    '--build-arg', `LONCA_GID=${CONTAINER_GID}`,
    '--progress', 'plain',
    '-t', tag,
    ...(options.fresh ? ['--pull', '--no-cache'] : []),
    IMAGE_CONTEXT,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk: Buffer) => onLog(chunk.toString('utf8'));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker build exited with code ${code}`));
    });
  });
}

/** Writes an image to a tar file, to hand it to Docker Sandboxes. */
export function saveImage(tag: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['image', 'save', '--output', file, tag], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `docker image save exited with code ${code}`));
    });
  });
}
