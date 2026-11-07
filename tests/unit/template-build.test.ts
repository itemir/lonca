import { beforeEach, expect, it, vi } from 'vitest';

const { cleanUpTemplateBuild, buildTemplate, templateLoaded, listTemplates, removeTemplateImage, workspaces, projects } = vi.hoisted(() => ({
  cleanUpTemplateBuild: vi.fn(), buildTemplate: vi.fn(), templateLoaded: vi.fn(), listTemplates: vi.fn(), removeTemplateImage: vi.fn(),
  workspaces: [] as { templateImage?: string }[],
  projects: [] as { settings: { image: string } }[],
}));
vi.mock('../../server/sandbox.ts', async (original) => ({
  ...(await original<object>()),
  cleanUpTemplateBuild, buildTemplate, templateLoaded, listTemplates, removeTemplateImage,
  removeSandbox: async () => {},
  ensureSandbox: async () => 'helper',
  exec: async () => ({ code: 0, stdout: Buffer.from(JSON.stringify({ models: [{ slug: 'test', visibility: 'list' }] })) }),
}));
vi.mock('../../server/events.ts', () => ({ publish: vi.fn() }));
vi.mock('../../server/store.ts', () => ({
  state: { catalog: {}, catalogTemplate: undefined, workspaces, projects }, saveState: vi.fn(), getSecrets: () => ({}),
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
  listTemplates.mockResolvedValue([]);
  removeTemplateImage.mockResolvedValue(undefined);
  workspaces.length = 0;
  projects.length = 0;
});

// What's listed, given that the server's own template is one of them.
async function serverWith(...others: [string, string][]) {
  const system = await import('../../server/system.ts');
  const entry = ([id, name]: [string, string]) => {
    const [repository, tag] = name.split(':');
    return { id, repository: `docker.io/library/${repository}`, tag };
  };
  const list = (...listed: [string, string][]) => listTemplates.mockResolvedValue([...listed, ...others].map(entry));
  list(['current', system.system.image.tag]);
  return { ...system, list };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
const removed = () => removeTemplateImage.mock.calls.map(([id]) => id);

it('frees what’s under Lonca’s own name when it starts, once, keeping what a workspace needs and others’ names', async () => {
  workspaces.push({ templateImage: 'needed' });
  const { ensureSandboxImage } = await serverWith(
    ['old', 'lonca-sandbox:old'], ['old', 'sandbox-kit-assembled:old-copy'],
    ['needed', 'lonca-sandbox:needed'], ['mine', 'my-template:1'], ['second', 'lonca-instance-sandbox:other'],
    ['orphan', 'sandbox-kit-assembled:someone-elses'],
  );
  await ensureSandboxImage();
  await ensureSandboxImage();
  await settled();
  expect(removed()).toEqual(['old']);
  expect(listTemplates).toHaveBeenCalledTimes(1);
});

it('keeps one of Lonca’s own templates that a project has chosen', async () => {
  projects.push({ settings: { image: 'lonca-sandbox:pinned' } }, { settings: { image: '' } });
  const { ensureSandboxImage } = await serverWith(['pinned', 'lonca-sandbox:pinned'], ['old', 'lonca-sandbox:old']);
  await ensureSandboxImage();
  await settled();
  expect(removed()).toEqual(['old']);
});

it('frees old templates once the current one has been built, and not if it couldn’t be', async () => {
  templateLoaded.mockResolvedValue(false);
  buildTemplate.mockRejectedValueOnce(new Error('no network'));
  const { ensureSandboxImage, list, system } = await serverWith(['old', 'lonca-sandbox:old']);
  list(['current', system.image.tag]);
  await expect(ensureSandboxImage()).rejects.toThrow('no network');
  await settled();
  expect(removed()).toEqual([]);
  buildTemplate.mockResolvedValueOnce(undefined);
  await ensureSandboxImage();
  await settled();
  expect(removed()).toEqual(['old']);
});

it('frees what a build replaced, unless a workspace’s VM was made from it, and removes nothing if the build fails', async () => {
  const { rebuildImage, list, system } = await serverWith();
  list(['new', system.image.tag], ['replaced', 'sandbox-kit-assembled:replaced-copy'], ['needed', 'sandbox-kit-assembled:needed-copy']);
  workspaces.push({ templateImage: 'needed' });
  buildTemplate.mockResolvedValueOnce('replaced');
  await rebuildImage();
  await settled();
  expect(removed()).toEqual(['replaced']);
  removeTemplateImage.mockClear();
  buildTemplate.mockResolvedValueOnce('needed');
  await rebuildImage();
  await settled();
  expect(removed()).toEqual([]);
  buildTemplate.mockRejectedValueOnce(new Error('no network'));
  await expect(rebuildImage()).rejects.toThrow('no network');
  await settled();
  expect(removed()).toEqual([]);
});

it('frees a released image only once no workspace is left that needs it', async () => {
  const { releaseTemplateImage, list, system } = await serverWith();
  list(['current', system.image.tag], ['old', 'sandbox-kit-assembled:old-copy']);
  workspaces.push({ templateImage: 'old' });
  releaseTemplateImage('old');
  await settled();
  expect(removed()).toEqual([]);
  workspaces.length = 0;
  releaseTemplateImage('old');
  await settled();
  expect(removed()).toEqual(['old']);
});

it('never removes the current template, and removes nothing if it isn’t listed', async () => {
  const { releaseTemplateImage, list, system } = await serverWith();
  list(['current', system.image.tag]);
  releaseTemplateImage('current');
  await settled();
  expect(removed()).toEqual([]);
  listTemplates.mockResolvedValue([{ id: 'old', repository: 'docker.io/library/lonca-sandbox', tag: 'old' }]);
  releaseTemplateImage('old');
  await settled();
  expect(removed()).toEqual([]);
});

it('carries on past an image it can’t remove, and past failing to list them', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { releaseTemplateImage, list, system } = await serverWith();
  list(['current', system.image.tag], ['a', 'sandbox-kit-assembled:a-copy'], ['b', 'sandbox-kit-assembled:b-copy']);
  removeTemplateImage.mockRejectedValueOnce(new Error('sbx is busy'));
  releaseTemplateImage('a');
  releaseTemplateImage('b');
  await settled();
  expect(removed()).toEqual(['a', 'b']);
  expect(logged).toHaveBeenCalledWith('could not remove an old template:', 'sbx is busy');
  listTemplates.mockRejectedValueOnce(new Error('not signed in'));
  releaseTemplateImage('b');
  await settled();
  expect(logged).toHaveBeenCalledWith('could not remove an old template:', 'not signed in');
  logged.mockRestore();
});

it('runs one removal at a time, so that a request during one is looked at after it', async () => {
  const { releaseTemplateImage, list, system } = await serverWith();
  list(['current', system.image.tag], ['a', 'sandbox-kit-assembled:a-copy'], ['b', 'sandbox-kit-assembled:b-copy']);
  const first = deferred<void>();
  removeTemplateImage.mockReturnValueOnce(first.promise);
  releaseTemplateImage('a');
  await settled();
  releaseTemplateImage('b');
  await settled();
  expect(removed()).toEqual(['a']);
  first.resolve();
  await settled();
  expect(removed()).toEqual(['a', 'b']);
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
