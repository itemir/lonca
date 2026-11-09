import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project } from '../../shared/types.ts';

let home: string;
let fixture: string;
let project: Project;
let makeCheckout: typeof import('../../server/projects.ts').makeCheckout;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' },
}).trim();
const checkout = (name: string) => path.join(home, 'projects', 'p', 'workspaces', name);
const cache = () => path.join(home, 'projects', 'p', 'cache.git');

beforeEach(async () => {
  vi.resetModules();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-checkout-')));
  vi.stubEnv('LONCA_HOME', home);
  fixture = path.join(home, 'local');
  fs.mkdirSync(fixture);
  git(fixture, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(fixture, 'README.md'), 'hello\n');
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'First');
  git(fixture, 'commit', '--quiet', '--allow-empty', '-m', 'Second');
  project = {
    id: 'p', name: 'Project', slug: 'p', remoteUrl: null, localPath: fixture, githubOwner: null, status: 'ready', createdAt: 1,
    settings: { defaultBranch: 'main', env: {}, image: '', network: 'internet', filesToCopy: [], setupScript: '', memoryGb: 0, cpus: 0 },
  };
  ({ makeCheckout } = await import('../../server/projects.ts'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it('copies Lonca’s copy of the repository into a checkout of its own, on a new branch at its base', async () => {
  expect(await makeCheckout(project, checkout('kyiv'), 'me/kyiv', 'main')).toBeUndefined();
  const history = path.join(checkout('kyiv'), '.git');
  expect(git(history, 'rev-parse', 'refs/heads/me/kyiv')).toBe(git(fixture, 'rev-parse', 'main'));
  expect(git(history, 'symbolic-ref', 'HEAD')).toBe('refs/heads/me/kyiv');
  expect(git(history, 'config', 'core.bare')).toBe('false');
  expect(fs.readFileSync(path.join(history, 'info', 'exclude'), 'utf8')).toBe('.context/\n');
  // Its files are written in the VM, so none are here yet, and no index says they are.
  expect(fs.readdirSync(checkout('kyiv'))).toEqual(['.git']);
  expect(fs.existsSync(path.join(history, 'index'))).toBe(false);
  // Nothing goes back into Lonca's copy, and nothing is left beside the checkout.
  expect(git(cache(), 'for-each-ref', 'refs/heads')).toBe('');
  expect(fs.readdirSync(path.dirname(checkout('kyiv')))).toEqual(['kyiv']);
});

it('brings Lonca’s copy up to date for each new checkout, and branches from the last fetch when it can’t', async () => {
  await makeCheckout(project, checkout('kyiv'), 'me/kyiv', 'main');
  git(fixture, 'commit', '--quiet', '--allow-empty', '-m', 'Third');
  await makeCheckout(project, checkout('oslo'), 'me/oslo', 'main');
  expect(git(checkout('oslo'), 'rev-parse', 'HEAD')).toBe(git(fixture, 'rev-parse', 'main'));
  fs.renameSync(fixture, `${fixture}-moved`);
  expect(await makeCheckout(project, checkout('lima'), 'me/lima', 'main')).toEqual(expect.any(String));
  expect(git(checkout('lima'), 'rev-parse', 'HEAD')).toBe(git(`${fixture}-moved`, 'rev-parse', 'main'));
});

it('says when there’s no base branch to start from, and leaves nothing behind', async () => {
  await expect(makeCheckout(project, checkout('kyiv'), 'me/kyiv', 'nope')).rejects.toThrow('There’s no nope branch to start from');
  expect(fs.existsSync(path.dirname(checkout('kyiv')))).toBe(false);
});

it('removes a copy that was cut short', async () => {
  await makeCheckout(project, checkout('kyiv'), 'me/kyiv', 'main');
  // Something cp can't read, which git never looks at, so only the copy fails.
  fs.writeFileSync(path.join(cache(), 'unreadable'), '');
  fs.chmodSync(path.join(cache(), 'unreadable'), 0o000);
  await expect(makeCheckout(project, checkout('oslo'), 'me/oslo', 'main')).rejects.toThrow();
  expect(fs.readdirSync(path.dirname(checkout('oslo')))).toEqual(['kyiv']);
});
