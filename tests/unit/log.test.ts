import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const original = { error: console.error, warn: console.warn };
const logged = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  logged.mockReset();
  console.error = logged;
  console.warn = logged;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 12, 1, 49, 31));
  await import('../../server/log.ts');
});

afterEach(() => {
  Object.assign(console, original);
  vi.useRealTimers();
});

it('says when each error and warning happened, in this computer’s time', () => {
  const error = new Error('boom');
  console.error('could not save state:', 'disk full');
  console.warn('%s is slow', 'sbx');
  console.error(error);
  expect(logged.mock.calls).toEqual([
    ['2026-11-12 01:49:31 could not save state:', 'disk full'],
    ['2026-11-12 01:49:31 %s is slow', 'sbx'],
    ['2026-11-12 01:49:31', error],
  ]);
});
