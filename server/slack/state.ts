import type { SlackStatus } from '../../shared/types.ts';
import { publish } from '../events.ts';
import { accessToken, getSecrets, state } from '../store.ts';
import type { PairingCode } from './routing.ts';

/** What's kept of Slack in state.json. Never a token: those stay in secrets.json. */
export interface SlackState {
  /** Who the bot token belongs to. A pairing is only good for the app it was made with. */
  bot?: { team: string; teamName: string; user: string };
  /** The user Lonca answers to, and their DM with the app, which is the only place Lonca posts. */
  owner?: { user: string; team: string; dm: string };
  /** The DM's top level, kept track of as a workspace's thread is. */
  top?: Ledger;
  /** Posts Lonca has decided to make, in the order they're made. */
  outbox?: SlackPost[];
  /**
   * The newest message Lonca has seen in the DM, by Slack's clock. A post made after it comes after
   * it, so that's where looking for one starts, whatever this computer's clock says.
   */
  seen?: string;
  /**
   * What events said the owner wrote, saved before Slack was told they arrived, until each is passed
   * on: as its conversation shows it, or as the event had it if that still doesn't after a while.
   */
  pending?: PendingMessage[];
}

/** A message an event announced, with what passing it on needs. */
export interface PendingMessage {
  ts: string;
  /** The thread it's in. Without one, it's at the DM's top level. */
  thread?: string;
  text: string;
  subtype?: string;
  files?: boolean;
  /** When the event came. */
  at: number;
}

/** Which of a conversation's messages have been handled, so that none is handled twice. */
export interface Ledger {
  /** Everything up to this message has been. */
  handled?: string;
  /** Messages after it that have been, as they arrived. */
  done?: string[];
  /** When Lonca last posted, or passed something on, in the conversation, which makes it worth reading now and then. */
  active?: number;
}

/**
 * A post Lonca has decided to make. It's saved before Slack is asked, and it says what it is in
 * the message's metadata, so that after a crash it can be looked for rather than made again.
 */
export interface SlackPost {
  id: string;
  kind: 'root' | 'text' | 'reaction';
  /** The workspace whose thread it goes in. Without one, it's in the DM itself. */
  workspace?: string;
  /** Markdown, already made safe to post. */
  text?: string;
  /** For a reaction, the message it's on. For a text outside a workspace's thread, the message it answers. */
  ts?: string;
  /** When it was decided. */
  at: number;
  /** When Slack was last asked to make it without a definite answer, so it's looked for before being asked again. */
  askedAt?: number;
  /** The newest message Lonca had seen in the DM when it first asked Slack to make it, which it would come after. */
  after?: string;
  /** In place of what Slack wouldn't take. */
  fallback?: boolean;
}

export function slackState(): SlackState {
  return (state.slack ??= {});
}

/** Lonca's own secrets, which nothing it posts may contain: Lonca's link carries its access token, and the user could paste that to a Lead. */
export function hiddenSecrets(): string[] {
  const saved = getSecrets();
  return [accessToken(), saved.slackBotToken, saved.slackAppToken, saved.githubToken, saved.claudeToken, ...Object.values(saved.claudeTokens ?? {})]
    .filter((secret): secret is string => Boolean(secret));
}

export function slackTokens(): { bot: string; app: string } | undefined {
  const { slackBotToken: bot, slackAppToken: app } = getSecrets();
  return bot && app ? { bot, app } : undefined;
}

// Slack's ts is seconds and microseconds, as text. Compared as numbers, so that a ts from before
// 2001 or after 2286, should Slack ever send one, still sorts.
export function compareTs(a: string, b: string): number {
  const [aSeconds, aMicros = ''] = a.split('.');
  const [bSeconds, bMicros = ''] = b.split('.');
  return Number(aSeconds) - Number(bSeconds) || Number(aMicros.padEnd(6, '0')) - Number(bMicros.padEnd(6, '0'));
}

/** Notes a message Lonca has seen in the DM, by Slack's clock. */
export function noteSeen(ts: string | undefined): void {
  const saved = slackState();
  if (ts && (!saved.seen || compareTs(ts, saved.seen) > 0)) saved.seen = ts;
}

export function isHandled(ledger: Ledger | undefined, ts: string): boolean {
  if (!ledger) return false;
  return Boolean((ledger.handled && compareTs(ts, ledger.handled) <= 0) || ledger.done?.includes(ts));
}

/** Kept until a catch-up has read past it, since only then is it covered by `handled`. */
export function markHandled(ledger: Ledger, ts: string): void {
  if (!isHandled(ledger, ts)) ledger.done = [...(ledger.done ?? []), ts];
}

/** A catch-up saw every message up to `ts`, and handled them all. */
export function handledThrough(ledger: Ledger, ts: string): void {
  if (ledger.handled && compareTs(ts, ledger.handled) <= 0) return;
  ledger.handled = ts;
  const after = ledger.done?.filter((entry) => compareTs(entry, ts) > 0);
  if (after?.length) ledger.done = after;
  else delete ledger.done;
}

/** What's known about the connection and pairing, which isn't saved: a restart starts both again. */
export const live: {
  /**
   * Which connection everything under way belongs to: a disconnect, new tokens or a new owner starts
   * another, and work begun for an earlier one doesn't carry on.
   */
  generation: number;
  connection: SlackStatus['connection'];
  error?: string;
  /** Slack refused a token, so nothing is asked of it until the tokens are saved again. */
  refused?: string;
  pairing?: PairingCode;
  pairingEnded?: SlackStatus['pairingEnded'];
  postError?: string;
  postMayArrive?: boolean;
} = { generation: 0, connection: 'off' };

export function slackStatus(): SlackStatus {
  const saved = state.slack;
  const pairing = live.pairing?.open() ? { code: live.pairing.display, expiresAt: live.pairing.expiresAt } : undefined;
  return {
    connection: live.connection,
    ...(live.error ? { error: live.error } : {}),
    ...(live.refused ? { stopped: true } : {}),
    ...(saved?.bot?.teamName ? { team: saved.bot.teamName } : {}),
    ...(saved?.owner ? { owner: { user: saved.owner.user } } : {}),
    ...(pairing ? { pairing } : {}),
    ...(live.pairingEnded ? { pairingEnded: live.pairingEnded } : {}),
    ...(live.postError ? { postError: live.postError } : {}),
    ...(live.postMayArrive ? { postMayArrive: true } : {}),
  };
}

/** Why the post at the front of the queue hasn't been made, or nothing once one is. Says whether that changed. */
export function setPostError(code: string | undefined): boolean {
  if (live.postError === code) return false;
  live.postError = code;
  publishStatus();
  return true;
}

export function publishStatus(): void {
  publish({ type: 'slack', slack: slackStatus() });
}

export function setConnection(connection: SlackStatus['connection'], error?: string): void {
  if (live.connection === connection && live.error === error) return;
  live.connection = connection;
  live.error = error;
  publishStatus();
}

let ending = new AbortController();

/**
 * Slack was disconnected, given new tokens, or paired with someone, so what was under way is for an
 * earlier connection. A read or a wait for it ends now, rather than asking Slack anything more with
 * tokens that are gone, or holding up what's needed for the new one.
 */
export function newGeneration(): void {
  live.generation++;
  ending.abort();
  ending = new AbortController();
}

/** Aborted once the generation it was taken in is over. */
export function generationSignal(): AbortSignal {
  return ending.signal;
}

let onRefused = () => {};

export function whenRefused(listener: () => void): void {
  onRefused = listener;
}

/** Slack won't take a token again, so Lonca stops asking it anything until the tokens change. */
export function refused(code: string): void {
  live.refused = code;
  setConnection('error', code);
  onRefused();
}
