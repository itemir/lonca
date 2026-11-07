import fs from 'node:fs';
import os from 'node:os';
import { beforeEach, expect, it, vi } from 'vitest';

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../../server/events.ts', () => ({ publish }));
vi.mock('../../server/store.ts', () => ({
  state: { catalog: {}, workspaces: [], projects: [] }, saveState: vi.fn(), getSecrets: () => ({}),
  setBoundaryValue: vi.fn(), writeAtomic: vi.fn(),
}));

const GB = 1e9;
// Free space by directory. A directory that isn't here can't be read.
let free: Record<string, number>;

async function server() {
  const { LONCA_HOME } = await import('../../server/config.ts');
  const system = await import('../../server/system.ts');
  return { ...system, LONCA_HOME };
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  publish.mockClear();
  vi.spyOn(os, 'homedir').mockReturnValue('/home/someone');
  free = {};
  vi.spyOn(fs, 'statfsSync').mockImplementation(((dir: string) => {
    if (!(dir in free)) throw Object.assign(new Error('no such directory'), { code: 'ENOENT' });
    return { bavail: free[dir] / 4096, bsize: 4096 };
  }) as unknown as typeof fs.statfsSync);
});

it('says nothing while there’s room', async () => {
  const { checkDisk, system, LONCA_HOME } = await server();
  free['/home/someone'] = 100 * GB;
  free[LONCA_HOME] = 100 * GB;
  checkDisk();
  expect(system.lowDisk).toBeUndefined();
  expect(publish).not.toHaveBeenCalled();
});

it('warns below 20 GB with what’s left, telling the page only when that changes', async () => {
  const { checkDisk, system, LONCA_HOME } = await server();
  free[LONCA_HOME] = 100 * GB;
  free['/home/someone'] = 19.6 * GB;
  checkDisk();
  expect(system.lowDisk).toEqual({ freeGb: 19 });
  checkDisk();
  expect(publish).toHaveBeenCalledTimes(1);
  free['/home/someone'] = 0.4 * GB;
  checkDisk();
  expect(system.lowDisk).toEqual({ freeGb: 0 });
  free['/home/someone'] = 30 * GB;
  checkDisk();
  expect(system.lowDisk).toBeUndefined();
  expect(publish).toHaveBeenCalledTimes(3);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'system', system: expect.not.objectContaining({ lowDisk: expect.anything() }) }));
});

it('goes by whichever disk has less room, and leaves out one it can’t read', async () => {
  const { checkDisk, system, LONCA_HOME } = await server();
  free['/home/someone'] = 100 * GB;
  free[LONCA_HOME] = 5 * GB;
  checkDisk();
  expect(system.lowDisk).toEqual({ freeGb: 5 });
  delete free[LONCA_HOME];
  free['/home/someone'] = 8 * GB;
  checkDisk();
  expect(system.lowDisk).toEqual({ freeGb: 8 });
  delete free['/home/someone'];
  checkDisk();
  expect(system.lowDisk).toBeUndefined();
});
