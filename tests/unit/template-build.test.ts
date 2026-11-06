import { beforeEach, expect, it, vi } from 'vitest';

const { cleanUpTemplateBuild, buildTemplate, templateLoaded } = vi.hoisted(() => ({
  cleanUpTemplateBuild: vi.fn(), buildTemplate: vi.fn(), templateLoaded: vi.fn(),
}));
vi.mock('../../server/sandbox.ts', async (original) => ({
  ...(await original<object>()),
  cleanUpTemplateBuild, buildTemplate, templateLoaded,
  removeSandbox: async () => {},
  ensureSandbox: async () => 'helper',
  exec: async () => ({ code: 0, stdout: Buffer.from(JSON.stringify({ models: [{ slug: 'test', visibility: 'list' }] })) }),
}));
vi.mock('../../server/events.ts', () => ({ publish: vi.fn() }));
vi.mock('../../server/store.ts', () => ({
  state: { catalog: {}, catalogTemplate: undefined }, saveState: vi.fn(), getSecrets: () => ({}),
  setBoundaryValue: vi.fn(), writeAtomic: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  cleanUpTemplateBuild.mockResolvedValue(undefined);
  buildTemplate.mockResolvedValue(undefined);
  templateLoaded.mockResolvedValue(true);
});

it('clears a stale builder once even when the template is already available', async () => {
  const { ensureSandboxImage } = await import('../../server/system.ts');
  await Promise.all([ensureSandboxImage(), ensureSandboxImage()]);
  await ensureSandboxImage();
  expect(cleanUpTemplateBuild).toHaveBeenCalledTimes(1);
  expect(buildTemplate).not.toHaveBeenCalled();
});

it.each(['startup', 'rebuild'])('waits for old cleanup when %s arrives first, then shares the active build', async (first) => {
  const cleanup = deferred<void>();
  const build = deferred<void>();
  cleanUpTemplateBuild.mockReturnValue(cleanup.promise);
  buildTemplate.mockReturnValue(build.promise);
  const { ensureSandboxImage, rebuildImage, system } = await import('../../server/system.ts');
  const requests = first === 'startup' ? [ensureSandboxImage(), rebuildImage()] : [rebuildImage(), ensureSandboxImage()];
  expect(buildTemplate).not.toHaveBeenCalled();
  cleanup.resolve();
  await vi.waitFor(() => expect(buildTemplate).toHaveBeenCalledTimes(1));
  const lateStartup = ensureSandboxImage();
  await Promise.resolve();
  expect(cleanUpTemplateBuild).toHaveBeenCalledTimes(1);
  expect(system.image.state).toBe('building');
  build.resolve();
  const tags = await Promise.all([...requests, lateStartup]);
  expect(new Set(tags).size).toBe(1);
  expect(system.image.state).toBe('ready');
  expect(buildTemplate).toHaveBeenCalledTimes(1);
});

it('joins a rebuild that starts while startup is checking the saved template', async () => {
  const lookup = deferred<boolean>();
  const build = deferred<void>();
  templateLoaded.mockReturnValue(lookup.promise);
  buildTemplate.mockReturnValue(build.promise);
  const { ensureSandboxImage, rebuildImage, system } = await import('../../server/system.ts');
  let resolved = false;
  const startup = ensureSandboxImage().then((tag) => { resolved = true; return tag; });
  await vi.waitFor(() => expect(templateLoaded).toHaveBeenCalled());
  const rebuild = rebuildImage();
  lookup.resolve(true);
  await vi.waitFor(() => expect(buildTemplate).toHaveBeenCalledTimes(1));
  expect(resolved).toBe(false);
  expect(system.image.state).toBe('building');
  build.resolve();
  await Promise.all([startup, rebuild]);
  expect(system.image.state).toBe('ready');
});

it('retries failed startup cleanup before allowing a build', async () => {
  cleanUpTemplateBuild.mockRejectedValueOnce(new Error('Runtime unavailable'));
  const { ensureSandboxImage, rebuildImage, system } = await import('../../server/system.ts');
  await expect(ensureSandboxImage()).rejects.toThrow('Runtime unavailable');
  expect(buildTemplate).not.toHaveBeenCalled();
  await rebuildImage();
  expect(cleanUpTemplateBuild).toHaveBeenCalledTimes(2);
  expect(buildTemplate).toHaveBeenCalledTimes(1);
  expect(system.image.state).toBe('ready');
});
