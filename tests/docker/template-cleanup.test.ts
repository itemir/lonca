import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project, Workspace } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, removeTemplate, sandboxExec, sbx, templateImage, templateImages, until } from '../support/harness.ts';

// Runs Lonca's real removal of old templates, on real virtual machines under `npm run test:sandbox`.
// A second instance's templates have a name of their own, so this can't touch a user's.
const lonca = new Lonca({ port: 47431, instance: 'template-test', firstWorkspacePort: 47500 });
let fixture: string;
let project: Project;

const currentTag = async (): Promise<string> => (await lonca.api('GET', '/state')).system.image.tag;
const currentImage = async (): Promise<string> => templateImage(await currentTag())!;
const listed = (id: string) => templateImages().some((image) => image.id === id);
const newWorkspace = async (): Promise<Workspace> => lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
const rebuildImage = async (): Promise<void> => {
  await lonca.api('POST', '/image/rebuild');
  await until('the build to finish', async () => (await lonca.api('GET', '/state')).system.image.state === 'ready', 500000, 1000);
};

beforeAll(async () => {
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
}, 600000);

afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('old templates', () => {
  it('keeps one a workspace’s VM was made from, which can still be saved, and frees it after', async () => {
    const workspace = await newWorkspace();
    const original = await currentImage();
    expect(templateImages().filter((image) => image.id === original).length).toBeGreaterThan(1);

    await rebuildImage();
    const rebuilt = await currentImage();
    expect(rebuilt).not.toBe(original);
    expect(listed(original)).toBe(true);

    // What the README tells people to do, which needs the image the VM was made from.
    sbx('stop', workspace.sandboxName);
    const saved = `${lonca.prefix}-saved:1`;
    sbx('template', 'save', workspace.sandboxName, saved);
    removeTemplate(saved);
    expect(listed(original)).toBe(true);

    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    await until('the old template to go', () => !listed(original), 60000, 500);
    expect(listed(rebuilt)).toBe(true);
    expect(await currentImage()).toBe(rebuilt);
  }, 900000);

  it('frees one when the last workspace on it moves to a newer one', async () => {
    const workspace = await newWorkspace();
    const before = await currentImage();
    await rebuildImage();
    expect(listed(before)).toBe(true);

    await lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
    await lonca.waitForWorkspace(workspace.id);
    await until('the template it was on to go', () => !listed(before), 60000, 500);

    // Only possible if its VM really did move, as the image it was on has gone.
    expect(sandboxExec(workspace.sandboxName, 'true').code).toBe(0);
    sbx('stop', workspace.sandboxName);
    const saved = `${lonca.prefix}-saved:2`;
    sbx('template', 'save', workspace.sandboxName, saved);
    removeTemplate(saved);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    expect(listed(await currentImage())).toBe(true);
  }, 900000);

  it('frees one that nothing needs as soon as it’s replaced', async () => {
    const before = await currentImage();
    await rebuildImage();
    await until('the template it replaced to go', () => !listed(before), 60000, 500);
    expect(listed(await currentImage())).toBe(true);
  }, 900000);

  it('clears what’s under its own name when it starts, leaving a project’s template alone', async () => {
    const workspace = await newWorkspace();
    const tag = await currentTag();
    const stale = `${tag.split(':')[0]}:stale`;
    const mine = `${lonca.prefix}-mine:1`;
    sbx('stop', workspace.sandboxName);
    sbx('template', 'save', workspace.sandboxName, stale);
    sbx('template', 'save', workspace.sandboxName, mine);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    const staleImage = templateImage(stale)!;

    await lonca.stop();
    await lonca.start();
    await until('the stale template to go', () => !listed(staleImage), 60000, 500);
    expect(templateImage(tag)).toBeDefined();
    expect(templateImage(mine)).toBeDefined();

    // A workspace on a project's own template doesn't take it away when it goes.
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: mine } });
    const onMine = await newWorkspace();
    await lonca.api('DELETE', `/workspaces/${onMine.id}`);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: '' } });
    expect(templateImage(mine)).toBeDefined();
    removeTemplate(mine);
  }, 600000);
});
