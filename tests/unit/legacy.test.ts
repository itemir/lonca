import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stopLegacyContainers, type SavedWorkspace } from '../../server/legacy.ts';

const { docker } = vi.hoisted(() => ({ docker: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: docker }));

const legacy = { id: 'w', containerName: 'old-workspace', runtime: 'container', status: 'ready', steps: [] } as unknown as SavedWorkspace;
const listed = (state: string) => JSON.stringify({ ID: 'old-id', Names: legacy.containerName, State: state }) + '\n';

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it('stops only a tracked legacy container and verifies it stopped before migrating', () => {
  docker.mockReturnValueOnce(listed('running') + JSON.stringify({ ID: 'other-id', Names: 'someone-else', State: 'running' }))
    .mockReturnValueOnce('old-id\n').mockReturnValueOnce(listed('exited'));
  stopLegacyContainers([legacy]);
  expect(docker.mock.calls[1][1]).toEqual(['container', 'stop', '--timeout', '10', 'old-id']);
  expect(docker).toHaveBeenCalledTimes(3);
});

it.each(['created', 'exited', 'dead', 'missing'])('accepts a legacy container that is %s without starting or stopping it', (status) => {
  docker.mockReturnValue(status === 'missing' ? '' : listed(status));
  stopLegacyContainers([legacy]);
  expect(docker).toHaveBeenCalledTimes(1);
});

it('does not require Docker for new VMs, older VMs, or archived workspaces', () => {
  stopLegacyContainers([
    { ...legacy, sandboxName: 'new-vm', containerName: undefined },
    { ...legacy, runtime: 'sandbox' },
    { ...legacy, status: 'archived' },
  ]);
  expect(docker).not.toHaveBeenCalled();
});

it('does not trust a successful stop command while the container still runs', () => {
  docker.mockReturnValue(listed('running'));
  expect(() => stopLegacyContainers([legacy])).toThrow(/have not been migrated/);
});

it('keeps the original saved state when Docker cannot confirm the old runtime stopped', async () => {
  vi.resetModules();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-legacy-'));
  vi.stubEnv('LONCA_HOME', home);
  const saved = JSON.stringify({ version: 1, workspaces: [{ ...legacy, runtime: undefined }], sessions: [{ activeRunId: 'still-working' }] });
  fs.writeFileSync(path.join(home, 'state.json'), saved);
  docker.mockImplementation(() => { throw new Error('Docker is unreachable'); });
  try {
    await expect(import('../../server/store.ts')).rejects.toThrow(/have not been migrated/);
    expect(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).toBe(saved);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
