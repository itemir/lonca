import crypto from 'node:crypto';
import { PAIRING_ALPHABET, PAIRING_LENGTH, normalizePairingCode } from '../../shared/slack.ts';

/** A message event, or a message read back from a conversation, which says less about itself. */
export interface SlackMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: unknown[];
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
}

export type Route =
  | { to: 'nobody' }
  | { to: 'pairing' }
  /** A reply in a thread, which is a workspace's if Lonca started it. */
  | { to: 'thread'; thread: string; files: boolean }
  /** The DM's top level. */
  | { to: 'top'; files: boolean };

const NOBODY: Route = { to: 'nobody' };

// What the user writes, a reply also sent to the DM, and a message with a file. Edits, deletions
// and everything else Slack says about a conversation aren't anyone writing to a Lead.
const WRITTEN = new Set([undefined, 'thread_broadcast', 'file_share']);

/**
 * Who a message from Slack is for. Only what the paired user writes in their DM with the app counts.
 * Anything else, including the app's own posts and the user anywhere but that DM, is for nobody,
 * and Lonca says nothing back. While a code is on offer, one that looks like it at the top of
 * anyone's DM with the app is for pairing, since pairing is how Lonca learns who the user is. In a
 * thread it isn't, since there it's something the owner wrote to a Lead.
 */
export function routeMessage(message: SlackMessage, owner: { user: string; dm: string } | undefined, pairing: boolean): Route {
  if (message.type !== 'message' || message.channel_type !== 'im') return NOBODY;
  if (message.bot_id || message.app_id || !message.user || !message.ts || !WRITTEN.has(message.subtype)) return NOBODY;
  const thread = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined;
  if (pairing && !thread && looksLikeCode(message.text ?? '')) return { to: 'pairing' };
  if (!owner || message.user !== owner.user || message.channel !== owner.dm) return NOBODY;
  const files = message.subtype === 'file_share' || (message.files?.length ?? 0) > 0;
  return thread ? { to: 'thread', thread, files } : { to: 'top', files };
}

/** Which item the message is in a Lead's conversation, so that it's never added twice. */
export function slackItemId(channel: string, ts: string): string {
  return `slack-${channel}-${ts}`.replace(/[^\w-]/g, '-');
}

function looksLikeCode(text: string): boolean {
  const code = normalizePairingCode(text);
  return code.length === PAIRING_LENGTH && [...code].every((character) => PAIRING_ALPHABET.includes(character));
}

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_ATTEMPTS = 5;

/**
 * A one-time code for the user to DM to the app, which tells Lonca who they are. It's good for ten
 * minutes and one use, and five codes that are wrong end it, which leaves nothing to guess at 60 bits.
 */
export class PairingCode {
  readonly code: string;
  readonly expiresAt: number;
  private wrong = 0;
  private used = false;

  constructor(now = Date.now()) {
    this.code = Array.from({ length: PAIRING_LENGTH }, () => PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)]).join('');
    this.expiresAt = now + PAIRING_TTL_MS;
  }

  /** In groups of four, to read off a screen. */
  get display(): string {
    return this.code.match(/.{1,4}/g)!.join('-');
  }

  open(now = Date.now()): boolean {
    return !this.used && this.wrong < PAIRING_ATTEMPTS && now < this.expiresAt;
  }

  /** Why it can't be used any more, if it can't. */
  ended(now = Date.now()): 'used' | 'attempts' | 'expired' | undefined {
    if (this.used) return 'used';
    if (this.wrong >= PAIRING_ATTEMPTS) return 'attempts';
    return now >= this.expiresAt ? 'expired' : undefined;
  }

  /** A match leaves it open until pairing is saved, which uses it up. Anything else counts against it. */
  check(text: string, now = Date.now()): 'match' | 'wrong' | 'closed' {
    if (!this.open(now)) return 'closed';
    const given = Buffer.from(normalizePairingCode(text));
    const expected = Buffer.from(this.code);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return 'match';
    this.wrong++;
    return 'wrong';
  }

  use(): void {
    this.used = true;
  }
}
