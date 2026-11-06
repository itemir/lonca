import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../server/ssh-agent.ts', () => ({ emptyAgent: async () => '' }));
let root: string;
let sandbox: typeof import('../../server/sandbox.ts');
const calls = () => fs.readFileSync(path.join(root, 'calls'), 'utf8').split('\n').filter(Boolean);
const until = async (check: () => boolean) => {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-logout-test-'));
  vi.stubEnv('LONCA_HOME', root);
  vi.stubEnv('LONCA_SBX', path.join(root, 'sbx'));
  vi.stubEnv('LONCA_TEST_RUNTIME_FILES', root);
  // `logout` waits for the test to let it finish, or fail.
  fs.writeFileSync(path.join(root, 'sbx'), `#!/bin/sh
dir="$LONCA_TEST_RUNTIME_FILES"
echo "$1" >> "$dir/calls"
if [ "$1" = logout ]; then
  while [ ! -e "$dir/release" ]; do sleep 0.02; done
  if [ -e "$dir/fail" ]; then echo 'error: something went wrong' >&2; exit 1; fi
fi
`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'calls'), '');
  sandbox = await import('../../server/sandbox.ts');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('runs one sign-out for overlapping requests, and runs nothing in a sandbox until it’s over', async () => {
  const first = sandbox.sbxLogout();
  await until(() => calls().includes('logout'));
  const second = sandbox.sbxLogout();
  await expect(sandbox.exec('box', ['true'])).rejects.toThrow('Docker Sandboxes is signing out.');
  fs.writeFileSync(path.join(root, 'release'), '');
  await Promise.all([first, second]);
  expect(calls().filter((call) => call === 'logout')).toHaveLength(1);
  expect(calls()).not.toContain('exec');
  await sandbox.exec('box', ['true']);
  expect(calls()).toContain('exec');
});

it('tells everyone waiting when it fails, and lets sandboxes be used again', async () => {
  fs.writeFileSync(path.join(root, 'fail'), '');
  const first = sandbox.sbxLogout();
  await until(() => calls().includes('logout'));
  const second = sandbox.sbxLogout();
  fs.writeFileSync(path.join(root, 'release'), '');
  await expect(first).rejects.toThrow('something went wrong');
  await expect(second).rejects.toThrow('something went wrong');
  await sandbox.exec('box', ['true']);
  // And a later one is a new one.
  fs.rmSync(path.join(root, 'fail'));
  await sandbox.sbxLogout();
  expect(calls().filter((call) => call === 'logout')).toHaveLength(2);
});
