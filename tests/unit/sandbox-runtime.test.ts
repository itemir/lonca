import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../server/ssh-agent.ts', () => ({ emptyAgent: async () => '' }));
let root: string;
let sandbox: typeof import('../../server/sandbox.ts');
let spec: import('../../server/sandbox.ts').SandboxSpec;
const running = '[{"name":"test","status":"running"}]';

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-runtime-test-'));
  vi.stubEnv('LONCA_HOME', root);
  vi.stubEnv('LONCA_SBX', path.join(root, 'sbx'));
  vi.stubEnv('LONCA_TEST_RUNTIME_FILES', root);
  fs.writeFileSync(path.join(root, 'state'), running);
  fs.writeFileSync(path.join(root, 'sbx'), `#!/bin/sh
echo "$1" >> "$LONCA_TEST_RUNTIME_FILES/calls"
case "$1" in
  ls)
    [ ! -e "$LONCA_TEST_RUNTIME_FILES/unavailable" ] || exit 1
    cat "$LONCA_TEST_RUNTIME_FILES/state"
    ;;
  run) printf '%s' '${running}' > "$LONCA_TEST_RUNTIME_FILES/state" ;;
esac
`, { mode: 0o700 });
  sandbox = await import('../../server/sandbox.ts');
  spec = { name: 'test', image: async () => 'image', env: ['LONCA_PORT=12345'], mounts: [], credentials: path.join(root, 'credentials'), agentState: path.join(root, 'agent-state'), network: 'host' };
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each(['stopped', 'missing'] as const)('observes a fresh %s state instead of waking a previously initialized sandbox', async (state) => {
  await sandbox.ensureSandbox(spec);
  fs.writeFileSync(path.join(root, 'calls'), '');
  fs.writeFileSync(path.join(root, 'state'), state === 'missing' ? '[]' : '[{"name":"test","status":"stopped"}]');
  await expect(sandbox.ensureSandbox(spec, { start: false })).rejects.toThrow(/stopped|removed/);
  expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('ls\n');
  await sandbox.ensureSandbox(spec);
  expect(fs.readFileSync(path.join(root, 'state'), 'utf8')).toBe(running);
});

it('propagates an unavailable sandbox service without running any commands in it', async () => {
  await sandbox.ensureSandbox(spec);
  fs.writeFileSync(path.join(root, 'calls'), '');
  fs.writeFileSync(path.join(root, 'unavailable'), '');
  await expect(sandbox.ensureSandbox(spec, { start: false })).rejects.toThrow(/sbx ls/);
  expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('ls\n');
});
