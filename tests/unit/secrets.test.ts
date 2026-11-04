import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let home: string;
const secrets = () => path.join(home, 'secrets.json');
const load = () => {
  vi.resetModules();
  return import('../../server/store.ts');
};

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-secrets-unit-')));
  vi.stubEnv('LONCA_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it('starts with no secrets when none have been saved', async () => {
  expect((await load()).getSecrets()).toEqual({});
});

it('refuses to start from secrets it can’t parse, without quoting them or replacing them', async () => {
  const saved = `{"claudeToken":"sk-ant-api03-${'a'.repeat(30)}`;
  fs.writeFileSync(secrets(), saved);
  const error = await load().then(() => null, (failure: unknown) => String(failure));
  expect(error).toMatch(/Could not read .*secrets\.json/);
  expect(error).not.toContain('sk-ant');
  expect(fs.readFileSync(secrets(), 'utf8')).toBe(saved);
});

it('refuses to start from secrets it can’t read', async () => {
  fs.mkdirSync(secrets());
  await expect(load()).rejects.toThrow(/Could not read .*EISDIR/);
});
