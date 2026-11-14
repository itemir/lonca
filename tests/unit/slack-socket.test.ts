import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SlackSocket, type Envelope } from '../../server/slack/socket.ts';
import { SlackError, slackCall } from '../../server/slack/web.ts';
import { OTHER_BOT, OTHER_TOKENS, OWNER, TOKENS, type FakeSlack, startFakeSlack } from '../support/fake-slack.ts';

let slack: FakeSlack;
let socket: SlackSocket | undefined;

interface Seen {
  changes: string[];
  hellos: number;
  envelopes: Envelope[];
  refused: string[];
}

/** A socket that answers each envelope as `acknowledge` says, and notes what happened. */
function connect(acknowledge: (envelope: Envelope) => boolean | Promise<boolean> = () => true, timing = {}): Seen {
  const seen: Seen = { changes: [], hellos: 0, envelopes: [], refused: [] };
  socket = new SlackSocket({
    url: async () => (await slackCall<{ url: string }>('apps.connections.open', TOKENS.app)).url,
    envelope: async (envelope) => {
      seen.envelopes.push(envelope);
      return acknowledge(envelope);
    },
    hello: () => seen.hellos++,
    // As Lonca's status does, a state is only noted when it changes.
    change: (connection, error) => {
      const state = error ? `${connection}:${error}` : connection;
      if (seen.changes.at(-1) !== state) seen.changes.push(state);
    },
    refused: (code) => seen.refused.push(code),
  }, { pingEveryMs: 50, silentMs: 400, retryMs: 50, maxRetryMs: 400, ...timing });
  socket.start();
  return seen;
}

beforeEach(async () => {
  slack = await startFakeSlack();
  vi.stubEnv('LONCA_SLACK_API_URL', slack.url);
});

afterEach(async () => {
  socket?.stop();
  socket = undefined;
  await slack.close();
  vi.unstubAllEnvs();
});

it('is connected once Slack says hello, and acknowledges an envelope only once it’s been dealt with', async () => {
  let release!: () => void;
  const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
  const seen = connect((envelope) => (envelope.retry_attempt === 0 && (envelope.payload as { event: { text: string } }).event.text === 'slow' ? held : true));
  await vi.waitFor(() => expect(seen.hellos).toBe(1));
  expect(seen.changes).toEqual(['connecting', 'connected']);
  const first = slack.say(OWNER, 'slow').envelope!;
  const second = slack.say(OWNER, 'quick').envelope!;
  await vi.waitFor(() => expect(slack.acked.has(second)).toBe(true));
  expect(slack.acked.has(first)).toBe(false);
  release();
  await vi.waitFor(() => expect(slack.acked.has(first)).toBe(true));
});

it('leaves an envelope it couldn’t deal with for Slack to send again', async () => {
  let accept = false;
  const seen = connect(() => accept);
  await vi.waitFor(() => expect(seen.hellos).toBe(1));
  const id = slack.say(OWNER, 'hello').envelope!;
  await vi.waitFor(() => expect(seen.envelopes).toHaveLength(1));
  expect(slack.acked.has(id)).toBe(false);
  accept = true;
  slack.redeliver(id);
  await vi.waitFor(() => expect(slack.acked.has(id)).toBe(true));
  expect(seen.envelopes.map((envelope) => envelope.retry_attempt)).toEqual([0, 1]);
});

it.each(['refresh_requested', 'warning'] as const)('moves to a new connection when Slack sends %s, without a gap', async (reason) => {
  const seen = connect();
  await vi.waitFor(() => expect(seen.hellos).toBe(1));
  slack.disconnect(reason);
  await vi.waitFor(() => expect(seen.hellos).toBe(2));
  expect(slack.connections).toBe(2);
  // The old one is closed once the new one is up, and it never stopped being connected.
  await vi.waitFor(() => expect(slack.sockets).toHaveLength(1));
  expect(seen.changes).toEqual(['connecting', 'connected']);
  const id = slack.say(OWNER, 'after').envelope!;
  await vi.waitFor(() => expect(slack.acked.has(id)).toBe(true));
});

it('stops when Socket Mode is turned off in the app’s settings', async () => {
  const seen = connect();
  await vi.waitFor(() => expect(seen.hellos).toBe(1));
  slack.disconnect('link_disabled');
  await vi.waitFor(() => expect(seen.refused).toEqual(['link_disabled']));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(slack.connections).toBe(1);
});

it('connects again when the connection drops, at once and then waiting longer after each failure', async () => {
  const seen = connect(() => true, { retryMs: 200, maxRetryMs: 2000 });
  await vi.waitFor(() => expect(seen.hellos).toBe(1));
  slack.fail('apps.connections.open', { status: 500, error: 'internal_error' }, { status: 500, error: 'internal_error' }, { status: 500, error: 'internal_error' });
  const dropped = Date.now();
  slack.drop();
  await vi.waitFor(() => expect(seen.hellos).toBe(2), { timeout: 5000 });
  const attempts = slack.calls.filter((call) => call.method === 'apps.connections.open').slice(1).map((call) => call.at);
  expect(attempts).toHaveLength(4);
  expect(attempts[0] - dropped).toBeLessThan(140);
  const waits = attempts.slice(1).map((at, index) => at - attempts[index]);
  expect(waits[1]).toBeGreaterThan(waits[0]);
  expect(waits[2]).toBeGreaterThan(waits[1]);
  expect(seen.changes).toEqual(['connecting', 'connected', 'connecting', 'error:internal_error', 'connected']);
  expect(seen.refused).toEqual([]);
});

it('takes a connection that’s gone quiet for dead, and connects again', async () => {
  const seen = connect();
  await vi.waitFor(() => expect(seen.hellos).toBe(1));
  slack.silent = true;
  await vi.waitFor(() => expect(slack.connections).toBe(2), { timeout: 5000 });
  slack.silent = false;
  await vi.waitFor(() => expect(seen.hellos).toBeGreaterThanOrEqual(2), { timeout: 5000 });
});

it.each([['invalid_auth', 'xapp-1-not-a-token-slack-knows'], ['token_revoked', TOKENS.app]])('stops at once, and says so, when Slack says %s', async (code, token) => {
  slack.tokens.delete(TOKENS.app);
  const seen: string[] = [];
  socket = new SlackSocket({
    url: async () => (await slackCall<{ url: string }>('apps.connections.open', token)).url,
    envelope: async () => true,
    hello: () => {},
    change: () => {},
    refused: (refusal) => seen.push(refusal),
  }, { retryMs: 50 });
  socket.start();
  await vi.waitFor(() => expect(seen).toEqual([code]));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(slack.calls.filter((call) => call.method === 'apps.connections.open')).toHaveLength(1);
  expect(new SlackError(code).refused).toBe(true);
});

it('waits as long as Slack asks after a 429', async () => {
  slack.fail('apps.connections.open', { status: 429, error: 'ratelimited', retryAfter: 1 });
  const started = Date.now();
  const seen = connect();
  await vi.waitFor(() => expect(seen.hellos).toBe(1), { timeout: 5000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
});

it('keeps every caller of a method away from Slack for as long as a 429 asked', async () => {
  slack.fail('conversations.history', { status: 429, error: 'ratelimited', retryAfter: 1 });
  await expect(slackCall('conversations.history', TOKENS.bot, { channel: slack.dm() })).rejects.toMatchObject({ code: 'ratelimited', retryAfterMs: 1000 });
  const asked = slack.calls.length;
  const again = await slackCall('conversations.history', TOKENS.bot, { channel: slack.dm() }).then(() => undefined, (error: SlackError) => error);
  expect(again).toMatchObject({ code: 'ratelimited' });
  expect(again!.retryAfterMs).toBeGreaterThan(0);
  expect(again!.retryAfterMs).toBeLessThanOrEqual(1000);
  expect(slack.calls).toHaveLength(asked);
  // Slack counts each method apart.
  await expect(slackCall('auth.test', TOKENS.bot)).resolves.toMatchObject({ ok: true });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await expect(slackCall('conversations.history', TOKENS.bot, { channel: slack.dm() })).resolves.toMatchObject({ ok: true });
});

it('keeps the longest of overlapping 429s, and only for the app and Slack workspace it was about', async () => {
  // Answered in turn: the first asks for three seconds, then the second, a moment later, for one.
  slack.fail('conversations.replies', { status: 429, error: 'ratelimited', retryAfter: 3 }, { status: 429, error: 'ratelimited', retryAfter: 1 });
  slack.delay('conversations.replies', 0);
  slack.delay('conversations.replies', 200);
  const read = (token: string, channel: string) => slackCall('conversations.replies', token, { channel, ts: '1700000000.000100' });
  await Promise.allSettled([read(TOKENS.bot, slack.dm()), read(TOKENS.bot, slack.dm())]);
  const again = await read(TOKENS.bot, slack.dm()).then(() => undefined, (error: SlackError) => error);
  expect(again).toMatchObject({ code: 'ratelimited' });
  expect(again!.retryAfterMs).toBeGreaterThan(2000);
  // Another app's token reaches Slack, which answers it.
  await expect(read(OTHER_TOKENS.bot, slack.dm(OWNER, OTHER_BOT))).rejects.toMatchObject({ code: 'thread_not_found' });
});
