import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let home: string;
let store: typeof import('../../server/store.ts');

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-token-'));
  vi.stubEnv('LONCA_HOME', home);
  store = await import('../../server/store.ts');
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the access token', () => {
  it('stays the same while Lonca keeps its port, and changes when it runs on another', () => {
    store.renewTokenOnNewPort(4700);
    const first = store.accessToken();
    store.renewTokenOnNewPort(4700);
    expect(store.accessToken()).toBe(first);
    store.renewTokenOnNewPort(4800);
    expect(store.accessToken()).not.toBe(first);
  });

  it('changes once for a token from before its port was recorded', () => {
    fs.rmSync(path.join(home, 'token-port'));
    const before = store.accessToken();
    store.renewTokenOnNewPort(4800);
    expect(store.accessToken()).not.toBe(before);
  });
});
