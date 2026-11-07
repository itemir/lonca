import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../server/ssh-agent.ts', () => ({ emptyAgent: async () => '' }));
let root: string;
let sandbox: typeof import('../../server/sandbox.ts');
const calls = () => fs.readFileSync(path.join(root, 'calls'), 'utf8').split('\n').filter(Boolean);
const TAG = 'lonca-sandbox:now';
const BASE = { id: 'base', repository: 'docker.io/docker/sandbox-templates', tag: 'shell-docker' };
const template = (id: string, name = 'now') => ({ id, repository: 'docker.io/library/lonca-sandbox', tag: name });
const write = (file: string, content: unknown) => fs.writeFileSync(path.join(root, file), JSON.stringify(content));
const build = () => sandbox.buildTemplate(TAG, { fresh: true }, () => {});

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-template-cleanup-test-'));
  vi.stubEnv('LONCA_HOME', root);
  vi.stubEnv('LONCA_SBX', path.join(root, 'sbx'));
  vi.stubEnv('LONCA_INSTANCE', '');
  vi.stubEnv('LONCA_TEST_RUNTIME_FILES', root);
  // A file named after a command makes that command fail.
  fs.writeFileSync(path.join(root, 'sbx'), `#!/bin/sh
dir="$LONCA_TEST_RUNTIME_FILES"
echo "$*" >> "$dir/calls"
case "$1 $2" in
  "template ls") [ ! -e "$dir/fail-list" ] || { echo 'error: could not list' >&2; exit 1; }; cat "$dir/templates" ;;
  "template save") [ ! -e "$dir/fail-save" ] || { echo 'error: could not save' >&2; exit 1; } ;;
  "ls --json") echo '[]' ;;
esac
`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'calls'), '');
  sandbox = await import('../../server/sandbox.ts');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('reports the image a build took its name from, having looked before it saved', async () => {
  write('templates', [BASE, template('was')]);
  await expect(build()).resolves.toBe('was');
  const listed = calls().indexOf('template ls --json');
  expect(listed).toBeGreaterThanOrEqual(0);
  expect(listed).toBeLessThan(calls().findIndex((call) => call.startsWith('template save')));
});

it('reports nothing for a template that wasn’t there, and builds even if it can’t tell', async () => {
  write('templates', [BASE]);
  await expect(build()).resolves.toBeUndefined();
  fs.writeFileSync(path.join(root, 'fail-list'), '');
  await expect(build()).resolves.toBeUndefined();
  expect(calls().filter((call) => call.startsWith('template save'))).toHaveLength(2);
});

it('fails as it did when the build fails', async () => {
  write('templates', [BASE, template('was')]);
  fs.writeFileSync(path.join(root, 'fail-save'), '');
  await expect(build()).rejects.toThrow('could not save');
});

it('removes an image by its ID', async () => {
  await sandbox.removeTemplateImage('abc123');
  expect(calls()).toEqual(['template rm --force abc123']);
});

it('reads the list from `sbx template ls --json`', async () => {
  write('templates', [BASE, template('was')]);
  await expect(sandbox.listTemplates()).resolves.toEqual([BASE, template('was')]);
});

it('gives a second instance templates of its own, so it can’t take the main server’s', async () => {
  vi.resetModules();
  vi.stubEnv('LONCA_INSTANCE', 'test');
  const second = await import('../../server/sandbox.ts');
  const main = template('main', 'x');
  const own = { id: 'own', repository: 'docker.io/library/lonca-instance-sandbox', tag: 'y' };
  expect(sandbox.templateTag()).toMatch(/^lonca-sandbox:[0-9a-f]{12}$/);
  expect(second.templateTag()).toMatch(/^lonca-instance-sandbox:[0-9a-f]{12}$/);
  expect(sandbox.ownTemplateImages([main, own])).toEqual(['main']);
  expect(second.ownTemplateImages([main, own])).toEqual(['own']);
  expect(second.removableImages([main, own], ['main', 'own'], new Set())).toEqual(['own']);
});
