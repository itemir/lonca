import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserItem } from '../../shared/types.ts';

let store: typeof import('../../server/store.ts');
let home: string;
const item = (id: string): UserItem => ({ id, ts: 1, type: 'user', text: id, queued: true });
const file = (id: string) => path.join(home, 'sessions', `${id}.jsonl`);

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-transcript-unit-')));
  vi.stubEnv('LONCA_HOME', home);
  vi.resetModules();
  store = await import('../../server/store.ts');
});

afterEach(() => {
  vi.restoreAllMocks();
  store.flushTranscripts();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it('treats only a missing file as an empty conversation', () => {
  expect(store.loadTranscript('missing')).toEqual([]);
  fs.mkdirSync(file('unreadable'));
  expect(() => store.loadTranscript('unreadable')).toThrow(/EISDIR/);
});

it('saves a batch before its durability boundary returns and preserves move ordering', () => {
  store.appendTranscript('s', [item('queued'), item('answer')]);
  store.appendTranscriptMove('s', { ...item('queued'), queued: false });
  expect(fs.existsSync(file('s'))).toBe(false);
  store.flushTranscript('s');
  expect(store.loadTranscript('s')).toEqual([item('answer'), { ...item('queued'), queued: false }]);
});

it('retries a partly written batch without losing its remaining records or later updates', () => {
  store.appendTranscript('s', [item('old'), item('queued')]);
  store.flushTranscript('s');
  const append = fs.appendFileSync;
  vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((target, data, options) => {
    const text = String(data);
    append(target, text.slice(0, text.indexOf('\n', 1) + 12), options);
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store.appendTranscriptRemoval('s', 'old');
  store.appendTranscript('s', [item('answer')]);
  expect(() => store.flushTranscript('s')).toThrow('disk full');
  store.appendTranscriptMove('s', { ...item('queued'), queued: false });
  store.flushTranscript('s');
  expect(store.loadTranscript('s')).toEqual([item('answer'), { ...item('queued'), queued: false }]);
});

it('keeps the next record readable after a crash left an incomplete line', () => {
  store.appendTranscript('s', [item('queued')]);
  store.flushTranscript('s');
  fs.appendFileSync(file('s'), '{"moved":{"id":"queued",');
  // A truncated move has not removed the accepted message.
  expect(store.loadTranscript('s')).toEqual([item('queued')]);
  store.appendTranscript('s', [item('next')]);
  store.flushTranscript('s');
  expect(store.loadTranscript('s')).toEqual([item('queued'), item('next')]);
});

it('flushes other conversations when one file fails, then retains that file for retry', () => {
  const append = fs.appendFileSync;
  const failing = vi.spyOn(fs, 'appendFileSync').mockImplementation((target, data, options) => {
    if (target === file('broken')) throw new Error('unwritable transcript');
    append(target, data, options);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store.appendTranscript('broken', [item('a')]);
  store.appendTranscript('healthy', [item('b')]);
  expect(() => store.flushTranscripts()).toThrow('Some conversations could not be saved');
  expect(store.loadTranscript('healthy')).toEqual([item('b')]);
  failing.mockRestore();
  store.flushTranscripts();
  expect(store.loadTranscript('broken')).toEqual([item('a')]);
});

it('automatically retries failed background writes after storage recovers', async () => {
  vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => { throw new Error('temporary I/O failure'); });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  store.appendTranscript('s', [item('saved-after-retry')]);
  await vi.waitFor(() => expect(logged).toHaveBeenCalled());
  await vi.waitFor(() => expect(store.loadTranscript('s')).toEqual([item('saved-after-retry')]), { timeout: 3000 });
});

it('does not recreate a deleted transcript from a scheduled write or retry', async () => {
  vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => { throw new Error('temporary I/O failure'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store.appendTranscript('s', [item('discarded')]);
  expect(() => store.flushTranscript('s')).toThrow('temporary I/O failure');
  await store.deleteTranscript('s');
  store.flushTranscripts();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fs.existsSync(file('s'))).toBe(false);
});
