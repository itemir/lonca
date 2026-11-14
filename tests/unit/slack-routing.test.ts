import { describe, expect, it } from 'vitest';
import { PAIRING_ALPHABET, PAIRING_LENGTH } from '../../shared/slack.ts';
import { PAIRING_ATTEMPTS, PAIRING_TTL_MS, PairingCode, routeMessage, slackItemId, type SlackMessage } from '../../server/slack/routing.ts';

const owner = { user: 'U0OWNER', dm: 'D0OWNER' };
const THREAD = '1700000000.000100';
const message = (fields: Partial<SlackMessage> = {}): SlackMessage => ({
  type: 'message', channel: owner.dm, channel_type: 'im', user: owner.user, text: 'hello', ts: '1700000001.000200', ...fields,
});

describe('who a message from Slack is for', () => {
  it('passes on what the owner writes in their DM, at its top and in a thread', () => {
    expect(routeMessage(message(), owner, false)).toEqual({ to: 'top', files: false });
    expect(routeMessage(message({ thread_ts: THREAD }), owner, false)).toEqual({ to: 'thread', thread: THREAD, files: false });
    // The first message of a thread says so with its own ts.
    expect(routeMessage(message({ thread_ts: '1700000001.000200' }), owner, false)).toEqual({ to: 'top', files: false });
    expect(routeMessage(message({ thread_ts: THREAD, subtype: 'thread_broadcast' }), owner, false)).toEqual({ to: 'thread', thread: THREAD, files: false });
    expect(routeMessage(message({ thread_ts: THREAD, subtype: 'file_share', files: [{}] }), owner, false)).toEqual({ to: 'thread', thread: THREAD, files: true });
  });

  it('ignores anyone else, and the owner anywhere but their DM', () => {
    expect(routeMessage(message({ user: 'U0OTHER', channel: 'D0OTHER', thread_ts: THREAD }), owner, false)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ user: 'U0OTHER', thread_ts: THREAD }), owner, false)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ channel: 'D0OTHER', thread_ts: THREAD }), owner, false)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ user: undefined }), owner, false)).toEqual({ to: 'nobody' });
  });

  it('ignores public channels, private channels and group DMs, even from the owner in a known thread', () => {
    for (const [channel, type] of [['C0PUBLIC', 'channel'], ['G0PRIVATE', 'group'], ['G0MPIM', 'mpim'], [owner.dm, 'channel'], [owner.dm, undefined]]) {
      expect(routeMessage(message({ channel, channel_type: type, thread_ts: THREAD }), owner, false), `${channel} ${type}`).toEqual({ to: 'nobody' });
      // Nor does a code pair anyone there.
      expect(routeMessage(message({ channel, channel_type: type, text: 'ABCD-EFGH-JKMN' }), undefined, true)).toEqual({ to: 'nobody' });
    }
  });

  it('ignores bots, this app included, edits, deletions and everything else that isn’t someone writing', () => {
    expect(routeMessage(message({ bot_id: 'B0BOT' }), owner, false)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ app_id: 'A0APP' }), owner, false)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ user: 'U0BOT', bot_id: 'B0BOT', app_id: 'A0APP', thread_ts: THREAD }), owner, false)).toEqual({ to: 'nobody' });
    for (const subtype of ['message_changed', 'message_deleted', 'bot_message', 'me_message', 'channel_join', 'message_replied', 'ekm_access_denied']) {
      expect(routeMessage(message({ subtype, thread_ts: THREAD }), owner, false), subtype).toEqual({ to: 'nobody' });
    }
    expect(routeMessage({ ...message(), type: 'app_mention' }, owner, false)).toEqual({ to: 'nobody' });
  });

  it('answers nobody before pairing, but takes a code from anyone’s DM while one is on offer', () => {
    expect(routeMessage(message(), undefined, false)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ text: 'ABCD-EFGH-JKMN' }), undefined, false)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ text: 'hello' }), undefined, true)).toEqual({ to: 'nobody' });
    expect(routeMessage(message({ user: 'U0OTHER', channel: 'D0OTHER', text: ' abcd efgh jkmn ' }), owner, true)).toEqual({ to: 'pairing' });
    expect(routeMessage(message({ text: 'ABCD-EFGH-JKMN', bot_id: 'B0BOT' }), undefined, true)).toEqual({ to: 'nobody' });
  });

  it('takes a code only at the top of a DM, so that one in a workspace’s thread reaches its Lead', () => {
    expect(routeMessage(message({ text: '123456789012' }), owner, true)).toEqual({ to: 'pairing' });
    expect(routeMessage(message({ text: '123456789012', thread_ts: THREAD }), owner, true)).toEqual({ to: 'thread', thread: THREAD, files: false });
    expect(routeMessage(message({ user: 'U0OTHER', channel: 'D0OTHER', text: '123456789012', thread_ts: THREAD }), owner, true)).toEqual({ to: 'nobody' });
  });

  it('names a message’s item after its conversation and ts, the same every time', () => {
    expect(slackItemId('D0OWNER', '1700000001.000200')).toBe('slack-D0OWNER-1700000001-000200');
  });
});

describe('a pairing code', () => {
  it('has 60 bits, in groups of four that are easy to read', () => {
    const code = new PairingCode();
    expect(code.code).toHaveLength(PAIRING_LENGTH);
    expect(PAIRING_LENGTH * Math.log2(PAIRING_ALPHABET.length)).toBeGreaterThanOrEqual(50);
    expect([...code.code].every((character) => PAIRING_ALPHABET.includes(character))).toBe(true);
    expect(code.display).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(new Set(Array.from({ length: 50 }, () => new PairingCode().code)).size).toBe(50);
  });

  it('matches however it’s typed, and works once', () => {
    const code = new PairingCode();
    const typed = code.display.toLowerCase().replace(/0/g, 'o').replace(/-/g, ' ');
    expect(code.check(typed)).toBe('match');
    code.use();
    expect(code.check(code.display)).toBe('closed');
    expect(code.ended()).toBe('used');
  });

  it('stops working after five wrong codes', () => {
    const code = new PairingCode();
    for (let attempt = 1; attempt < PAIRING_ATTEMPTS; attempt++) expect(code.check('0000-0000-0000')).toBe('wrong');
    expect(code.open()).toBe(true);
    expect(code.check('0000-0000-0000')).toBe('wrong');
    expect(code.check(code.display)).toBe('closed');
    expect(code.ended()).toBe('attempts');
  });

  it('expires after ten minutes', () => {
    const now = 1_700_000_000_000;
    const code = new PairingCode(now);
    expect(code.check(code.display, now + PAIRING_TTL_MS - 1)).toBe('match');
    expect(code.check(code.display, now + PAIRING_TTL_MS)).toBe('closed');
    expect(code.ended(now + PAIRING_TTL_MS)).toBe('expired');
    expect(PAIRING_TTL_MS).toBe(10 * 60 * 1000);
  });
});
