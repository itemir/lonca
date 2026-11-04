import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../server/ssh-agent.ts', () => ({ emptyAgent: async () => '' }));

let root: string;
let tty: Awaited<ReturnType<typeof import('../../server/sandbox.ts').sandboxTty>>;
beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-tty-test-'));
  vi.stubEnv('LONCA_HOME', root);
  vi.stubEnv('LONCA_SBX', path.join(root, 'sbx'));
  vi.stubEnv('LONCA_TEST_TTY', root);
  fs.writeFileSync(path.join(root, 'state'), '[{"name":"test","status":"running"}]');
  // A delayed terminal close exposes resizes queued during a VM stop. Commands
  // are recorded so tests can distinguish a state query from an exec that wakes it.
  fs.writeFileSync(path.join(root, 'sbx'), `#!/bin/sh
case "$1" in
  ls)
    [ ! -e "$LONCA_TEST_TTY/unavailable" ] || exit 1
    cat "$LONCA_TEST_TTY/state"
    ;;
  exec)
    if printf '%s\\n' "$@" | grep -qx lonca-pty; then
      touch "$LONCA_TEST_TTY/started"
      while [ ! -e "$LONCA_TEST_TTY/finish" ]; do sleep 0.01; done
    else
      echo resize >> "$LONCA_TEST_TTY/resizes"
    fi
    ;;
esac
`, { mode: 0o700 });
  const { sandboxTty } = await import('../../server/sandbox.ts');
  tty = await sandboxTty('test', ['bash'], {});
  tty.stream.resume();
  await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'started'))).toBe(true));
});
afterEach(async () => {
  fs.writeFileSync(path.join(root, 'finish'), '');
  await tty.exitCode();
  tty.stream.destroy();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each(['stopped', 'missing', 'unavailable'] as const)('does not execute a pending resize while its sandbox is %s, then permits resizing after recovery', async (state) => {
  if (state === 'unavailable') fs.writeFileSync(path.join(root, 'unavailable'), '');
  else fs.writeFileSync(path.join(root, 'state'), state === 'missing' ? '[]' : '[{"name":"test","status":"stopped"}]');
  await tty.resize(100, 30);
  expect(fs.existsSync(path.join(root, 'resizes'))).toBe(false);
  fs.rmSync(path.join(root, 'unavailable'), { force: true });
  fs.writeFileSync(path.join(root, 'state'), '[{"name":"test","status":"running"}]');
  await tty.resize(120, 40);
  expect(fs.readFileSync(path.join(root, 'resizes'), 'utf8')).toBe('resize\n');
});

it('ignores stale resizes after the terminal process exits', async () => {
  fs.writeFileSync(path.join(root, 'finish'), '');
  await tty.exitCode();
  await tty.resize(100, 30);
  expect(fs.existsSync(path.join(root, 'resizes'))).toBe(false);
});
