// What Lonca posts to Slack, made one at a time in the order it was decided. Each post is saved
// before Slack is asked to make it, so a restart or an outage doesn't lose it, and it names itself
// in the message's metadata, so that one Slack may have made before a crash is looked for in the
// conversation rather than made again. Receipts, the eyes on what the owner wrote, are made apart
// from everything else, so that one Slack won't take, or can't yet, never holds up a reply.
import type { Workspace } from '../../shared/types.ts';
import { flushState, getProject, getWorkspace, saveState, state } from '../store.ts';
import { errorMessage, newId, sleep } from '../util.ts';
import { generationSignal, hiddenSecrets, live, noteSeen, refused, setPostError, slackState, slackTokens, type SlackPost } from './state.ts';
import { fallbackText, quiet, redact } from './text.ts';
import { SlackError, readMessages, slackCall } from './web.ts';

export const OUTBOX_TIMING = {
  /** Slack takes about one message a second in a conversation. */
  spacingMs: 1100,
  /** The first wait after a failure, doubling with each one up to `maxRetryMs`. */
  retryMs: 2000,
  maxRetryMs: 5 * 60 * 1000,
  /** How long after an unanswered request to look for what it made, since one that timed out can still land. */
  settleMs: Number(process.env.LONCA_SLACK_SETTLE_SECONDS ?? 90) * 1000,
};

const METADATA_TYPE = 'lonca_post';

// What Slack won't take in this one post, which something shorter in its place gets past.
const UNPOSTABLE = new Set([
  'invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long', 'msg_too_long', 'invalid_metadata_format', 'invalid_metadata_schema',
  'metadata_too_large', 'too_many_attachments', 'attachment_payload_limit_exceeded', 'no_text', 'invalid_charset', 'markdown_text_conflict',
]);
const UNPOSTED = 'This reply couldn’t be posted to Slack. It’s in Lonca.';
// The message a post was to go under was deleted in Slack.
const PARENT_GONE = new Set(['thread_not_found', 'cannot_reply_to_message']);
// Normal pacing, which isn't worth a word in Settings.
const PACING = new Set(['ratelimited', 'rate_limited']);

/**
 * What may be posted of a text: without Lonca's secrets, and without anything Slack could read as
 * a mention. Everything posted goes through here, a Lead's reply or Lonca's own words, since even
 * those quote a workspace's title, which came from a message.
 */
export function safeText(text: string): string {
  return quiet(redact(text, hiddenSecrets()));
}

export function enqueue(...posts: SlackPost[]): void {
  const saved = slackState();
  saved.outbox = [...(saved.outbox ?? []), ...posts.map((post) => (post.text === undefined ? post : { ...post, text: safeText(post.text) }))];
}

/** The message a workspace's thread hangs from, which says which workspace it is. */
export function rootPost(workspace: Workspace): SlackPost {
  const project = getProject(workspace.projectId)?.name;
  const text = safeText([`**${workspace.name}**${project ? ` in ${project}` : ''}`, workspace.title ?? ''].filter(Boolean).join('\n'));
  return { id: `root-${workspace.id}-${newId()}`, kind: 'root', workspace: workspace.id, text, at: Date.now() };
}

/** A workspace that's gone has nowhere for its posts to go. */
export function dropPosts(workspaceId: string): void {
  const saved = slackState();
  if (!saved.outbox?.some((post) => post.workspace === workspaceId)) return;
  saved.outbox = saved.outbox.filter((post) => post.workspace !== workspaceId);
  saveState();
}

let rootMade: (workspace: Workspace) => void = () => {};

/** Told when a workspace's thread has a root, which the user may already have replied to. */
export function whenRootMade(listener: (workspace: Workspace) => void): void {
  rootMade = listener;
}

/** Replies, roots and Lonca's own words in order, and receipts, each made in order on their own. */
type Lane = 'replies' | 'receipts';

const lanes: Record<Lane, { draining: boolean; again: boolean }> = {
  replies: { draining: false, again: false },
  receipts: { draining: false, again: false },
};
let held = false;
const holds = new Set<unknown>();
const wakers = new Set<() => void>();
/** Requests to make a post or a receipt that Slack hasn't answered, which can't be called back. */
const writing = new Set<Promise<unknown>>();

/** Nothing more is posted until every reason it's held for is let go. What's waiting stays saved. */
export function holdOutbox(reason: unknown, hold: boolean): void {
  if (hold) holds.add(reason);
  else holds.delete(reason);
  held = holds.size > 0;
  if (held) wakeOutbox();
}

/** Waits up to `ms` for every request to make a post or a receipt to be answered, or less if it's called off. Whether they all were. */
export async function writesSettled(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (writing.size === 0) return true;
  const answers = new AbortController();
  let answered = false;
  void Promise.allSettled([...writing]).then(() => {
    answered = true;
    answers.abort();
  });
  await sleep(ms, signal ? AbortSignal.any([signal, answers.signal]) : answers.signal);
  return answered;
}

function write<T>(request: Promise<T>): Promise<T> {
  writing.add(request);
  const done = () => writing.delete(request);
  request.then(done, done);
  return request;
}

/** Makes what's waiting, unless that's under way already. */
export function drain(): void {
  if (held) return;
  for (const lane of ['replies', 'receipts'] as const) start(lane);
}

function start(lane: Lane): void {
  const flags = lanes[lane];
  if (flags.draining) {
    flags.again = true;
    return;
  }
  flags.draining = true;
  void makeAll(lane)
    .catch((error) => console.error('could not post to Slack:', errorMessage(error)))
    .finally(() => {
      flags.draining = false;
      if (flags.again && !held) start(lane);
    });
}

/** Ends a wait early, for new tokens or a disconnect, which change what can be posted. */
export function wakeOutbox(): void {
  for (const wake of [...wakers]) wake();
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.add(done);
  });
}

/**
 * `again` means things changed while it was being made, and the next post is looked at afresh. A
 * wait that's `settling` is for a request to land, which isn't a failure.
 */
type Outcome = 'made' | 'dropped' | 'again' | 'stop' | { wait?: number; settling?: boolean };

async function makeAll(lane: Lane): Promise<void> {
  let failures = 0;
  for (;;) {
    lanes[lane].again = false;
    if (held || !slackTokens() || !slackState().owner || live.refused) return;
    const post = next(lane);
    if (!post) return;
    const outcome = await make(post);
    if (outcome === 'stop') return;
    if (outcome === 'dropped' || outcome === 'again') continue;
    if (outcome === 'made') {
      failures = 0;
      if (post.kind !== 'reaction') await pause(OUTBOX_TIMING.spacingMs);
      continue;
    }
    if (!outcome.settling) failures++;
    await pause(outcome.wait ?? Math.min(OUTBOX_TIMING.maxRetryMs, OUTBOX_TIMING.retryMs * 2 ** (failures - 1)));
  }
}

/** A lane's first post, after a root for its workspace's thread if that hasn't been made. */
function next(lane: Lane): SlackPost | undefined {
  const saved = slackState();
  const outbox = saved.outbox ?? [];
  if (lane === 'receipts') return outbox.find((entry) => entry.kind === 'reaction');
  const post = outbox.find((entry) => entry.kind !== 'reaction');
  if (post?.kind !== 'text' || !post.workspace) return post;
  const workspace = getWorkspace(post.workspace);
  if (!workspace || workspace.slack?.thread) return post;
  const root = outbox.find((entry) => entry.kind === 'root' && entry.workspace === workspace.id) ?? rootPost(workspace);
  saved.outbox = [root, ...outbox.filter((entry) => entry !== root)];
  return root;
}

interface Target {
  bot: string;
  dm: string;
  thread?: string;
}

/**
 * Where a post goes, as things stand: in the owner's DM, in its workspace's thread, under a message
 * of theirs, or at its top. Nowhere if it shouldn't be made after all, because Slack was
 * disconnected or paired again, or it's no longer waiting. Asked again after anything that waits.
 */
function targetOf(post: SlackPost, generation: number): Target | 'workspace gone' | undefined {
  const tokens = slackTokens();
  const owner = slackState().owner;
  if (held || live.generation !== generation || !tokens || !owner) return undefined;
  if (!slackState().outbox?.some((entry) => entry.id === post.id)) return undefined;
  const workspace = post.workspace ? getWorkspace(post.workspace) : undefined;
  if (post.workspace && !workspace) return 'workspace gone';
  const thread = post.kind === 'root' ? undefined : workspace ? workspace.slack?.thread : post.kind === 'text' ? post.ts : undefined;
  // Its root hasn't been made, which the next post looked at will be.
  if (post.kind === 'text' && workspace && !thread) return undefined;
  return { bot: tokens.bot, dm: owner.dm, thread };
}

async function make(post: SlackPost): Promise<Outcome> {
  const generation = live.generation;
  const signal = generationSignal();
  let target = targetOf(post, generation);
  if (target === 'workspace gone') return drop(post);
  if (!target) return 'again';
  try {
    if (post.kind === 'reaction') {
      await write(slackCall('reactions.add', target.bot, { channel: target.dm, timestamp: post.ts, name: 'eyes' })).catch((error: unknown) => {
        if (!(error instanceof SlackError && error.code === 'already_reacted')) throw error;
      });
      return finish(post, target);
    }
    // Slack may have made it without saying so. chat.postMessage takes no key that would let Slack
    // refuse a repeat, so it's looked for in the conversation first, once a request that timed out
    // would have landed. One that lands later still can't be told apart, and is posted twice.
    if (post.askedAt) {
      const settling = post.askedAt + OUTBOX_TIMING.settleMs - Date.now();
      if (settling > 0) return { wait: settling, settling: true };
      const made = await find(post, target, signal);
      target = targetOf(post, generation);
      if (target === 'workspace gone') return drop(post);
      if (!target) return 'again';
      // There was more to look through than Lonca reads at once, which says nothing either way.
      if (made === 'unknown') return {};
      if (made !== 'absent') return finish(post, target, made);
    }
    post.askedAt = Date.now();
    post.after ??= slackState().seen;
    flushState({ required: true });
    let answer: { ts?: string };
    try {
      answer = await write(slackCall('chat.postMessage', target.bot, {
        channel: target.dm,
        ...(target.thread ? { thread_ts: target.thread } : {}),
        text: fallbackText(post.text ?? ''),
        blocks: [{ type: 'markdown', text: post.text ?? '' }],
        unfurl_links: false,
        unfurl_media: false,
        metadata: { event_type: METADATA_TYPE, event_payload: { id: post.id } },
      }));
    } catch (error) {
      // Slack answered no, so there's nothing to look for next time.
      if (error instanceof SlackError && !error.uncertain) {
        post.askedAt = undefined;
        saveState();
      }
      throw error;
    }
    return finish(post, target, answer.ts);
  } catch (error) {
    if (!(error instanceof SlackError)) {
      // Most likely a full disk, which saving the post before asking Slack ran into.
      console.error('could not save a post for Slack:', errorMessage(error));
      return {};
    }
    if (error.refused) {
      // About tokens that have since been replaced, it says nothing about the ones in use.
      if (live.generation === generation) refused(error.code);
      return 'stop';
    }
    if (live.generation !== generation) return 'again';
    // A receipt says no more than that a message arrived. One Slack won't take, on a message that's
    // been deleted say, is dropped, and only one it can't take yet is tried again.
    if (post.kind === 'reaction') return error.passing ? { wait: error.retryAfterMs } : drop(post);
    if (post.kind === 'text' && PARENT_GONE.has(error.code)) return parentGone(post);
    if (UNPOSTABLE.has(error.code) && !post.fallback) return replace(post);
    // Slack's trouble, or something Lonca doesn't know about, which may pass. Nothing is dropped for
    // it: the post is tried again, with the ones after it waiting their turn, and Settings says why.
    if (!PACING.has(error.code) && setPostError(error.code)) console.error(`Slack hasn't taken a post yet: ${error.code}`);
    return { wait: error.retryAfterMs };
  }
}

/** A post in place of one Slack won't take, so that those after it aren't held up. */
function replace(post: SlackPost): 'again' {
  const workspace = post.workspace ? getWorkspace(post.workspace) : undefined;
  Object.assign(post, { text: post.kind === 'root' && workspace ? safeText(`**${workspace.name}**`) : UNPOSTED, fallback: true, askedAt: undefined });
  saveState();
  return 'again';
}

/**
 * The message it was to go under was deleted in Slack. A workspace's thread starts again from a new
 * root. An answer to a message of the user's that they deleted has nothing left to answer.
 */
function parentGone(post: SlackPost): 'again' | 'dropped' {
  const workspace = post.workspace ? getWorkspace(post.workspace) : undefined;
  if (!workspace?.slack?.thread) return drop(post);
  const { thread: _gone, handled: _handled, done: _done, ...rest } = workspace.slack;
  workspace.slack = rest;
  post.askedAt = undefined;
  saveState();
  return 'again';
}

/**
 * The post's ts if Slack made it, `absent` if it didn't, or `unknown` if there was too much to tell.
 * It's looked for after a message Slack had before it was asked, by Slack's clock, since this
 * computer's can be hours out: after the newest Lonca had seen, or its thread's root, or pairing.
 */
async function find(post: SlackPost, target: Target, signal: AbortSignal): Promise<string | 'absent' | 'unknown'> {
  const oldest = post.after ?? target.thread ?? slackState().top?.handled;
  const params = { channel: target.dm, ...(oldest ? { oldest } : {}), include_all_metadata: true };
  const { messages, complete } = target.thread
    ? await readMessages('conversations.replies', target.bot, { ...params, ts: target.thread }, signal)
    : await readMessages('conversations.history', target.bot, params, signal);
  const made = messages.find((message) => message.metadata?.event_type === METADATA_TYPE && message.metadata.event_payload?.id === post.id)?.ts;
  return made ?? (complete ? 'absent' : 'unknown');
}

function finish(post: SlackPost, target: Target, ts?: string): 'made' {
  // Dropped while Slack was making it, by a disconnect, a new owner or the workspace going, so it
  // leads nowhere. What's kept across a new generation, for the same app and DM, is what was made.
  if (!state.slack?.outbox?.some((entry) => entry.id === post.id) || state.slack.owner?.dm !== target.dm) return 'made';
  // A receipt says nothing about why a reply can't be posted.
  if (post.kind !== 'reaction') setPostError(undefined);
  const saved = slackState();
  saved.outbox = (saved.outbox ?? []).filter((entry) => entry.id !== post.id);
  noteSeen(ts);
  const workspace = post.kind === 'root' && post.workspace ? getWorkspace(post.workspace) : undefined;
  // Nothing in the thread comes before its root, so that's as far as anything in it has been handled.
  if (workspace && ts) workspace.slack = { ...workspace.slack, thread: ts, handled: ts, done: undefined };
  saveState();
  if (workspace && ts) rootMade(workspace);
  return 'made';
}

/** Without its root, a workspace's other posts have nowhere to go either. */
function drop(post: SlackPost): 'dropped' {
  const saved = slackState();
  saved.outbox = (saved.outbox ?? []).filter((entry) => entry.id !== post.id && !(post.kind === 'root' && entry.workspace === post.workspace));
  saveState();
  return 'dropped';
}
