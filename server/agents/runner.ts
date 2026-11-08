import crypto from 'node:crypto';
import type { AgentId, AgentJob, AgentWork, Attachment, ChatItem, LeadChoice, Project, Session, ToolItem, TurnOutcome, UserItem, Workspace } from '../../shared/types.ts';
import { MAX_AUTONOMOUS_TURNS, staysHeld } from '../../shared/lead.ts';
import { defaultProfile, profileIdOf } from '../../shared/profiles.ts';
import { codexTurn, turnProfile } from '../boundary.ts';
import { RUNS_DIR } from '../config.ts';
import { execEnv } from '../env.ts';
import { exec, execStream, execText, isSandboxRunning, sandboxState, type OutputStream } from '../sandbox.ts';
import { publish } from '../events.ts';
import { refreshDiffStat } from '../inspect.ts';
import { deleteTranscript, flushState, flushTranscript, getProject, getSession, getWorkspace, saveState, state } from '../store.ts';
import { clearProfileLimit, getProfile, markAgentRejected, markProfileLimited, system } from '../system.ts';
import { dropTranscript, transcriptFor } from '../transcript.ts';
import { HttpError, KeyedQueue, errorMessage, newId, sleep } from '../util.ts';
import { onWorkspaceReady, onWorkspaceTeardown, publishWorkspace, runningSandbox, setUpCodex, startWorkspace } from '../workspaces.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { playbookFor } from './playbook.ts';
import { agentProcessCommand, leadToolsScript, parseOutputReceipt, parseToolCall, type ToolCall } from './process.ts';
import { currentJobNote, scratchDir, sessionPrompt, userPrompt } from './prompt.ts';
import { sanitizeItem } from './sanitize.ts';
import { TEAM_TOOLS } from './team-tools.ts';
import type { AgentAdapter, AgentParser, ChatOp } from './types.ts';

const adapters: Record<AgentId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter };

const STOP_GRACE_MS = 4000;
const TITLE_LENGTH = 48;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_RUN_BYTES = 2 * 1024 ** 3;
const MAX_TOOL_CALLS_PER_TURN = 200;
const ACTIVITY_EVERY_MS = 2000;
const ACTIVITY_LENGTH = 90;

/** What a Lead and its team add to a turn. It's in team.ts, which builds on this file. */
export interface TeamHooks {
  toolCall(lead: Session, call: ToolCall): Promise<{ text: string; failed?: boolean }>;
  /** A turn ended or a session went away, which may be what a Lead was waiting for. */
  settled(workspaceId: string, session?: Session): void;
  /** What a Lead taking over a workspace needs to be told. */
  handover(workspace: Workspace): string | undefined;
  paused(lead: Session, why: string): void;
  /** A turn on this sign-in reached its usage limit, which the conversation may be able to carry on from on another. */
  limitReached(session: Session, profileId: string, stopped: boolean): Promise<void>;
}

let team: TeamHooks = {
  toolCall: async () => ({ text: '', failed: true }), settled: () => {}, handover: () => undefined, paused: () => {}, limitReached: async () => {},
};

export function setTeamHooks(hooks: TeamHooks): void {
  team = hooks;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  workspaceId: string;
  sandbox: string;
  dir: string;
  parser: AgentParser;
  startedAt: number;
  /** Bytes of output fully handled, so a dropped connection can pick up where it left off. */
  offset: number;
  interrupted: boolean;
  stopRequestedAt?: number;
  /** An explicit Stop holds follow-ups; rebuilding only delays them until the runtime is ready. */
  holdQueue: boolean;
  /** False until the process exists, which is when it can first be signalled. */
  launched: boolean;
  sawResult: boolean;
  outputLimitHit: boolean;
  output: OutputStream | null;
  /** The original user item, kept across recovery so a lost CLI conversation can be retried. */
  item?: UserItem;
  /** The conversation the CLI was asked to continue. */
  resumedFrom?: string | null;
  /** Keep saved output available until a replay can replace it completely. */
  replay?: { previous: ChatItem[]; seen: Set<string> };
  /** Tool calls being handled. A reconnect can hand on a call whose reply isn't written yet. */
  toolCalls: Set<string>;
  /** They're handled one at a time, since each one costs the host a process or two. */
  toolQueue: Promise<void>;
  outcome?: TurnOutcome;
  limited: boolean;
  limitResetsAt?: number;
  reportedFailure: boolean;
  /** Someone asked for this to stop, as opposed to it being cut off. */
  stopped: boolean;
  /** The exact playbook sent in this turn, acknowledged only when the turn completes. */
  playbookVersion?: string;
  /** The conversation has been told its workspace stopped. */
  reportedStopped?: boolean;
  /** The sign-in it runs on, which its limits and refusals belong to. None for a project's own key. */
  profileId?: string;
}

const runs = new Map<string, ActiveRun>();
const deletingSessions = new Set<string>();

export function publishSession(session: Session): void {
  if (!getSession(session.id)) return;
  session.updatedAt = Date.now();
  publish({ type: 'session', session });
  saveState();
}

export interface ToolReceipt {
  lead: Session;
  id: string;
  reply: { text: string; failed?: boolean };
}

/** Save chat records, the mutation and its optional tool receipt without an intervening await. */
export function persistSession(session: Session, patch: Partial<Session>, receipt?: ToolReceipt): void {
  flushTranscript(session.id);
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, session[key as keyof Session]]));
  const replies = receipt?.lead.toolReplies;
  Object.assign(session, patch);
  if (receipt) receipt.lead.toolReplies = { ...replies, [receipt.id]: receipt.reply };
  try {
    flushState({ required: true });
  } catch (error) {
    Object.assign(session, previous);
    if (receipt) receipt.lead.toolReplies = replies;
    throw error;
  }
  publishSession(session);
  if (receipt && receipt.lead !== session) publishSession(receipt.lead);
}

export function leadOf(workspaceId: string): Session | undefined {
  return state.sessions.find((session) => session.workspaceId === workspaceId && session.role === 'lead' && !session.closedAt);
}

export function agentsOf(workspaceId: string): Session[] {
  return state.sessions.filter((session) => session.workspaceId === workspaceId && session.role === 'agent');
}

/** A sign-in of this provider's, the one asked for if it's there, or else its default. */
export function chooseProfile(agent: AgentId, wanted: string | undefined): string {
  const profile = wanted ? getProfile(wanted) : undefined;
  return profile?.agent === agent ? profile.id : defaultProfile(state.profiles, agent)?.id ?? agent;
}

export function createSession(workspace: Workspace, options: {
  agent?: AgentId;
  model?: string;
  effort?: string;
  profileId?: string;
  id?: string;
  title?: string;
  role?: Session['role'];
  work?: AgentWork;
}): Session {
  const { defaultAgent, defaultModel, defaultEffort } = state.settings;
  const agent = options.agent ?? defaultAgent;
  const catalog = state.catalog[agent].models;
  const matching = options.model ?? (agent === defaultAgent ? defaultModel : catalog[0]?.id);
  const model = catalog.find((entry) => entry.id === matching) ?? catalog[0];
  const wanted = options.effort ?? (agent === defaultAgent ? defaultEffort : model?.defaultEffort);
  const now = Date.now();
  const session: Session = {
    id: options.id ?? newId(),
    workspaceId: workspace.id,
    title: options.title ?? 'Untitled',
    ...(options.role ? { role: options.role } : {}),
    ...(options.work ? { work: options.work } : {}),
    agent,
    model: model?.id ?? matching ?? '',
    effort: model?.efforts.includes(wanted ?? '') ? wanted! : model?.defaultEffort ?? 'medium',
    profileId: chooseProfile(agent, options.profileId),
    status: 'idle',
    resumeId: null,
    activeRunId: null,
    queue: [],
    hasMessages: false,
    createdAt: now,
    updatedAt: now,
  };
  state.sessions.push(session);
  publishSession(session);
  return session;
}

/** A workspace has one Lead at a time, and a new one stays on a model that's been locked. */
export function createLead(workspace: Workspace, choice: Partial<LeadChoice> = {}): Session {
  if (leadOf(workspace.id)) throw new HttpError(409, 'This workspace already has a Lead. Close it to start another.');
  const fallback = workspace.lead ?? state.settings.leadDefault;
  const wanted = workspace.leadLockedAt ? workspace.lead! : {
    agent: choice.agent ?? fallback.agent, model: choice.model ?? fallback.model, effort: choice.effort ?? fallback.effort,
    profileId: choice.profileId ?? (!choice.agent || choice.agent === fallback.agent ? fallback.profileId : undefined),
  };
  const session = createSession(workspace, { ...wanted, role: 'lead', title: 'Lead' });
  // A locked model that has since gone from the catalog stays what it was, so that this can say so.
  if (workspace.leadLockedAt) {
    Object.assign(session, { agent: workspace.lead!.agent, model: workspace.lead!.model, effort: workspace.lead!.effort });
    publishSession(session);
  }
  workspace.lead = { agent: session.agent, model: session.model, effort: session.effort, profileId: session.profileId };
  publishWorkspace(workspace);
  return session;
}

function noteActivity(session: Session, tool: ToolItem): void {
  const work = session.work;
  if (!work) return;
  const firstLine = tool.detail?.split('\n')[0];
  work.activity = (firstLine ? `${tool.title} ${firstLine}` : tool.title).slice(0, ACTIVITY_LENGTH);
  // Often enough to follow, without saving and sending the session for every tool call.
  const last = lastActivityPublish.get(session.id) ?? 0;
  if (Date.now() - last < ACTIVITY_EVERY_MS) return;
  lastActivityPublish.set(session.id, Date.now());
  publishSession(session);
}

const lastActivityPublish = new Map<string, number>();

function apply(sessionId: string, run: ActiveRun | null, ops: ChatOp[]): void {
  // Output can keep arriving while a deleted conversation's process is stopping.
  if (!getSession(sessionId)) return;
  const transcript = transcriptFor(sessionId);
  for (const op of ops) {
    switch (op.op) {
      case 'upsert': {
        const item = sanitizeItem(op.item);
        run?.replay?.seen.add(item.id);
        if (item.type === 'result' && run) {
          run.sawResult = true;
          run.reportedFailure ||= Boolean(item.failed);
          item.durationMs ??= Date.now() - run.startedAt;
        }
        // Which sign-in refused it or reached a limit, which isn't the conversation's for long.
        if (item.type === 'notice' && item.code && run?.profileId) item.profileId = run.profileId;
        if (item.type === 'notice' && item.code === 'auth' && run?.profileId) markAgentRejected(run.profileId);
        if (item.type === 'notice' && item.code === 'limit' && run) {
          run.limited = true;
          run.limitResetsAt = item.resetsAt;
        }
        if (item.type === 'tool') {
          const session = getSession(sessionId);
          if (session) noteActivity(session, item);
        }
        transcript.upsert(item);
        break;
      }
      case 'delta':
        transcript.delta(op.itemId, String(op.text));
        break;
      case 'remove':
        transcript.remove(op.itemId);
        break;
      case 'resume': {
        const session = getSession(sessionId);
        if (session && typeof op.id === 'string' && session.resumeId !== op.id) {
          session.resumeId = op.id;
          saveState();
        }
        break;
      }
    }
  }
}

export function notice(sessionId: string, runId: string | undefined, level: 'info' | 'warning' | 'error', text: string): void {
  if (!getSession(sessionId)) return;
  transcriptFor(sessionId).upsert({ id: newId(), ts: Date.now(), runId, type: 'notice', level, text });
}

function reportStopped(run: ActiveRun): void {
  if (!run.reportedStopped) notice(run.sessionId, run.runId, 'info', 'The workspace stopped. Start it to recover the remaining conversation output.');
  run.reportedStopped = true;
}

/**
 * For a workspace stopped where its followers can't see it, such as by signing Docker Sandboxes
 * out. They carry on following, and read what's left once it's started.
 */
export function reportWorkspaceStopped(workspaceId: string): void {
  for (const run of runs.values()) if (run.workspaceId === workspaceId) reportStopped(run);
}

interface PendingLine {
  data: Buffer;
  skipping: boolean;
}

function handleLine(run: ActiveRun, line: string): void {
  if (!line.trim()) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  try {
    apply(run.sessionId, run, run.parser.line(event));
  } catch (error) {
    console.error('could not handle agent output:', errorMessage(error));
  }
}

/** Splits output into lines, with limits that keep a misbehaving agent from filling this process's memory. */
function handleOutput(run: ActiveRun, chunk: Buffer, pending: PendingLine): void {
  if (run.outputLimitHit) return;
  pending.data = pending.data.length ? Buffer.concat([pending.data, chunk]) : chunk;
  let start = 0;
  let newline: number;
  while ((newline = pending.data.indexOf(0x0a, start)) >= 0) {
    run.offset += newline - start + 1;
    if (pending.skipping) pending.skipping = false;
    else handleLine(run, pending.data.subarray(start, newline).toString('utf8'));
    start = newline + 1;
  }
  pending.data = pending.data.subarray(start);
  if (pending.data.length > MAX_LINE_BYTES) {
    run.offset += pending.data.length;
    pending.data = Buffer.alloc(0);
    pending.skipping = true;
  }
  if (run.offset > MAX_RUN_BYTES) {
    run.outputLimitHit = true;
    run.interrupted = true;
    run.holdQueue = true;
    notice(run.sessionId, run.runId, 'error', 'The agent produced too much output, so it was stopped.');
    stopProcess(run);
  }
}

type ProcessState = 'alive' | 'dead' | 'unknown';

/** Errors reaching a sandbox don't mean the agent died; treating them that way would abandon a live process. */
async function processState(run: ActiveRun): Promise<ProcessState> {
  try {
    // sbx exec can boot a stopped VM. Checking its state first keeps recovery
    // from waking a workspace just to discover that its old process is gone.
    if (await sandboxState(run.sandbox) !== 'running') return 'dead';
    const state = (await execText(run.sandbox, agentProcessCommand('status', run.dir), { timeoutMs: 10000 })).trim();
    if (state !== 'alive' && state !== 'dead') throw new Error('Could not identify the agent process');
    return state;
  } catch {
    return 'unknown';
  }
}

/** A launched run needs a follower even if saving its pending Stop fails. */
async function superviseRun(run: ActiveRun, stop?: { holdQueue: boolean }): Promise<void> {
  run.launched = true;
  try {
    if (stop) await interruptSession(run.sessionId, stop);
  } finally {
    // Start the grace period even when persistence prevented interruptSession from
    // sending TERM. The run ID was saved before launch, so it remains recoverable.
    if (run.interrupted && run.stopRequestedAt === undefined) stopProcess(run);
    void follow(run).catch((error) => console.error('lost track of an agent run:', errorMessage(error)));
  }
}

/** Explicit workspace deletion remains authorized across failed cleanup and restarts. */
function mayDiscardOutput(run: ActiveRun): boolean {
  return run.outputLimitHit || deletingSessions.has(run.sessionId)
    || getWorkspace(run.workspaceId)?.pendingOperation === 'delete';
}

/** Follows a run's output file until its process exits, reconnecting if the stream drops. */
async function follow(run: ActiveRun): Promise<void> {
  let skipping = false;
  let reported = false;
  let reportedUnavailable = false;
  let exit = { code: null as number | null, stderr: '' };
  let complete = false;
  for (;;) {
    const runtime = await sandboxState(run.sandbox).catch(() => null);
    if (runtime === 'missing') {
      notice(run.sessionId, run.runId, 'warning', 'The workspace runtime was removed before its remaining output could be read. Previously saved conversation items have been kept.');
      run.interrupted = true;
      run.holdQueue = true;
      break;
    }
    if (runtime === 'stopped') {
      // Explicit deletion and the output limit intentionally discard output.
      if (mayDiscardOutput(run)) {
        run.interrupted = true;
        run.holdQueue = true;
        break;
      }
      const workspace = getWorkspace(run.workspaceId);
      if (workspace?.status === 'ready' && !workspace.pendingOperation) {
        workspace.status = 'stopped';
        publishWorkspace(workspace);
      }
      reportStopped(run);
    }
    if (runtime !== 'running') {
      await sleep(2000);
      continue;
    }
    // Deliver a pending Stop before attaching a tail that may otherwise stay open forever.
    // One that was never signalled starts its grace period now, with TERM, so the CLI can save.
    if (run.interrupted && run.stopRequestedAt === undefined) stopProcess(run);
    else if (run.interrupted) await signalProcess(run, Date.now() - run.stopRequestedAt! >= STOP_GRACE_MS ? 'KILL' : 'TERM');
    const pending: PendingLine = { data: Buffer.alloc(0), skipping };
    let receiptText = '';
    try {
      const output = await execStream(run.sandbox, agentProcessCommand('follow', run.dir, String(run.offset), ...(isLead(run) ? ['calls'] : [])));
      run.output = output;
      const onOutput = (chunk: Buffer) => handleOutput(run, chunk, pending);
      let toolLines = '';
      const onReceipt = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        receiptText = (receiptText + text).slice(-32768);
        if (!isLead(run)) return;
        const lines = (toolLines + text).split('\n');
        toolLines = lines.pop() ?? '';
        for (const line of lines) {
          const call = parseToolCall(line);
          if (call) answerToolCall(run, call);
        }
      };
      output.stdout.on('data', onOutput);
      output.stderr.on('data', onReceipt);
      try {
        await output.finished;
      } finally {
        output.stdout.off('data', onOutput);
        output.stderr.off('data', onReceipt);
      }
    } catch {
      // A failed attachment must retry even if the agent has already exited.
    }
    run.output = null;
    skipping = pending.skipping;
    const receipt = parseOutputReceipt(receiptText);
    if (receipt?.end === run.offset + pending.data.length && !run.outputLimitHit) {
      // EOF also closes a valid final JSON record without a trailing newline.
      if (!pending.skipping && pending.data.length) handleLine(run, pending.data.toString('utf8'));
      run.offset += pending.data.length;
      exit = receipt;
      complete = true;
      break;
    }
    const state = await processState(run);
    const unavailable = receipt?.unavailable;
    if (unavailable) {
      if (!reportedUnavailable) notice(run.sessionId, run.runId, 'warning', `${unavailable} Previously saved conversation items have been kept.`);
      reportedUnavailable = true;
      reported = true;
      run.interrupted = true;
      run.holdQueue = true;
      if (state === 'dead') { if (receipt) exit = receipt; break; }
      if (run.stopRequestedAt === undefined) stopProcess(run);
    } else if (state === 'dead' && mayDiscardOutput(run)) {
      run.interrupted = true;
      run.holdQueue = true;
      break; // Explicit deletion and the output limit intentionally discard output.
    } else if (!reported) {
      notice(run.sessionId, run.runId, 'warning', 'Reading this conversation was interrupted. Lonca is keeping its recovery data and retrying.');
      reported = true;
    }
    // Retry from the last fully handled line; preserve skipping of oversized lines.
    await sleep(state === 'alive' ? 500 : 2000);
  }
  await finishRun(run, exit, complete);
}

// A turn cut off before the CLI saved its conversation leaves an ID that can't be continued, and
// every later message would fail the same way.
const LOST_CONVERSATION = /No conversation found with session ID|no rollout found for thread id/i;

function isLead(run: ActiveRun): boolean {
  return getSession(run.sessionId)?.role === 'lead';
}

/** Lonca's tools answer in a file the Lead's CLI is watching for. */
async function writeToolReply(run: ActiveRun, callId: string, reply: { text: string; failed?: boolean }): Promise<void> {
  for (let attempt = 1; runs.get(run.sessionId) === run; attempt++) {
    try {
      // Writing it mustn't boot a VM that stopped while this was being handled.
      if (!await isSandboxRunning(run.sandbox)) throw new Error('The workspace’s runtime stopped.');
      await execText(run.sandbox, ['bash', '-c', 'cat > "$0.tmp" && mv "$0.tmp" "$0"', `${run.dir}/replies/${callId}.json`], { stdin: JSON.stringify(reply), timeoutMs: 15000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1000);
    }
  }
}

function answerToolCall(run: ActiveRun, call: ToolCall): void {
  // Any process in the workspace can write to this file, so what it can ask of the server has limits.
  if (run.toolCalls.has(call.id) || run.toolCalls.size >= MAX_TOOL_CALLS_PER_TURN) return;
  run.toolCalls.add(call.id);
  run.toolQueue = run.toolQueue.then(async () => {
    const lead = getSession(run.sessionId);
    // What a Lead asked for before it was stopped shouldn't start anything new after it.
    const reply = lead && !run.stopped
      ? await team.toolCall(lead, call).catch((error) => ({ text: errorMessage(error), failed: true }))
      : { text: 'The Lead was stopped, so this wasn\'t done.', failed: true };
    await writeToolReply(run, call.id, reply);
  }).catch((error) => {
    // It's handled again if the follower reconnects, and the CLI gives up on it eventually.
    run.toolCalls.delete(call.id);
    console.error('could not answer a tool call:', errorMessage(error));
  });
}

// A throwaway index, so this leaves the real one alone. Starting from a copy of it means only
// changed files are read again. Git ignores what a test run or an install leaves behind.
const FILES_SCRIPT = String.raw`
set -eu
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cp "$(git rev-parse --git-path index)" "$tmp"
export GIT_INDEX_FILE="$tmp"
git add -A -- . >/dev/null 2>&1
git write-tree
`;

/** Identifies the state of a workspace's files, committed or not. */
async function filesFingerprint(sandbox: string, workspace: Workspace): Promise<string | undefined> {
  return (await execText(sandbox, ['bash', '-c', FILES_SCRIPT], { workdir: workspace.path, timeoutMs: 60000 }).catch(() => ''))?.trim() || undefined;
}

/** An agent told not to change files can't be prevented from it, but it can't go unnoticed. */
async function checkFilesUntouched(run: ActiveRun, session: Session): Promise<void> {
  const before = session.work?.filesBefore;
  const workspace = getWorkspace(run.workspaceId);
  if (!session.work || !before || !workspace) return;
  session.work.filesBefore = undefined;
  session.work.filesChanged = false;
  if (!await isSandboxRunning(run.sandbox).catch(() => false)) return;
  const after = await filesFingerprint(run.sandbox, workspace);
  if (!after || after === before) return;
  session.work.filesChanged = true;
  notice(session.id, run.runId, 'warning', 'The workspace’s files changed while this agent was working. It was told not to change any, so it or another agent did.');
}

async function finishRun(run: ActiveRun, { code, stderr }: { code: number | null; stderr: string }, complete = false): Promise<void> {
  const { sessionId, runId } = run;
  const session = getSession(sessionId);
  if (!session) {
    runs.delete(sessionId);
    cleanupRunOutput(run);
    return;
  }
  if (code !== 0 && !run.interrupted && run.item && run.resumedFrom && LOST_CONVERSATION.test(stderr)) {
    // Keep the original run recoverable until the message is durably queued to start again.
    transcriptFor(session.id).removeRun(run.runId);
    transcriptFor(session.id).moveToEnd({ ...run.item, queued: true });
    notice(session.id, undefined, 'info', 'The earlier part of this conversation couldn’t be loaded, so the agent started a new one with your message.');
    await retireRun(run, () => ({ resumeId: null, queue: [run.item!.id, ...session.queue] }));
    return;
  }
  apply(sessionId, run, run.parser.finish());
  if (run.replay && !complete) {
    // A missing runtime/file cannot replace saved answers with a partial replay.
    for (const item of run.replay.previous) transcriptFor(sessionId).upsert(item);
  }
  const failed = code !== 0;
  if (!run.sawResult) {
    if (failed && !run.interrupted) {
      notice(sessionId, runId, 'error', stderr || (code === null
        ? 'The agent’s process ended unexpectedly. Its virtual machine may have stopped.'
        : `The agent exited with code ${code}.`));
    }
    apply(sessionId, run, [{
      op: 'upsert',
      item: { id: `${runId}:result`, ts: Date.now(), runId, type: 'result', interrupted: run.interrupted, failed: failed && !run.interrupted },
    }]);
  }
  if (run.replay && complete) {
    for (const item of run.replay.previous) {
      if (!run.replay.seen.has(item.id)) transcriptFor(sessionId).remove(item.id);
    }
  }
  run.outcome = run.limited ? 'limit' : run.stopped ? 'stopped' : failed || run.interrupted || run.reportedFailure ? 'failed' : 'completed';
  if (run.profileId && run.outcome === 'limit') markProfileLimited(run.profileId, run.limitResetsAt);
  // A turn picked up after a restart can't say when it began, so it leaves a limit for one that can.
  if (run.profileId && run.outcome === 'completed' && !run.replay) clearProfileLimit(run.profileId, run.startedAt);
  await checkFilesUntouched(run, session);
  await retireRun(run);
}

/** Cleanup must not boot a stopped VM just because its conversation was deleted. */
function cleanupRunOutput(run: ActiveRun): void {
  if (run.sandbox) void isSandboxRunning(run.sandbox)
    .then((running) => running ? exec(run.sandbox, ['rm', '-rf', run.dir]) : undefined)
    .catch(() => {});
}

/** Retain both recovery sources until transcript and completion state have been saved. */
async function retireRun(run: ActiveRun, extra: () => Partial<Session> = () => ({})): Promise<void> {
  let reported = false;
  for (;;) {
    const session = getSession(run.sessionId);
    if (!session) break;
    try {
      const patch = extra();
      persistSession(session, {
        ...patch, ...outcomeOf(run, session), status: 'idle', activeRunId: null, activeMessageId: undefined, activeProfileId: undefined, stopRequested: undefined,
        ...(session.role === 'lead' ? { toolReplies: undefined } : {}),
        // Whatever is queued would only meet the same limit.
        held: run.outcome === 'limit' || (run.holdQueue && (patch.queue ?? session.queue).length > 0) ? true : session.held,
      });
      break;
    } catch (error) {
      if (!reported) {
        console.error('could not finish saving a turn:', errorMessage(error));
        notice(session.id, run.runId, 'warning', 'Saving this conversation was delayed by a storage error. Lonca is keeping its recovery data and retrying.');
        reported = true;
      }
      await sleep(1000);
    }
  }
  runs.delete(run.sessionId);
  // Only now is the completed transcript a durable replacement for the raw output.
  cleanupRunOutput(run);
  const session = getSession(run.sessionId);
  const workspace = getWorkspace(run.workspaceId);
  // Before anyone hears about the limit, since the conversation may carry on elsewhere.
  if (session && run.outcome === 'limit' && run.profileId) {
    await team.limitReached(session, run.profileId, run.stopped).catch((error) => console.error('could not move a conversation at its limit:', errorMessage(error)));
  }
  if (session && workspace?.status === 'ready') {
    refreshDiffStat(workspace).catch(() => {});
    startNextQueued(session);
  }
  if (session) team.settled(session.workspaceId, session);
}

/** How a finished turn changes its session. A turn that's being retried hasn't finished. */
function outcomeOf(run: ActiveRun, session: Session): Partial<Session> {
  if (!run.outcome) return {};
  return {
    lastOutcome: run.outcome,
    ...(run.outcome === 'completed' && run.playbookVersion ? { playbookVersion: run.playbookVersion } : {}),
    limitResetsAt: run.outcome === 'limit' ? run.limitResetsAt : undefined,
    limitProfileId: run.outcome === 'limit' ? run.profileId : undefined,
    ...(session.work ? {
      // Whoever stopped it knows, so nobody needs telling.
      unread: run.outcome !== 'stopped',
      work: { ...session.work, activity: undefined, unreported: run.outcome !== 'stopped' },
    } : {}),
  };
}

/**
 * Claude keeps the instructions from a conversation's first turn when it resumes one, whatever it's
 * given later, so a Lead has to be told when they've changed.
 */
function playbookUpdate(session: Session, run: ActiveRun, content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  run.playbookVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const changed = session.playbookVersion !== run.playbookVersion;
  // The CLI may retain this edit even if the turn stops or the server crashes. Invalidate the
  // old acknowledgment before delivery, so reverting the edit will still be sent next time.
  if (changed && session.playbookVersion) persistSession(session, { playbookVersion: undefined });
  return session.resumeId && changed
    ? `Update from Lonca: this is your current playbook. From now on, follow this instead of the one you started with:\n\n${content}` : undefined;
}

/** What a turn's processes are given, which isn't the same for a Lead and the agents it starts, or on every sign-in. */
export function turnEnv(session: Session, project: Project, profileId: string): string[] {
  const profile = getProfile(profileId) ?? { id: profileId, agent: session.agent };
  const env = session.agent === 'claude'
    ? execEnv(project, profile)
    : [...execEnv(project), ...codexTurn(profile, project).env];
  // Claude would otherwise leave the Lead's tools to be looked up, and it might not bother.
  if (session.role === 'lead') return [...env, 'ENABLE_TOOL_SEARCH=false'];
  if (session.role !== 'agent') return env;
  return [
    ...env,
    `LONCA_SCRATCH=${scratchDir(session.id)}`,
    // It's shared across a repository, which would let agents read each other's notes.
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
  ];
}

async function startRun(session: Session, workspace: Workspace, item: UserItem): Promise<void> {
  const project = getProject(workspace.projectId);
  if (!project) throw new HttpError(404, 'This workspace’s project no longer exists');
  const runId = newId();
  const adapter = adapters[session.agent];
  const profileId = profileIdOf(session);
  const run: ActiveRun = {
    runId, sessionId: session.id, workspaceId: workspace.id, sandbox: '', dir: `${RUNS_DIR}/${runId}`,
    parser: adapter.parser(runId),
    startedAt: Date.now(), offset: 0, interrupted: false, holdQueue: false, launched: false, sawResult: false, outputLimitHit: false, output: null,
    item, resumedFrom: session.resumeId, toolCalls: new Set(), toolQueue: Promise.resolve(), limited: false, reportedFailure: false, stopped: false,
    profileId: turnProfile(session.agent, profileId, project),
  };
  // Registered before anything slow happens, so Stop works from the moment the turn begins.
  runs.set(session.id, run);
  let persisted = false;
  let launchAttempted = false;

  try {
    // Keep the accepted item queued until its promotion and run ID are both saved.
    persistSession(session, {
      status: 'running', activeRunId: runId, activeMessageId: item.id, activeProfileId: profileId, stopRequested: undefined,
      ...(session.role === 'lead' ? { toolReplies: undefined } : {}),
      queue: session.queue.filter((id) => id !== item.id),
      lastOutcome: undefined, limitResetsAt: undefined,
      ...(session.role === 'lead' && item.from === 'lonca' ? { autonomousTurns: (session.autonomousTurns ?? 0) + 1 } : {}),
      ...(session.work ? { work: { ...session.work, turnStartedAt: Date.now(), activity: undefined, filesChanged: false } } : {}),
    });
    persisted = true;
    const sandbox = await runningSandbox(workspace);
    run.sandbox = sandbox;
    const attachments = item.attachments ?? [];
    if (session.agent === 'codex') await setUpCodex(workspace, project);
    // Both prompts use one snapshot, even if the user edits the playbook while startup awaits I/O.
    const playbook = session.role === 'lead' ? playbookFor(project).content : undefined;
    await execText(sandbox, ['mkdir', '-p', run.dir, ...(session.work ? [scratchDir(session.id)] : [])]);
    await execText(sandbox, ['bash', '-c', 'cat > "$0"', `${run.dir}/prompt`], {
      stdin: userPrompt([playbookUpdate(session, run, playbook), item.context, item.text, currentJobNote(session)].filter(Boolean).join('\n\n'), attachments),
    });
    if (session.role === 'lead') {
      await execText(sandbox, ['bash', '-c', 'mkdir -p "$0/replies" && cat > "$0/lonca-tools.py"', run.dir], { stdin: leadToolsScript(TEAM_TOOLS) });
    }
    if (session.work && session.work.job !== 'implement') session.work.filesBefore = await filesFingerprint(sandbox, workspace);
    if (run.interrupted) {
      await finishRun(run, { code: null, stderr: '' });
      return;
    }
    const command = adapter.command({
      session, workspace, project, attachments, systemPrompt: sessionPrompt(session, workspace, project, playbook),
      ...(session.role === 'lead' ? { tools: { command: 'python3', args: ['-I', `${run.dir}/lonca-tools.py`, run.dir] } } : {}),
      ...(session.agent === 'codex' ? { config: codexTurn(getProfile(profileId), project).config } : {}),
    });
    launchAttempted = true;
    await execText(sandbox, ['lonca-run', run.dir, ...command], {
      env: turnEnv(session, project, profileId),
      workdir: workspace.path,
      timeoutMs: 20000,
    });
    await superviseRun(run);
  } catch (error) {
    // A failed acknowledgment says nothing about whether the CLI ran, or even
    // finished. Drain its output through the same receipt/persistence boundary.
    if (run.sandbox && launchAttempted) {
      notice(session.id, runId, 'error', `Could not confirm agent startup; recovering its output: ${errorMessage(error)}`);
      run.holdQueue = true;
      await superviseRun(run, await processState(run) === 'dead' ? undefined : { holdQueue: true });
      return;
    }
    if (run.sandbox) await signalProcess(run, 'KILL');
    notice(session.id, runId, 'error', `Could not start the agent: ${errorMessage(error)}`);
    if (!persisted) {
      // No process was launched and the accepted message is still durably queued.
      // Release the reservation so Send now can retry on this same server.
      runs.delete(session.id);
      transcriptFor(session.id).moveToEnd({ ...item, queued: true });
      session.held = true;
      publishSession(session);
      try { persistSession(session, {}); } catch { /* The accepted queue entry remains recoverable. */ }
      return;
    }
    // A failed start shouldn't consume every follow-up while storage or the runtime is broken.
    run.holdQueue = true;
    run.outcome = 'failed';
    await retireRun(run);
  }
}

export function startNextQueued(session: Session): void {
  if (!getSession(session.id) || session.closedAt || deletingSessions.has(session.id) || runs.has(session.id) || session.activeRunId) return;
  const workspace = getWorkspace(session.workspaceId);
  if (!workspace || workspace.status !== 'ready' || session.status === 'running' || session.held) return;
  const nextId = session.queue[0];
  if (!nextId) return;
  let transcript: ReturnType<typeof transcriptFor>;
  try {
    transcript = transcriptFor(session.id);
  } catch (error) {
    // An unreadable conversation says nothing about its queue. The message waits until it can be read.
    console.error('could not read a conversation with queued messages:', errorMessage(error));
    return;
  }
  const item = transcript.find(nextId);
  if (item?.type !== 'user') {
    session.queue.shift();
    startNextQueued(session);
    return;
  }
  if (item.from === 'lonca' && session.role === 'lead' && (session.autonomousTurns ?? 0) >= MAX_AUTONOMOUS_TURNS) {
    session.held = true;
    publishSession(session);
    team.paused(session, `The Lead paused after ${MAX_AUTONOMOUS_TURNS} turns without a word from you. Use Send now to let it continue.`);
    return;
  }
  // A queued message joins the conversation when it's sent, after the turn it waited for.
  const started: UserItem = { ...item, queued: false, ts: Date.now() };
  transcript.moveToEnd(started);
  void startRun(session, workspace, started).catch((error) => console.error('could not start a turn:', errorMessage(error)));
}

onWorkspaceReady((workspace) => {
  void resumeActiveRuns().catch((error) => console.error('could not recover agent output:', errorMessage(error)));
  for (const session of state.sessions.filter((entry) => entry.workspaceId === workspace.id)) {
    startNextQueued(session);
  }
});

onWorkspaceTeardown(async (workspace) => {
  // A teardown requested immediately after server startup must pick up saved
  // runs too, before it can replace the disk holding their output.
  await resumeActiveRuns();
  const active = state.sessions.filter((session) => session.workspaceId === workspace.id && session.activeRunId);
  await Promise.all(active.map((session) => interruptSession(session.id, { holdQueue: workspace.status !== 'rebuilding' })));
  for (let i = 0; i < 100 && active.some((session) => session.activeRunId); i++) await sleep(100);
  if (active.some((session) => session.activeRunId)) throw new HttpError(409, 'An agent is still stopping. Retry once its process can be reached.');
});

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH).trimEnd()}…` : line;
}

const NOT_ACCEPTING = new Set<Workspace['status']>(['archived', 'archiving', 'error', 'deleting', 'stopping']);

export interface MessageOptions {
  /** Lets a repeated request recognize that this has already been sent. */
  id?: string;
  from?: UserItem['from'];
  summary?: string;
  /** Respect user stops and automatic pauses when sending on behalf of the Lead. */
  keepHeld?: boolean;
  /** A Lead's job change is accepted with its message, rather than ahead of it. */
  job?: AgentJob;
  receipt?: ToolReceipt;
  /** Saved in the same write as the message, so that nothing can come between the two. */
  patch?: Partial<Session>;
}

/** Releasing a queue also applies to a Stop whose process is still being retired or recovered. */
function releaseQueueHold(session: Session, patch: Partial<Session>, receipt?: ToolReceipt): void {
  persistSession(session, {
    ...patch, held: false, userStopped: undefined,
    ...(session.stopRequested ? { stopRequested: { holdQueue: false } } : {}),
  }, receipt);
  const run = runs.get(session.id);
  // Change the live run only after saving the release, so a failed write doesn't release work.
  if (run?.stopped) run.holdQueue = false;
}

export async function sendMessage(sessionId: string, text: string, attachments: Attachment[], options: MessageOptions = {}): Promise<UserItem> {
  const session = getSession(sessionId);
  if (!session) throw new HttpError(404, 'No such session');
  if (session.closedAt) throw new HttpError(409, 'This Lead was closed. Its conversation can still be read.');
  if (deletingSessions.has(sessionId)) throw new HttpError(409, 'This conversation is closing.');
  const workspace = getWorkspace(session.workspaceId);
  if (!workspace) throw new HttpError(404, 'No such workspace');
  if (NOT_ACCEPTING.has(workspace.status)) throw new HttpError(409, `${workspace.name} is ${workspace.status}`);

  const canStart = workspace.status === 'ready' && session.status !== 'running' && session.queue.length === 0;
  // Startup can discover an external stop or fail. Keep Send now available
  // until startNextQueued has actually promoted this saved message.
  const item: UserItem = {
    id: options.id ?? newId(), ts: Date.now(), type: 'user', text, attachments, queued: true,
    ...(options.from ? { from: options.from } : {}),
    ...(options.summary ? { summary: options.summary } : {}),
  };
  const locksLead = session.role === 'lead' && !workspace.leadLockedAt;
  const fromUser = !options.from;
  let transcript: ReturnType<typeof transcriptFor> | undefined;
  try {
    transcript = transcriptFor(session.id);
    if (session.role === 'lead' && !session.hasMessages) {
      const handover = team.handover(workspace);
      if (handover) {
        item.context = handover;
        notice(session.id, undefined, 'info', `What this Lead was told:\n\n${handover}`);
      }
    }
    transcript.upsert(item);
    if (locksLead) {
      workspace.lead = { agent: session.agent, model: session.model, effort: session.effort, profileId: profileIdOf(session) };
      workspace.leadLockedAt = Date.now();
    }
    // Accept the text and its queue reservation together before acknowledging it or starting a CLI.
    const patch: Partial<Session> = {
      ...options.patch,
      hasMessages: true,
      title: !session.hasMessages && session.title === 'Untitled' ? titleFrom(text) : session.title,
      queue: [...session.queue, item.id],
      ...(session.role === 'lead' && fromUser ? { autonomousTurns: 0, unread: false } : {}),
      ...(session.work && fromUser ? { work: { ...session.work, userNote: text.slice(0, 1000) } } : {}),
      ...(session.work && options.job ? { work: { ...session.work, job: options.job } } : {}),
    };
    if (options.keepHeld && staysHeld(session)) persistSession(session, { ...patch, held: true }, options.receipt);
    else releaseQueueHold(session, patch, options.receipt);
  } catch (error) {
    if (locksLead) delete workspace.leadLockedAt;
    transcript?.remove(item.id);
    try { flushTranscript(session.id); } catch { /* Retry the rollback when storage recovers. */ }
    throw new HttpError(500, `Your message could not be saved: ${errorMessage(error)}`);
  }
  if (locksLead) publishWorkspace(workspace);
  if (!workspace.title) {
    workspace.title = titleFrom(text);
    publishWorkspace(workspace);
  }
  if (workspace.status === 'stopped' || workspace.status === 'ready') {
    // Sending a message is reason enough to wake a stopped workspace.
    // The saved status may still say ready after an external stop.
    try {
      await startWorkspace(workspace);
      startNextQueued(session);
    } catch (error) {
      // The message is already accepted. A failed wake must not make the composer resend it.
      notice(session.id, undefined, 'error', `Your message is queued, but the workspace could not start: ${errorMessage(error)}. Use Send now to retry.`);
    }
  } else {
    startNextQueued(session);
  }
  return canStart && !session.queue.includes(item.id) ? { ...item, queued: false } : item;
}

/** Releases waiting messages, saving a Lead retry's receipt in the same state write. */
export async function flushQueue(sessionId: string, receipt?: ToolReceipt, patch: Partial<Session> = {}): Promise<void> {
  const session = getSession(sessionId);
  if (!session) throw new HttpError(404, 'No such session');
  if (deletingSessions.has(sessionId)) throw new HttpError(409, 'This conversation is closing.');
  const workspace = getWorkspace(session.workspaceId);
  if (!workspace) throw new HttpError(404, 'No such workspace');
  if (NOT_ACCEPTING.has(workspace.status)) throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  // Releasing it is someone going on, so a Lead's turns without the user count from nothing, unless the patch says otherwise.
  releaseQueueHold(session, { ...(session.role === 'lead' ? { autonomousTurns: 0 } : {}), ...patch }, receipt);
  if ((workspace.status === 'stopped' || workspace.status === 'ready') && session.queue.length > 0) await startWorkspace(workspace);
  startNextQueued(session);
}

export function cancelQueued(sessionId: string, itemId: string): void {
  const session = getSession(sessionId);
  if (!session) throw new HttpError(404, 'No such session');
  if (!session.queue.includes(itemId)) throw new HttpError(404, 'That message is no longer queued');
  const transcript = transcriptFor(sessionId);
  const item = transcript.find(itemId);
  const queue = session.queue.filter((id) => id !== itemId);
  transcript.remove(itemId);
  try {
    // A Lead or agent the user stopped stays stopped, with or without something waiting for it.
    persistSession(session, { queue, held: queue.length === 0 && !session.role ? false : session.held });
  } catch (error) {
    if (item) transcript.upsert(item);
    try { flushTranscript(sessionId); } catch { /* Preserve the original queued message on retry. */ }
    throw error;
  }
}

async function signalProcess(run: ActiveRun, name: 'TERM' | 'KILL'): Promise<void> {
  if (!run.sandbox || !await isSandboxRunning(run.sandbox).catch(() => false)) return;
  await exec(run.sandbox, agentProcessCommand('signal', run.dir, name), { timeoutMs: 10000 }).catch(() => {});
}

function stopProcess(run: ActiveRun): void {
  run.stopRequestedAt ??= Date.now();
  // TERM lets the CLI save its session so the conversation can be resumed.
  signalProcess(run, 'TERM');
  setTimeout(() => {
    if (runs.get(run.sessionId) !== run) return;
    signalProcess(run, 'KILL');
    // An output file swapped for a FIFO would leave the follower waiting forever.
    setTimeout(() => run.output?.stop(), 2000);
  }, STOP_GRACE_MS);
}

export async function interruptSession(sessionId: string, { holdQueue = true, receipt }: { holdQueue?: boolean; receipt?: ToolReceipt } = {}): Promise<void> {
  const run = runs.get(sessionId);
  const session = getSession(sessionId);
  if (!run) {
    // Recovery hasn't registered this run yet. It may still be changing files, even if its sandbox is unreachable.
    if (session?.activeRunId) {
      throw new HttpError(409, 'Lonca is reconnecting to this agent. Try Stop again after it reconnects.');
    }
    if (session?.status === 'running') {
      session.status = 'idle';
      session.activeRunId = null;
      delete session.activeMessageId;
      publishSession(session);
    }
    // An idle stop is still an accepted call; replay must not stop some later turn.
    if (session && receipt) persistSession(session, {}, receipt);
    return;
  }
  // A Lead stop and its receipt are saved together before signalling. A crash after this write
  // recovers stopRequested for this run, while a replay only returns the saved reply.
  if (session && receipt) persistSession(session, { stopRequested: { holdQueue: run.holdQueue || holdQueue } }, receipt);
  run.interrupted = true;
  run.stopped = true;
  run.holdQueue ||= holdQueue;
  // A user's Stop must still signal when the disk is full. Lead calls save first for replay.
  // Signalling and the synchronous save share this event-loop turn.
  if (run.launched) stopProcess(run);
  if (session && !receipt) {
    session.stopRequested = { holdQueue: run.holdQueue };
    publishSession(session);
    try {
      flushState({ required: true });
    } catch (error) {
      throw new HttpError(500, `The agent is stopping, but Lonca couldn’t save that it was asked to: ${errorMessage(error)}`);
    }
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (deletingSessions.has(sessionId)) throw new HttpError(409, 'This conversation is already closing.');
  deletingSessions.add(sessionId);
  try {
    await interruptSession(sessionId);
    // Keep the run ID and saved Stop until shutdown is confirmed, so recovery can
    // finish stopping the process if the server crashes or Docker Sandboxes disconnects.
    const active = () => runs.has(sessionId) || Boolean(getSession(sessionId)?.activeRunId);
    for (let i = 0; i < 100 && active(); i++) await sleep(100);
    if (active()) throw new HttpError(409, 'The agent is still stopping. Try closing this conversation again once its process can be reached.');
    const workspaceId = getSession(sessionId)?.workspaceId;
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    dropTranscript(sessionId);
    await deleteTranscript(sessionId);
    publish({ type: 'session.removed', id: sessionId });
    saveState();
    if (workspaceId) team.settled(workspaceId);
  } finally {
    deletingSessions.delete(sessionId);
  }
}

/** Closes a Lead the way a tab is closed, except that its conversation stays readable. */
export async function closeLead(session: Session): Promise<void> {
  if (!session.hasMessages) return deleteSession(session.id);
  if (deletingSessions.has(session.id)) throw new HttpError(409, 'This Lead is already closing.');
  deletingSessions.add(session.id);
  try {
    await interruptSession(session.id);
    const active = () => runs.has(session.id) || Boolean(session.activeRunId);
    for (let i = 0; i < 100 && active(); i++) await sleep(100);
    if (active()) throw new HttpError(409, 'The Lead is still stopping. Try closing it again once its process can be reached.');
    const transcript = transcriptFor(session.id);
    for (const id of session.queue) {
      const item = transcript.find(id);
      // What the user asked for stays on the record for the next Lead. Lonca's own updates would only be out of date.
      if (item?.type === 'user' && !item.from) transcript.upsert({ ...item, queued: false });
      else transcript.remove(id);
    }
    persistSession(session, { closedAt: Date.now(), queue: [], held: false, userStopped: undefined, unread: false });
  } finally {
    deletingSessions.delete(session.id);
  }
}

// Passes take turns, so a run is never picked up twice.
const resumption = new KeyedQueue();

/** Picks up agents that kept running while the server was down, replaying their output. */
export function resumeActiveRuns(): Promise<void> {
  return resumption.run('runs', async () => {
    await resumeUnfollowedRuns();
    for (const session of state.sessions) {
      if (session.status !== 'running') startNextQueued(session);
    }
    // A Lead may have been due a turn when the server stopped.
    for (const workspace of state.workspaces) team.settled(workspace.id);
  });
}

/** A run that couldn't be picked up, such as one whose conversation couldn't be read, is asked about again. */
export function retryActiveRuns(): Promise<void> {
  return resumption.run('runs', async () => {
    await resumeUnfollowedRuns({ quiet: true });
    for (const workspace of state.workspaces) team.settled(workspace.id);
  });
}

async function resumeUnfollowedRuns({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  // This also runs when Docker Sandboxes comes back, when some runs may never have stopped being followed.
  const pending = state.sessions.filter((session) => session.activeRunId && !runs.has(session.id));
  await Promise.all(pending.map((session) => resumeRun(session).catch((error) => {
    if (!quiet) console.error('could not check on running workspaces:', errorMessage(error));
  })));
}

async function resumeRun(session: Session): Promise<void> {
  if (!session.activeRunId || runs.has(session.id)) return;
  const runId = session.activeRunId;
  const workspace = getWorkspace(session.workspaceId);
  // With Docker Sandboxes signed out, a VM's agent may well still be working. This runs again once it can be asked.
  if (workspace && system.sandbox.state !== 'ready') return;
  // Register stopped and unreachable sandboxes too. The follower distinguishes
  // those from a removed sandbox and retains tracking until its output is read.
  if (workspace) {
    const transcript = transcriptFor(session.id);
    const item = session.activeMessageId ? transcript.find(session.activeMessageId) : undefined;
    const previous = transcript.items.filter((entry) => entry.runId === runId).map((entry) => ({ ...entry }));
    const run: ActiveRun = {
      runId, sessionId: session.id, workspaceId: workspace.id, sandbox: workspace.sandboxName, dir: `${RUNS_DIR}/${runId}`,
      parser: adapters[session.agent].parser(runId),
      startedAt: session.updatedAt, offset: 0, interrupted: Boolean(session.stopRequested), holdQueue: session.stopRequested?.holdQueue ?? false, launched: true, sawResult: false, outputLimitHit: false, output: null,
      item: item?.type === 'user' ? item : undefined, resumedFrom: session.resumeId,
      replay: { previous, seen: new Set() }, toolCalls: new Set(), toolQueue: Promise.resolve(), limited: false, reportedFailure: false, stopped: Boolean(session.stopRequested),
      // One that started before there could be several runs on the provider's first.
      profileId: turnProfile(session.agent, session.activeProfileId ?? session.agent, getProject(workspace.projectId)),
    };
    runs.set(session.id, run);
    // A crash during teardown can leave an agent alive in a workspace now marked error.
    // Keep tracking it through TERM/KILL, leaving queued work to run after a successful retry.
    await superviseRun(run, !['ready', 'stopped', 'starting'].includes(workspace.status)
      ? { holdQueue: workspace.pendingOperation !== 'rebuild' } : undefined);
  } else {
    transcriptFor(session.id).upsert({ id: `${runId}:result`, ts: Date.now(), runId, type: 'result', interrupted: true } satisfies ChatItem);
    persistSession(session, {
      status: 'idle', activeRunId: null, activeMessageId: undefined, activeProfileId: undefined, stopRequested: undefined,
      held: session.queue.length > 0 ? true : session.held,
    });
  }
}
