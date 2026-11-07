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
printf '%s\n' "$*" >> "$LONCA_TEST_RUNTIME_FILES/args"
case "$1" in
  ls)
    [ ! -e "$LONCA_TEST_RUNTIME_FILES/unavailable" ] || exit 1
    cat "$LONCA_TEST_RUNTIME_FILES/state"
    ;;
  run) printf '%s' '${running}' > "$LONCA_TEST_RUNTIME_FILES/state" ;;
  secret) [ ! -e "$LONCA_TEST_RUNTIME_FILES/secret-fails" ] || exit 1 ;;
esac
`, { mode: 0o700 });
  sandbox = await import('../../server/sandbox.ts');
  spec = { name: 'test', image: async () => 'image', env: ['LONCA_PORT=12345'], mounts: [], agentState: path.join(root, 'agent-state'), secrets: [{ service: 'github', file: path.join(root, 'github') }], setup: () => ({ command: ['true'] }), network: 'host' };
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

it('has the proxy’s secrets in place before anything runs in a sandbox', async () => {
  await sandbox.ensureSandbox(spec);
  expect(fs.readFileSync(path.join(root, 'calls'), 'utf8').split('\n').filter(Boolean).slice(-4)).toEqual(['ls', 'secret', 'exec', 'exec']);
});

it('propagates an unavailable sandbox service without running any commands in it', async () => {
  await sandbox.ensureSandbox(spec);
  fs.writeFileSync(path.join(root, 'calls'), '');
  fs.writeFileSync(path.join(root, 'unavailable'), '');
  await expect(sandbox.ensureSandbox(spec, { start: false })).rejects.toThrow(/sbx ls/);
  expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('ls\n');
});

it('gives a running sandbox a sign-in added since, and all of them again the next time it’s used if that failed', async () => {
  const added = { hosts: ['api.anthropic.com'], placeholder: 'sk-ant-oat01-lonca-profile-aaaaaaaaaaaa-placeholder', file: path.join(root, 'claude-aaaaaaaaaaaa') };
  const withIt = { ...spec, secrets: [...spec.secrets, added] };
  const registered = () => fs.readFileSync(path.join(root, 'args'), 'utf8').split('\n').filter((line) => line.startsWith('secret ') && line.includes(added.placeholder));
  await sandbox.ensureSandbox(spec);
  fs.writeFileSync(path.join(root, 'secret-fails'), '');
  await expect(sandbox.addSandboxSecret('test', added)).rejects.toThrow();
  fs.rmSync(path.join(root, 'secret-fails'));
  fs.writeFileSync(path.join(root, 'args'), '');
  await sandbox.ensureSandbox(withIt, { start: false });
  expect(registered()).toHaveLength(1);
  // Once it has it, nothing gives it again.
  fs.writeFileSync(path.join(root, 'args'), '');
  await sandbox.addSandboxSecret('test', added);
  await sandbox.ensureSandbox(withIt, { start: false });
  expect(registered()).toHaveLength(1);
});
