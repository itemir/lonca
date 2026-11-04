import type Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { PORTS_PER_WORKSPACE, PREFIX, paths } from './config.ts';
import {
  CONTAINER_GID, CONTAINER_UID, LABEL, NETWORK, docker, ensureNetwork, exec, isNotFound,
} from './docker.ts';
import { sandboxState, sandboxName, stopSandbox } from './sandbox.ts';
import { KeyedQueue, RuntimeStoppedError, sleep } from './util.ts';

export const CONTAINER_CREDENTIALS = '/var/lib/lonca/credentials';

export interface ContainerSpec {
  name: string;
  hostname: string;
  /** Only resolved when the container has to be created, so a running one never waits on a build. */
  image: () => Promise<string>;
  env: string[];
  labels?: Record<string, string>;
  workdir?: string;
  /** Host paths mounted at the same path in the container, so git's absolute paths resolve in both. */
  binds?: string[];
  homeVolume?: string;
  firstPort?: number;
  network: 'internet' | 'host';
  memoryGb?: number;
  cpus?: number;
}

/**
 * What makes a workspace isolated. Only the paths in `binds` are visible from the host,
 * the process runs unprivileged with no way to regain privileges, and unless the
 * project opts out the entrypoint firewalls off the host, the LAN and other containers.
 * The added capabilities exist for the entrypoint alone, which installs the firewall
 * and then drops them; commands run with `docker exec` as `lonca` never hold them.
 */
function createOptions(spec: ContainerSpec, image: string): Docker.ContainerCreateOptions {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  if (spec.firstPort) {
    for (let port = spec.firstPort; port < spec.firstPort + PORTS_PER_WORKSPACE; port++) {
      exposedPorts[`${port}/tcp`] = {};
      portBindings[`${port}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: String(port) }];
    }
  }
  const volume = (source: string, target: string): Docker.MountSettings => ({
    Type: 'volume',
    Source: source,
    Target: target,
    VolumeOptions: { NoCopy: false, Labels: { [LABEL]: PREFIX }, DriverConfig: { Name: 'local', Options: {} } },
  });
  const mounts: Docker.MountConfig = spec.homeVolume ? [volume(spec.homeVolume, '/home/lonca')] : [];
  return {
    name: spec.name,
    Hostname: spec.hostname,
    Image: image,
    WorkingDir: spec.workdir,
    Env: [...spec.env, `LONCA_NETWORK=${spec.network}`],
    Labels: { [LABEL]: PREFIX, ...spec.labels },
    ExposedPorts: exposedPorts,
    HostConfig: {
      Init: true,
      NetworkMode: NETWORK,
      CapDrop: ['ALL'],
      CapAdd: spec.network === 'internet' ? ['NET_ADMIN', 'SETUID', 'SETGID'] : ['SETUID', 'SETGID'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: 4096,
      Memory: spec.memoryGb ? Math.round(spec.memoryGb * 1024 ** 3) : 0,
      NanoCpus: spec.cpus ? Math.round(spec.cpus * 1e9) : 0,
      Binds: [...(spec.binds ?? []).map((bind) => `${bind}:${bind}:rw`), `${paths.credentials}:${CONTAINER_CREDENTIALS}:rw`],
      Mounts: mounts,
      Tmpfs: { '/run/lonca': `rw,nosuid,nodev,size=1m,uid=${CONTAINER_UID},gid=${CONTAINER_GID}` },
      PortBindings: portBindings,
      ExtraHosts: spec.network === 'host' ? ['host.docker.internal:host-gateway'] : [],
      RestartPolicy: { Name: 'no' },
    },
  };
}

/** Waits for the entrypoint to finish; a failed firewall stops the container here. */
async function waitUntilReady(id: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const info = await docker.getContainer(id).inspect();
    if (!info.State.Running) {
      const logs = await docker.getContainer(id).logs({ stdout: true, stderr: true, tail: 20 });
      throw new Error(`The container exited during startup (code ${info.State.ExitCode}): ${logs.toString('utf8').trim()}`);
    }
    const ready = await exec(id, ['test', '-e', '/run/lonca/ready']);
    if (ready.code === 0) return;
    await sleep(100);
  }
  throw new Error('The container did not finish starting within 20 seconds');
}

const byName = new KeyedQueue();

/** Returns a ready container's id; `start: false` rejects stopped or missing containers. */
export function ensureContainer(spec: ContainerSpec, { start = true }: { start?: boolean } = {}): Promise<string> {
  return byName.run(spec.name, async () => {
    const container = docker.getContainer(spec.name);
    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        if (!start) throw new RuntimeStoppedError('The container is stopped');
        await container.start();
      }
      // Docker reports Running before the entrypoint has finished applying the firewall,
      // including when the container was started outside this server.
      await waitUntilReady(info.Id);
      return info.Id;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (!start) throw new RuntimeStoppedError('The container was removed');
    }
    const image = await spec.image();
    await ensureNetwork();
    fs.mkdirSync(path.join(paths.credentials, 'codex'), { recursive: true, mode: 0o700 });
    const created = await docker.createContainer(createOptions(spec, image));
    await created.start();
    await waitUntilReady(created.id);
    return created.id;
  });
}

export async function stopContainer(name: string): Promise<void> {
  const sandbox = sandboxName(name);
  if (sandbox) return stopSandbox(sandbox);
  try {
    await docker.getContainer(name).stop({ t: 3 });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 304 && status !== 404) throw error;
  }
}

export async function isContainerRunning(name: string): Promise<boolean> {
  return await containerState(name) === 'running';
}

/** A stopped runtime still owns its disk, including unread agent output. */
export async function containerState(name: string): Promise<'running' | 'stopped' | 'missing'> {
  const sandbox = sandboxName(name);
  if (sandbox) return sandboxState(sandbox);
  try {
    return (await docker.getContainer(name).inspect()).State.Running ? 'running' : 'stopped';
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
}
