import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

// What a workspace's terminals source at the end of ~/.bashrc. The whole prompt is only drawn by an
// interactive shell, which tests/docker/lonca.test.ts opens in a VM.
const snippet = fileURLToPath(new URL('../../server/terminal-prompt.sh', import.meta.url));
const PROMPT = 'lonca@${LONCA_PROJECT_SLUG}-$(__lonca_branch):\\W\\$ ';
// A developer's own git settings, such as signing every commit, mustn't reach these repositories.
const GIT_ISOLATED = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

let root: string;
let checkout: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-prompt-test-'));
  checkout = path.join(root, 'oslo');
  git('init', '-q', '-b', 'someone/oslo', checkout);
  git('-C', checkout, 'commit', '-q', '--allow-empty', '-m', 'first');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    stdio: 'ignore',
    env: { ...process.env, ...GIT_ISOLATED },
  });
}

/** Sources the snippet in a shell like a terminal's, with a prompt already set as ~/.bashrc does. */
function shell(script: string, options: { cwd?: string; lonca?: boolean } = {}): string {
  const lonca = options.lonca === false ? {} : { LONCA_PROJECT_SLUG: 'saillogger', LONCA_WORKSPACE_PATH: checkout, LONCA_WORKSPACE_NAME: 'oslo' };
  return execFileSync('bash', ['--norc', '--noprofile', '-c', `PS1='before$ '; . "$0"; ${script}`, snippet], {
    cwd: options.cwd ?? checkout,
    env: { PATH: process.env.PATH, HOME: root, ...GIT_ISOLATED, ...lonca },
    encoding: 'utf8',
  });
}

it('goes by the project and the last part of the branch checked out', () => {
  expect(shell('printf %s "$PS1"')).toBe(PROMPT);
  expect(shell('__lonca_branch')).toBe('oslo');
  git('-C', checkout, 'switch', '-q', '-c', 'feature/sign-ins');
  expect(shell('__lonca_branch')).toBe('sign-ins');
});

it('stays with the workspace’s checkout wherever the shell goes', () => {
  expect(shell('cd / && __lonca_branch')).toBe('oslo');
  expect(shell('__lonca_branch', { cwd: os.tmpdir() })).toBe('oslo');
});

it('goes by the workspace’s name with no branch checked out', () => {
  git('-C', checkout, 'switch', '-q', '-c', 'feature/sign-ins');
  git('-C', checkout, 'switch', '-q', '--detach');
  expect(shell('__lonca_branch')).toBe('oslo');
  fs.rmSync(checkout, { recursive: true });
  expect(shell('__lonca_branch', { cwd: root })).toBe('oslo');
});

it('leaves the prompt alone in a shell Lonca didn’t start', () => {
  expect(shell('printf %s "$PS1"', { lonca: false })).toBe('before$ ');
  expect(shell('type __lonca_branch >/dev/null 2>&1 || echo none', { lonca: false })).toBe('none\n');
});
