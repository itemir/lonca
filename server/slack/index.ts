// Slack, step one: each workspace's Lead posts its reply to a thread in the user's DM with their
// own Slack app when it needs them, and what the user writes in that thread reaches the Lead as if
// they'd typed it in Lonca. The DM is the only place Lonca reads or posts. Its tokens stay in
// secrets.json, and no workspace, agent or Lead has them, or Lonca's connection to Slack.
import type { Session, SlackStatus, TextItem, Workspace } from '../../shared/types.ts';
import { leadOf, sendMessage } from '../agents/runner.ts';
import { subscribe } from '../events.ts';
import { flushState, getWorkspace, saveState, state, updateSecrets } from '../store.ts';
import { transcriptFor } from '../transcript.ts';
import { HttpError, errorMessage, newId, sleep } from '../util.ts';
import { drain, dropPosts, enqueue, holdOutbox, rootPost, safeText, wakeOutbox, whenRootMade, writesSettled } from './outbox.ts';
import { PairingCode, routeMessage, slackItemId, type Route, type SlackMessage } from './routing.ts';
import { SlackSocket, type Envelope, type SocketTiming } from './socket.ts';
import {
  compareTs, generationSignal, handledThrough, isHandled, live, markHandled, newGeneration, noteSeen, publishStatus, refused, setConnection,
  slackState, slackStatus, slackTokens, whenRefused, type Ledger, type PendingMessage, type SlackPost,
} from './state.ts';
import { plainText, replyParts } from './text.ts';
import { SlackError, readMessages, slackCall } from './web.ts';

export { slackStatus } from './state.ts';

/** Told to a Lead ahead of each message from Slack. What the user wrote is left as it was. */
export const FROM_SLACK = 'The user sent this from Slack and will read your reply there, possibly on a phone.';

const PAIRED = 'Paired with Lonca. When a Lead needs you, its reply arrives here, in a thread for its workspace. Reply in that thread to answer it.';
const ELSEWHERE = 'To reach a Lead, reply in its workspace’s thread. Lonca starts one here the first time a Lead needs you.';
const NO_LEAD = 'This workspace has no Lead, so nobody got this. Start a new Lead in Lonca, then write here again.';
const NO_FILES = 'Files aren’t passed on from Slack yet, so the Lead didn’t get yours. Attach it in Lonca instead.';

export type NeedsYou = 'finished' | 'paused' | 'limit' | 'failed';

// Lonca's line under the reply, which says why it was posted when it wasn't just that the Lead finished.
const MOMENTS: Record<NeedsYou, string | undefined> = {
  finished: undefined,
  paused: '_The Lead paused after 30 turns without a word from you. Reply here to let it continue._',
  limit: '_The Lead reached a usage limit._',
  failed: '_The Lead stopped with an error._',
};
const SAID_NOTHING = '_The Lead finished without writing a reply._';

export const SLACK_TIMING = {
  /** How long before a conversation that couldn't be read, or whose next message couldn't be saved, is read again. */
  retryMs: 30000,
  /**
   * How long a message an event announced waits for its conversation to show it, holding up what
   * comes after it, before it's passed on as the event had it. Slack can be a moment behind its events.
   */
  graceMs: 90000,
  /** How soon a conversation is read again meanwhile, doubling each time, up to the most. */
  pendingRetryMs: 1000,
  pendingMaxRetryMs: 15000,
  /**
   * How long Disconnect, or pairing someone else, waits for Slack to answer for posts it's been
   * asked to make, which can't be called back, before it's done all the same.
   */
  writesWaitMs: 10000,
  /**
   * Slack doesn't promise to send every event, so conversations with something recent in them are
   * read this often, at most so many at a time, the most recent first, well within Slack's limits.
   */
  pollMs: 3 * 60 * 1000,
  pollMost: 10,
  /** How long after Lonca last posted, or passed something on, in a conversation that counts as recent. */
  activeMs: 60 * 60 * 1000,
  socket: {} as Partial<SocketTiming>,
};

let socket: SlackSocket | null = null;
/** Between startSlack and stopSlack, outside which nothing is read or retried. */
let running = false;
let polling: NodeJS.Timeout | undefined;

whenRefused(() => {
  socket?.stop();
  socket = null;
});

// The user can see a root, and reply to it, before Slack's answer says where it is. What they
// wrote meanwhile is read now.
whenRootMade((workspace) => {
  dropStrays();
  void readConversation(workspace.id);
});

subscribe((event) => {
  if (event.type !== 'workspace.removed') return;
  dropPosts(event.id);
  clearTimeout(readers.get(event.id)?.retry);
  readers.delete(event.id);
  dropStrays();
});

// Connecting

/** Connects if there are tokens: at startup, and whenever they're saved. */
export function startSlack(): void {
  socket?.stop();
  socket = null;
  running = true;
  live.refused = undefined;
  holdOutbox('stopped', false);
  if (!slackTokens()) {
    setConnection('off');
    return;
  }
  socket = new SlackSocket({
    url: connectionUrl,
    envelope: receiveEnvelope,
    hello: () => {
      void catchUp();
      drain();
    },
    change: (connection, error) => setConnection(connection, error),
    refused,
  }, SLACK_TIMING.socket);
  socket.start();
  clearInterval(polling);
  polling = setInterval(poll, SLACK_TIMING.pollMs);
  polling.unref();
  wakeOutbox();
  drain();
}

/** Stops reading, retrying and posting until startSlack. Nothing's lost: what's waiting stays saved, and what's missed is caught up with. */
export function stopSlack(): void {
  running = false;
  socket?.stop();
  socket = null;
  clearInterval(polling);
  for (const reader of readers.values()) {
    clearTimeout(reader.retry);
    reader.retry = undefined;
  }
  clearTimeout(pairingTimer);
  holdOutbox('stopped', true);
}

async function connectionUrl(): Promise<string> {
  const tokens = slackTokens();
  if (!tokens) throw new SlackError('not_authed');
  await identify(tokens.bot, live.generation);
  // Replaced or forgotten meanwhile, so it's not to be used again.
  if (slackTokens()?.app !== tokens.app) throw new SlackError('cancelled');
  const { url } = await slackCall<{ url?: unknown }>('apps.connections.open', tokens.app);
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new SlackError('unknown_error');
  return url;
}

/**
 * Who the bot token belongs to. Pairing was with one app in one Slack workspace, and isn't good for
 * another. An answer about tokens that were replaced while it came says nothing about the new ones.
 */
async function identify(bot: string, generation: number): Promise<void> {
  const answer = await slackCall<{ team_id?: string; team?: string; user_id?: string }>('auth.test', bot);
  if (live.generation === generation) remember({ team: answer.team_id ?? '', teamName: answer.team ?? '', user: answer.user_id ?? '' });
}

function remember(bot: { team: string; teamName: string; user: string }): void {
  const saved = slackState();
  if (saved.bot && (saved.bot.team !== bot.team || saved.bot.user !== bot.user)) forgetPairing();
  if (JSON.stringify(saved.bot) === JSON.stringify(bot)) return;
  saved.bot = bot;
  saveState();
  publishStatus();
}

/** A new owner, app or Slack workspace: their DM, threads and posts were for someone else. */
function forgetPairing(): void {
  newGeneration();
  const saved = slackState();
  delete saved.owner;
  delete saved.top;
  delete saved.outbox;
  delete saved.pending;
  delete saved.seen;
  live.postError = undefined;
  for (const workspace of state.workspaces) delete workspace.slack;
  for (const reader of readers.values()) {
    clearTimeout(reader.retry);
    Object.assign(reader, { retry: undefined, waits: 0 });
  }
}

// Settings

function refusal(what: string, error: unknown): Error {
  if (!(error instanceof SlackError)) return error as Error;
  if (error.passing) return new HttpError(502, `Lonca couldn’t reach Slack to check the ${what} (${error.code}). Try again.`);
  return new HttpError(400, `Slack didn’t accept the ${what} (${error.code}).`);
}

/** Counts saves of the tokens and disconnects, so that one which comes after a save still being checked wins. */
let settingsChanges = 0;

/** Saves the app's tokens once Slack has taken both, and connects with them. */
export async function saveSlackTokens(bot: string, app: string): Promise<SlackStatus> {
  if (!/^xoxb-[\w-]+$/.test(bot)) throw new HttpError(400, 'That isn’t a bot token. It starts with xoxb-, on the app’s OAuth & Permissions page.');
  if (!/^xapp-[\w-]+$/.test(app)) throw new HttpError(400, 'That isn’t an app-level token. It starts with xapp-, on the app’s Basic Information page.');
  const change = ++settingsChanges;
  const overtaken = () => new HttpError(409, 'Slack was disconnected, or other tokens were saved, while these were being checked, so they weren’t saved.');
  const identity = await slackCall<{ team_id?: string; team?: string; user_id?: string }>('auth.test', bot).catch((error: unknown) => {
    throw refusal('bot token', error);
  });
  if (change !== settingsChanges) throw overtaken();
  await slackCall('apps.connections.open', app).catch((error: unknown) => {
    throw refusal('app-level token', error);
  });
  if (change !== settingsChanges) throw overtaken();
  updateSecrets({ slackBotToken: bot, slackAppToken: app });
  newGeneration();
  live.postMayArrive = undefined;
  remember({ team: identity.team_id ?? '', teamName: identity.team ?? '', user: identity.user_id ?? '' });
  flushState();
  startSlack();
  if (!slackState().owner && !live.pairing?.open()) offerCode();
  publishStatus();
  return slackStatus();
}

/** A one-time code for the user to DM to the app. Pairing again replaces the owner, once the code arrives. */
export function offerPairing(): SlackStatus {
  if (!slackTokens()) throw new HttpError(409, 'Save the Slack app’s tokens first.');
  offerCode();
  return slackStatus();
}

let pairingTimer: NodeJS.Timeout | undefined;

function offerCode(): void {
  // This one replaces a code that may still be being paired with, which can't finish now.
  pairingUnderWay?.controller.abort();
  pairingUnderWay = undefined;
  const code = new PairingCode();
  live.pairing = code;
  live.pairingEnded = undefined;
  clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => {
    if (live.pairing !== code || code.ended() !== 'expired') return;
    live.pairing = undefined;
    live.pairingEnded = 'expired';
    publishStatus();
  }, code.expiresAt - Date.now() + 50);
  pairingTimer.unref();
  publishStatus();
}

/**
 * Forgets the tokens, the owner, the DM, every thread and anything waiting to be posted. A post
 * Slack's been asked to make can't be called back, so it's done once those have been answered, or
 * after a while, when Settings says one may still arrive.
 */
export async function disconnectSlack(): Promise<void> {
  const change = ++settingsChanges;
  // The tokens first, so that whatever happens next, nothing more reaches Slack.
  updateSecrets({ slackBotToken: '', slackAppToken: '' });
  newGeneration();
  stopSlack();
  clearTimeout(pairingTimer);
  live.pairing = undefined;
  live.pairingEnded = undefined;
  live.refused = undefined;
  forgetPairing();
  delete state.slack;
  flushState();
  wakeOutbox();
  setConnection('off');
  const settled = await writesSettled(SLACK_TIMING.writesWaitMs);
  if (settled || change !== settingsChanges) return;
  live.postMayArrive = true;
  publishStatus();
}

// What the user writes
//
// Events and the conversation together decide what's passed on. An event from the owner is saved
// as pending for its conversation, a workspace's thread or the DM's top level, before Slack is told
// it arrived, and asks for that conversation to be read. A read takes what Slack shows from as far
// as it has handled, adds what's pending, and handles both in the order they were written, moving
// that mark past each message as it goes. One that's pending but not shown yet holds up what comes
// after it, until it's waited long enough to be passed on as the event had it. A message Slack
// shows that no event announced is handled like any other. A conversation is read once at a time,
// and an event that comes during a read asks for another after it. Catching up, after reconnecting
// say, is reading every conversation. So events that arrive out of order, or a conversation that
// shows a message late, can't change the order a Lead gets messages in. Pairing is done from the event.

type Outcome = 'handled' | 'later';
type Owner = { user: string; team: string; dm: string };

/** The DM's top level, among the conversations that are read. The others are workspaces' threads, each by its workspace's id. */
const TOP = ':top';

interface Reader {
  /** The read under way, with any asked for meanwhile, which follow it. */
  reading?: Promise<void>;
  again: boolean;
  /** Reads in a row held up by a pending message that wasn't shown. */
  waits: number;
  retry?: NodeJS.Timeout;
}

const readers = new Map<string, Reader>();

async function receiveEnvelope(envelope: Envelope): Promise<boolean> {
  // Nothing else was subscribed to. It's acknowledged, so that Slack doesn't send it again.
  if (envelope.type !== 'events_api') return true;
  const payload = envelope.payload as { type?: string; team_id?: string; event?: SlackMessage } | undefined;
  if (payload?.type !== 'event_callback' || !payload.event) return true;
  const message = payload.event;
  const route = routeMessage(message, slackState().owner, Boolean(live.pairing?.open()));
  if (route.to === 'nobody') return true;
  if (route.to === 'pairing') return pair(message, payload.team_id) === 'handled';
  const workspace = route.to === 'thread' ? state.workspaces.find((entry) => entry.slack?.thread === route.thread) : undefined;
  // It may be a reply to a root Slack hasn't confirmed yet, whose thread is read once it has.
  const early = route.to === 'thread' && !workspace && rootAwaited();
  if (route.to === 'top' || workspace || early) {
    // Saved before Slack is told it arrived, so that a restart, or a conversation that doesn't show
    // it yet, can't lose it. If saving fails, Slack sends it again.
    if (!keep(message, route, route.to === 'top' ? slackState().top : workspace?.slack)) return false;
    if (!early) void readConversation(workspace?.id ?? TOP);
    return true;
  }
  // In a thread that isn't a workspace's, and isn't read, so it's answered from here.
  return pointTo(message, route.files, markHandled) === 'handled';
}

function rootAwaited(): boolean {
  return Boolean(slackState().outbox?.some((post) => post.kind === 'root' && post.askedAt));
}

/** Saves what an event says the owner wrote until it's passed on. Whether that's done. */
function keep(message: SlackMessage, route: Extract<Route, { to: 'top' | 'thread' }>, ledger: Ledger | undefined): boolean {
  const saved = slackState();
  const ts = message.ts!;
  if (isHandled(ledger, ts) || saved.pending?.some((entry) => entry.ts === ts)) return true;
  const before = saved.pending;
  saved.pending = [...(before ?? []), {
    ts,
    ...(route.to === 'thread' ? { thread: route.thread } : {}),
    text: message.text ?? '',
    ...(message.subtype ? { subtype: message.subtype } : {}),
    ...(route.files ? { files: true } : {}),
    at: Date.now(),
  }];
  try {
    flushState({ required: true });
    return true;
  } catch {
    saved.pending = before;
    return false;
  }
}

/** What's pending in a conversation: a workspace's thread, or without one, the DM's top level. */
function pendingIn(thread: string | undefined): PendingMessage[] {
  return (slackState().pending ?? []).filter((entry) => entry.thread === thread);
}

/** Drops what's pending in a conversation that's been handled. */
function dropHandled(thread: string | undefined, ledger: Ledger): void {
  const saved = slackState();
  if (!saved.pending?.some((entry) => entry.thread === thread && isHandled(ledger, entry.ts))) return;
  saved.pending = saved.pending.filter((entry) => entry.thread !== thread || !isHandled(ledger, entry.ts));
  saveState();
}

/** Drops what's pending in a thread that isn't a workspace's and won't be, since no root is waiting on Slack: a reply somewhere else. */
function dropStrays(): void {
  const saved = slackState();
  if (!saved.pending?.some((entry) => entry.thread) || rootAwaited()) return;
  const threads = new Set(state.workspaces.flatMap((workspace) => (workspace.slack?.thread ? [workspace.slack.thread] : [])));
  const kept = saved.pending.filter((entry) => !entry.thread || threads.has(entry.thread));
  if (kept.length === saved.pending.length) return;
  saved.pending = kept;
  saveState();
}

/** A pending message as the event that announced it had it. */
function asAnnounced(entry: PendingMessage, owner: Owner): SlackMessage {
  return {
    ts: entry.ts, user: owner.user, text: entry.text,
    ...(entry.thread ? { thread_ts: entry.thread } : {}),
    ...(entry.subtype ? { subtype: entry.subtype } : {}),
    ...(entry.files ? { files: [{}] } : {}),
  };
}

/** Reads a conversation from as far as it's been handled, or once more after the read under way, which may have begun before what an event says is new. */
function readConversation(key: string): Promise<void> {
  if (!running) return Promise.resolve();
  let reader = readers.get(key);
  if (!reader) readers.set(key, (reader = { again: false, waits: 0 }));
  if (reader.reading) {
    reader.again = true;
    return reader.reading;
  }
  const current = reader;
  current.reading = (async () => {
    do {
      current.again = false;
      clearTimeout(current.retry);
      current.retry = undefined;
      try {
        if (await readOnce(key, current)) current.again = true;
      } catch (error) {
        console.error('could not read from Slack:', errorMessage(error));
        readLater(key, current);
      }
    } while (current.again && running);
  })().finally(() => {
    current.reading = undefined;
  });
  return current.reading;
}

/** Reads every conversation there is, for what was written while Lonca wasn't connected or couldn't read. */
export function catchUp(): Promise<void> {
  dropStrays();
  const keys = [TOP, ...state.workspaces.flatMap((workspace) => (workspace.slack?.thread ? [workspace.id] : []))];
  return Promise.all(keys.map((key) => readConversation(key))).then(() => {});
}

/** Reads the conversations with something recent in them, for a message whose event Slack didn't send. A reconnect reads every one. */
function poll(): void {
  if (!running || live.connection !== 'connected') return;
  const since = Date.now() - SLACK_TIMING.activeMs;
  const ledgers: [string, Ledger | undefined][] = [[TOP, slackState().top], ...state.workspaces.map((workspace): [string, Ledger | undefined] => [workspace.id, workspace.slack])];
  ledgers
    .filter(([, ledger]) => (ledger?.active ?? 0) > since)
    .sort(([, a], [, b]) => b!.active! - a!.active!)
    .slice(0, SLACK_TIMING.pollMost)
    .forEach(([key]) => void readConversation(key));
}

/** Something couldn't be read or saved, so the conversation is read again in a while, or as long as Slack said to wait. */
function readLater(key: string, reader: Reader, wait = SLACK_TIMING.retryMs): void {
  if (reader.retry || !running) return;
  reader.retry = setTimeout(() => {
    reader.retry = undefined;
    void readConversation(key);
  }, wait);
  reader.retry.unref();
}

/** Where a conversation is read from, and how far it's been handled. */
interface Conversation {
  method: 'conversations.replies' | 'conversations.history';
  params: Record<string, string>;
  /** A workspace's thread, or none for the DM's top level. */
  thread?: string;
  /** How far it's been handled, unless it's not the conversation that was read anymore: its thread started again, say. */
  ledger: () => Ledger | undefined;
  /** Handles a message read from it. */
  take: (message: SlackMessage) => Outcome | Promise<Outcome>;
}

function conversationOf(key: string, owner: Owner): Conversation | undefined {
  const sameDm = () => slackState().owner?.dm === owner.dm;
  if (key === TOP) {
    const top = slackState().top;
    if (!top?.handled) return undefined;
    return {
      method: 'conversations.history',
      params: { channel: owner.dm, oldest: top.handled },
      ledger: () => (sameDm() ? slackState().top : undefined),
      take: (message) => atTop(message, owner),
    };
  }
  const workspace = getWorkspace(key);
  const thread = workspace?.slack?.thread;
  if (!workspace || !thread) return undefined;
  return {
    method: 'conversations.replies',
    params: { channel: owner.dm, ts: thread, oldest: workspace.slack?.handled ?? thread },
    thread,
    ledger: () => (sameDm() && getWorkspace(key) === workspace && workspace.slack?.thread === thread ? workspace.slack : undefined),
    take: (message) => inThread(workspace, thread, message, owner),
  };
}

/**
 * Handles what's new in a conversation, in the order it was written, up to a message that has to
 * wait. Whether there's more after what was read, which is read next.
 */
async function readOnce(key: string, reader: Reader): Promise<boolean> {
  const tokens = slackTokens();
  const owner = slackState().owner;
  const generation = live.generation;
  const signal = generationSignal();
  if (!tokens || !owner || live.refused) return false;
  const conversation = conversationOf(key, owner);
  if (!conversation) return false;
  let read: { messages: SlackMessage[]; complete: boolean };
  try {
    read = await readMessages(conversation.method, tokens.bot, conversation.params, signal);
  } catch (error) {
    // Read for a connection that's been replaced, by a disconnect, new tokens or a new owner.
    if (live.generation !== generation || !running) return false;
    // Its root was deleted, so nothing more can be written in it.
    if (error instanceof SlackError && error.code === 'thread_not_found') return false;
    if (error instanceof SlackError && error.refused) {
      refused(error.code);
      return false;
    }
    console.error('could not read from Slack:', errorMessage(error));
    readLater(key, reader, error instanceof SlackError ? error.retryAfterMs : undefined);
    return false;
  }
  if (live.generation !== generation || !running) return false;
  const shown = read.messages.filter((entry) => entry.ts).sort((a, b) => compareTs(a.ts!, b.ts!));
  noteSeen(shown.at(-1)?.ts);
  // Where there was more than Lonca reads at once, a thread's replies come oldest first, so what's
  // after the last of these is read next. The DM's top level comes newest first, so what's before
  // the first of these is passed over: it would only have been pointed to a thread.
  const replies = conversation.method === 'conversations.replies';
  const through = !read.complete && replies ? shown.at(-1)?.ts : undefined;
  const from = !read.complete && !replies ? shown[0]?.ts : undefined;
  const unshown = pendingIn(conversation.thread).filter((entry) => !shown.some((message) => message.ts === entry.ts)
    && (!through || compareTs(entry.ts, through) < 0) && (!from || compareTs(entry.ts, from) > 0));
  const items: { ts: string; message?: SlackMessage; entry?: PendingMessage }[] = [
    ...shown.map((message) => ({ ts: message.ts!, message })),
    ...unshown.map((entry) => ({ ts: entry.ts, entry })),
  ].sort((a, b) => compareTs(a.ts, b.ts));
  const before = conversation.ledger()?.handled;
  for (const item of items) {
    if (!conversation.ledger()) return false;
    if (isHandled(conversation.ledger(), item.ts)) continue;
    let message = item.message;
    if (!message) {
      // An event said it was written, but Slack doesn't show it yet, so what's after it waits. Once
      // it's waited long enough, it's passed on as the event had it, in its place.
      const waited = Date.now() - item.entry!.at;
      if (waited < SLACK_TIMING.graceMs) {
        readLater(key, reader, Math.min(SLACK_TIMING.pendingRetryMs * 2 ** reader.waits++, SLACK_TIMING.pendingMaxRetryMs, SLACK_TIMING.graceMs - waited));
        return false;
      }
      message = asAnnounced(item.entry!, owner);
    }
    // Read from the owner's DM, which says less about itself than an event does.
    const outcome = await conversation.take({ ...message, type: 'message', channel: owner.dm, channel_type: 'im' });
    if (live.generation !== generation || !running) return false;
    if (outcome === 'later') {
      readLater(key, reader);
      return false;
    }
    const ledger = conversation.ledger();
    if (!ledger) return false;
    handledThrough(ledger, item.ts);
    dropHandled(conversation.thread, ledger);
    saveState();
  }
  reader.waits = 0;
  const ledger = conversation.ledger();
  if (ledger) dropHandled(conversation.thread, ledger);
  if (through) {
    if (ledger?.handled !== before) return true;
    // Nothing more was read than what's been handled, which reading again at once wouldn't change.
    readLater(key, reader);
  }
  return false;
}

/** A message read from a workspace's thread, which goes to its Lead if it's the owner's. */
function inThread(workspace: Workspace, thread: string, message: SlackMessage, owner: Owner): Outcome | Promise<Outcome> {
  const route = routeMessage(message, owner, Boolean(live.pairing?.open()));
  if (route.to !== 'thread' || route.thread !== thread) return 'handled';
  return toLead(workspace, message.ts!, plainText(message.text ?? '').trim(), route.files);
}

/** A message read from the DM's top level. No Lead reads there, so the owner is pointed to a thread. A reply also sent there is read in its thread. */
function atTop(message: SlackMessage, owner: Owner): Outcome {
  const route = routeMessage(message, owner, Boolean(live.pairing?.open()));
  return route.to === 'top' ? pointTo(message, route.files, handledThrough) : 'handled';
}

/** Says, once, under what the owner wrote, where to write to a Lead. */
function pointTo(message: SlackMessage, files: boolean, mark: (ledger: Ledger, ts: string) => void): Outcome {
  const top = (slackState().top ??= {});
  const ts = message.ts!;
  if (isHandled(top, ts) || (!plainText(message.text ?? '').trim() && !files)) return 'handled';
  return answer(top, ts, { id: `re-${ts}`, kind: 'text', ts: message.thread_ts ?? ts, text: ELSEWHERE, at: Date.now() }, mark);
}

/** Whether a message is in one of the workspace's Leads' conversations already, which a crash before it was marked handled leaves. */
function accepted(workspace: Workspace, id: string): boolean {
  return state.sessions.some((session) => {
    if (session.workspaceId !== workspace.id || session.role !== 'lead') return false;
    if (session.queue.includes(id)) return true;
    try {
      const item = transcriptFor(session.id).find(id);
      // One written to the conversation without its place in the queue being saved wasn't accepted.
      return item?.type === 'user' && !item.queued;
    } catch {
      return false;
    }
  });
}

async function toLead(workspace: Workspace, ts: string, text: string, files: boolean): Promise<Outcome> {
  const ledger = workspace.slack!;
  const id = slackItemId(slackState().owner!.dm, ts);
  if (!accepted(workspace, id)) {
    const lead = leadOf(workspace.id);
    if (!lead) return answer(ledger, ts, reply(workspace, ts, NO_LEAD));
    if (!text) return files ? answer(ledger, ts, reply(workspace, ts, NO_FILES)) : 'handled';
    // Exactly as the composer sends it, so that it wakes the workspace, releases a pause and clears the dot.
    const generation = live.generation;
    const sending = sendMessage(lead.id, text, [], { id, via: 'slack', context: FROM_SLACK });
    // It's accepted once it's saved, before the workspace has woken, which what's after it needn't wait for.
    if (accepted(workspace, id)) {
      sending.catch((error: unknown) => console.error('could not finish passing on a message from Slack:', errorMessage(error)));
    } else {
      try {
        await sending;
      } catch (error) {
        // Slack was disconnected, given other tokens or paired again meanwhile, so it's not for them to hear.
        if (live.generation !== generation) return 'handled';
        // Saving failed, so it's read again later, ahead of anything after it.
        if (!(error instanceof HttpError) || error.status >= 500) {
          console.error('could not pass on a message from Slack:', errorMessage(error));
          return 'later';
        }
        return answer(ledger, ts, reply(workspace, ts, `This didn’t reach the Lead: ${sentence(error.message)}`));
      }
      if (live.generation !== generation) return 'handled';
    }
  }
  // An eyes reaction says it reached Lonca.
  enqueue({ id: `eyes-${ts}`, kind: 'reaction', workspace: workspace.id, ts, at: Date.now() }, ...(files ? [reply(workspace, ts, NO_FILES)] : []));
  handledThrough(ledger, ts);
  ledger.active = Date.now();
  saveState();
  drain();
  return 'handled';
}

function reply(workspace: Workspace, ts: string, text: string): SlackPost {
  return { id: `re-${ts}`, kind: 'text', workspace: workspace.id, text, at: Date.now() };
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Says something back, once: the post and that the message was handled are saved together, before
 * anything after it is read, or Slack is told it arrived.
 */
function answer(ledger: Ledger, ts: string, post: SlackPost, mark = handledThrough): Outcome {
  const before = { outbox: slackState().outbox, handled: ledger.handled, done: ledger.done };
  enqueue(post);
  mark(ledger, ts);
  ledger.active = Date.now();
  try {
    flushState({ required: true });
  } catch {
    slackState().outbox = before.outbox;
    Object.assign(ledger, { handled: before.handled, done: before.done });
    return 'later';
  }
  drain();
  return 'handled';
}

/** A code that matched, whose DM Slack is opening. A new code, or a new generation, calls it off. */
let pairingUnderWay: { code: PairingCode; controller: AbortController } | undefined;

/**
 * A code from someone's DM with the app. It's checked at once, and Slack is told the message
 * arrived. Opening the DM waits on Slack, so it happens after, and nothing waits for it.
 */
function pair(message: SlackMessage, team: string | undefined): Outcome {
  const code = live.pairing;
  // The code again, while it's being paired with already.
  if (!code || pairingUnderWay?.code === code) return 'handled';
  const check = code.check(message.text ?? '');
  if (check === 'wrong' && code.ended() === 'attempts') {
    live.pairing = undefined;
    live.pairingEnded = 'attempts';
    publishStatus();
  }
  if (check === 'match') {
    const attempt = { code, controller: new AbortController() };
    pairingUnderWay = attempt;
    void finishPairing(attempt, message, team, live.generation, AbortSignal.any([attempt.controller.signal, generationSignal()])).finally(() => {
      if (pairingUnderWay === attempt) pairingUnderWay = undefined;
    });
  }
  return 'handled';
}

/**
 * Opens the DM with whoever sent the code, and saves them as the owner. The code stays good until
 * then. Should a new code be offered, or Slack be disconnected, given other tokens or paired
 * meanwhile, it's called off, waiting included.
 */
async function finishPairing(
  attempt: { code: PairingCode },
  message: SlackMessage,
  team: string | undefined,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  const { code } = attempt;
  const over = () => signal.aborted || live.generation !== generation || live.pairing !== code || !code.open();
  for (let tries = 1; tries <= 5; tries++) {
    const tokens = slackTokens();
    if (!tokens || over()) return;
    let wait = 1000 * 2 ** (tries - 1);
    try {
      const opened = await slackCall<{ channel?: { id?: string; is_im?: boolean; user?: string } }>('conversations.open', tokens.bot, { users: message.user, return_im: true }, signal);
      if (over()) return;
      // The only conversation Lonca ever posts to is a DM between the app and this one person.
      if (!opened.channel?.id || opened.channel.is_im !== true || opened.channel.user !== message.user) {
        console.error('Slack didn’t open a DM with the user pairing, so Lonca isn’t paired with them.');
        return;
      }
      // The code came to a DM with another app than the bot token's, so the two tokens are two apps':
      // Lonca would post where the user doesn't write, and not hear what they do.
      if (opened.channel.id !== message.channel) {
        live.pairing = undefined;
        live.pairingEnded = 'otherApp';
        publishStatus();
        return;
      }
      // Posts on their way to the last owner can't be called back, so someone else is paired once
      // Slack has answered for them, or after a while, when Settings says one may still arrive.
      let settled = true;
      const last = slackState().owner;
      if (last && last.dm !== opened.channel.id) {
        holdOutbox(attempt, true);
        try {
          settled = await writesSettled(SLACK_TIMING.writesWaitMs, signal);
        } finally {
          holdOutbox(attempt, false);
        }
        if (over()) return drain();
      }
      if (savePairing(code, message, team, opened.channel.id)) {
        if (!settled) {
          live.postMayArrive = true;
          publishStatus();
        }
        return;
      }
      drain();
    } catch (error) {
      if (over()) return;
      if (error instanceof SlackError && error.refused) return refused(error.code);
      if (error instanceof SlackError && error.retryAfterMs) wait = error.retryAfterMs;
    }
    await sleep(wait, signal);
  }
  if (!over()) console.error('Could not finish pairing with Slack. Send the code again.');
}

function savePairing(code: PairingCode, message: SlackMessage, team: string | undefined, dm: string): boolean {
  const saved = slackState();
  const before = { owner: saved.owner, top: saved.top, outbox: saved.outbox, threads: state.workspaces.map((workspace) => workspace.slack) };
  if (saved.owner && saved.owner.dm !== dm) forgetPairing();
  else newGeneration();
  saved.owner = { user: message.user!, team: team ?? saved.bot?.team ?? '', dm };
  // What came before pairing wasn't written to Lonca, and the code has been answered.
  saved.top = { handled: message.ts!, active: Date.now() };
  noteSeen(message.ts);
  enqueue({ id: `paired-${message.ts}`, kind: 'text', text: PAIRED, at: Date.now() });
  try {
    flushState({ required: true });
  } catch {
    Object.assign(saved, { owner: before.owner, top: before.top, outbox: before.outbox });
    state.workspaces.forEach((workspace, index) => {
      workspace.slack = before.threads[index];
    });
    return false;
  }
  code.use();
  live.pairing = undefined;
  live.postMayArrive = undefined;
  publishStatus();
  drain();
  // What the owner wrote while the DM was being opened went unanswered, so it's read now.
  void catchUp();
  return true;
}

// What's posted

/**
 * A Lead needs the user, so its latest reply goes to its workspace's thread, with a line saying why
 * if it didn't just finish. Whether or not Lonca is open in a browser.
 */
export function postLeadReply(lead: Session, why: NeedsYou): void {
  try {
    decide(lead, why);
  } catch (error) {
    console.error('could not post a Lead’s reply to Slack:', errorMessage(error));
  }
}

function decide(lead: Session, why: NeedsYou): void {
  if (!state.settings.slackReplies || !slackTokens() || !slackState().owner) return;
  const workspace = getWorkspace(lead.workspaceId);
  if (!workspace) return;
  const items = transcriptFor(lead.id).items;
  const runId = items.findLast((item) => item.runId)?.runId;
  const moment = `${lead.id}:${runId ?? ''}:${why}`;
  const thread = (workspace.slack ??= {});
  if (thread.last === moment) return;
  // The last thing it wrote in its latest turn, not to an agent, unless that's been posted already.
  const reply = runId ? items.findLast((item): item is TextItem => item.type === 'text' && item.runId === runId && !item.parentId && Boolean(item.text.trim())) : undefined;
  const fresh = reply && reply.id !== thread.lastItem ? reply : undefined;
  // Made safe before it's split, so that each part's length is what's posted.
  const parts = replyParts(fresh ? safeText(fresh.text) : '', MOMENTS[why] ?? (fresh ? undefined : SAID_NOTHING));
  const id = `${workspace.id}-${newId()}`;
  const rooted = thread.thread || slackState().outbox?.some((post) => post.kind === 'root' && post.workspace === workspace.id);
  enqueue(...(rooted ? [] : [rootPost(workspace)]), ...parts.map((text, index): SlackPost => ({ id: `${id}-${index + 1}`, kind: 'text', workspace: workspace.id, text, at: Date.now() })));
  thread.last = moment;
  if (fresh) thread.lastItem = fresh.id;
  // The owner's likely to answer it.
  thread.active = Date.now();
  // Saved now, since nothing would decide this again: the turn it was about has been retired. If
  // that fails, it's saved before Slack is asked to make it.
  flushState();
  drain();
}
