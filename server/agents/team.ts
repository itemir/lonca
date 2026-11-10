import crypto from 'node:crypto';
import type { AgentId, AgentJob, ChatItem, LeadChoice, NoticeItem, Profile, Session, TextItem, ToolItem, UserItem, Workspace } from '../../shared/types.ts';
import { READS_WHILE_WORKING } from '../../shared/catalog.ts';
import { canRun, isWorking, leadBlocker, staysHeld } from '../../shared/lead.ts';
import {
  autoSwitchTarget, hasSeveral, isLimited, isReady, leadDefaultFor, leadMayUse, limitEnds, profileIdOf, profileLabel, profileName, profileStatus,
  projectBringsKey,
} from '../../shared/profiles.ts';
import { notifyUser } from '../notify.ts';
import { getProject, getSession, getWorkspace, state } from '../store.ts';
import { getProfile, system } from '../system.ts';
import { transcriptFor } from '../transcript.ts';
import { HttpError } from '../util.ts';
import { publishWorkspace, startWorkspace } from '../workspaces.ts';
import type { ToolCall } from './process.ts';
import {
  agentsOf, closeLead, createLead, createSession, flushQueue, interruptSession, leadOf, notice, persistSession, publishSession, sendMessage, setTeamHooks, startNextQueued,
  type ToolReceipt,
} from './runner.ts';

const READ_LIMIT = 30000;
const LABEL_LENGTH = 40;
const JOBS: AgentJob[] = ['analyze', 'implement', 'review'];

/** Fails a tool call with something the Lead can act on. */
class ToolError extends Error {}

function modelName(session: Session): string {
  return state.catalog[session.agent].models.find((model) => model.id === session.model)?.label ?? session.model;
}

/** A sign-in's long name, such as "Claude – work". */
function signInName(id: string, agent: AgentId): string {
  return profileLabel(state.profiles, state.catalog, id, agent);
}

function nameOf(session: Session): string {
  // Which sign-in only says anything where there's more than one.
  const signIn = hasSeveral(state.profiles, session.agent) ? `, sign-in ${profileIdOf(session)}` : '';
  return `"${session.title}" (${modelName(session)}${signIn}, id ${session.id})`;
}

/** Whose usage limit stopped it, which can be another sign-in's than the one it's on now. */
function limitName(session: Session): string {
  return signInName(session.limitProfileId ?? profileIdOf(session), session.agent);
}

function stateOf(session: Session): string {
  if (session.status === 'running') return 'working';
  if (session.userStopped) return 'stopped by the user';
  if (session.queue.length > 0 && !session.held) return 'queued';
  switch (session.lastOutcome) {
    case 'limit': return `paused at the usage limit of ${limitName(session)}`;
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    case 'completed': return 'finished';
    default: return 'idle';
  }
}

/** Whether a Lead can start an agent on this provider, on a sign-in it may use. */
function signedIn(lead: Session, agent: AgentId, workspace: Workspace): boolean {
  const project = getProject(workspace.projectId);
  if (projectBringsKey(agent, project)) return true;
  return state.profiles.some((profile) => profile.agent === agent && leadMayUse(lead, profile, state.profiles)
    && canRun({ agent, profileId: profile.id }, system, project));
}

function usableModels(lead: Session, workspace: Workspace): string {
  return (Object.keys(state.catalog) as AgentId[])
    .filter((agent) => signedIn(lead, agent, workspace))
    .flatMap((agent) => state.catalog[agent].models.map((model) => `${model.id} (${state.catalog[agent].label}; ${model.efforts.join(', ')}; default ${model.defaultEffort})`))
    .join('\n');
}

function describeSignIn(profile: Profile, lead: Session): string {
  const status = profileStatus(system, profile.id);
  const ends = limitEnds(status);
  const whose = profile.agent === lead.agent && profile.id === profileIdOf(lead) ? 'yours'
    : leadMayUse(lead, profile, state.profiles) ? (profile.autoSwitch ? 'allowed' : 'the default') : 'not for you';
  const condition = !status.signedIn ? 'not signed in'
    : status.rejected ? 'its service stopped accepting it'
      : isLimited(status) ? `at its usage limit${ends ? ` until ${new Date(ends).toISOString()}` : ''}` : 'ready';
  return `- ${profile.id}: ${profileName(profile, state.catalog)} (${whose}): ${condition}`;
}

/** The sign-ins agents can run on, which the Lead can choose between when a provider has several. */
function signInList(lead: Session): string {
  return `Sign-ins (id: name (whether you may use it): state). You may start or move agents on yours, another provider's default, and any the user allowed:\n${state.profiles.map((profile) => describeSignIn(profile, lead)).join('\n')}`;
}

/**
 * The sign-in an agent of this provider runs on: the one the Lead asked for, if it may use it, or
 * its own, or for another provider that one's default.
 */
function signInArg(lead: Session, workspace: Workspace, agent: AgentId, args: Record<string, unknown>, current?: string): string {
  const wanted = args.sign_in;
  if (wanted === undefined || wanted === null || wanted === '') return current ?? leadDefaultFor(lead, agent, state.profiles) ?? agent;
  if (typeof wanted !== 'string') throw new ToolError('sign_in must be a sign-in id from team_status.');
  const profile = getProfile(wanted);
  if (!profile) throw new ToolError(`There's no sign-in with the id ${wanted}.\n\n${signInList(lead)}`);
  const name = profileName(profile, state.catalog);
  if (profile.agent !== agent) throw new ToolError(`${wanted} is one of ${state.catalog[profile.agent].label}’s sign-ins, and this model needs one of ${state.catalog[agent].label}’s.`);
  if (wanted === current) return wanted;
  if (!leadMayUse(lead, profile, state.profiles)) throw new ToolError(`The user hasn't allowed you to use ${name}. Ask them, or use one you may.\n\n${signInList(lead)}`);
  const status = profileStatus(system, profile.id);
  if (!projectBringsKey(agent, getProject(workspace.projectId))) {
    if (!isReady(status)) throw new ToolError(`${name} isn't signed in, so nothing can run on it.`);
    if (isLimited(status) && profile.id !== leadDefaultFor(lead, agent, state.profiles)) throw new ToolError(`${name} is at its usage limit.\n\n${signInList(lead)}`);
  }
  return profile.id;
}

function agentArg(lead: Session, args: Record<string, unknown>): Session {
  const agent = typeof args.id === 'string' ? getSession(args.id) : undefined;
  if (!agent || agent.role !== 'agent' || agent.workspaceId !== lead.workspaceId) {
    const ids = agentsOf(lead.workspaceId).map(nameOf).join(', ');
    throw new ToolError(`There's no agent with that id. ${ids ? `You have: ${ids}.` : 'You haven\'t started any.'}`);
  }
  return agent;
}

function textArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${name} is required.`);
  return value;
}

function jobArg(args: Record<string, unknown>): AgentJob | undefined {
  if (args.job === undefined) return undefined;
  if (!JOBS.includes(args.job as AgentJob)) throw new ToolError(`job must be one of: ${JOBS.join(', ')}.`);
  return args.job as AgentJob;
}

/** How many are working, if that leaves no room for this agent to start a turn. */
function fullWith(workspaceId: string, agent?: Session): number {
  const working = agentsOf(workspaceId).filter(isWorking);
  return (!agent || !working.includes(agent)) && working.length >= state.settings.leadMaxAgents ? working.length : 0;
}

/** One agent at a time changes files, so that two don't overwrite each other's work. */
function otherWriter(workspaceId: string, except?: Session): Session | undefined {
  return agentsOf(workspaceId).find((agent) => agent !== except && agent.work?.job === 'implement' && isWorking(agent));
}

function checkRoom(workspace: Workspace, agent?: Session): void {
  const working = fullWith(workspace.id, agent);
  if (working) throw new ToolError(`${working} agents are already working, which is the most allowed at once. End your turn: Lonca wakes you when they finish.`);
}

function checkOneWriter(lead: Session, job: AgentJob | undefined, except?: Session): void {
  const writer = job === 'implement' ? otherWriter(lead.workspaceId, except) : undefined;
  if (writer) throw new ToolError(`${nameOf(writer)} is already changing files, and only one agent can at a time. Wait for it to finish, or give this one a different job.`);
}

/** Try now and Send now can't know what's started since they appeared, so they answer to the same limits as the Lead. */
export function checkButtonCanStart(session: Session): void {
  if (session.role !== 'agent') return;
  const working = fullWith(session.workspaceId, session);
  if (working) throw new HttpError(409, `${working} agents are already working, which is the most allowed at once. Try again when one finishes.`);
  const writer = session.work?.job === 'implement' ? otherWriter(session.workspaceId, session) : undefined;
  if (writer) throw new HttpError(409, `${writer.title} is changing files, and only one agent can at a time. Try again when it finishes, or stop it first.`);
}

/** A message typed to an agent is deliberate, so it goes ahead, but not without saying what it risks. */
export function warnOfOtherWriter(session: Session): void {
  const writer = session.role === 'agent' && session.work?.job === 'implement' ? otherWriter(session.workspaceId, session) : undefined;
  if (writer) notice(session.id, undefined, 'warning', `${writer.title} is changing files at the same time, so these two could overwrite each other’s work.`);
}

function findModel(lead: Session, workspace: Workspace, id: string): { agent: AgentId; efforts: string[]; defaultEffort: string } {
  for (const agent of Object.keys(state.catalog) as AgentId[]) {
    const model = state.catalog[agent].models.find((entry) => entry.id === id);
    if (!model) continue;
    if (!signedIn(lead, agent, workspace)) throw new ToolError(`${state.catalog[agent].label} isn't signed in, so ${id} can't run. You can use:\n${usableModels(lead, workspace)}`);
    return { agent, efforts: model.efforts, defaultEffort: model.defaultEffort };
  }
  throw new ToolError(`There's no model called ${id}. You can use:\n${usableModels(lead, workspace)}`);
}

// The receipt is saved with the message, so replay can return the same reply even if the user
// cancels the message or deletes its agent before that reply reaches the CLI.
function deliver(session: Session, call: ToolCall, text: string, receipt: ToolReceipt, job?: AgentJob): Promise<unknown> {
  return sendMessage(session.id, text, [], { id: call.id, from: 'lead', keepHeld: true, receipt, job });
}

async function spawnAgent(lead: Session, workspace: Workspace, call: ToolCall): Promise<string> {
  const task = textArg(call.args, 'task');
  const id = crypto.createHash('sha256').update(call.id).digest('hex').slice(0, 12);
  let agent = getSession(id);
  if (!agent) {
    const label = textArg(call.args, 'label').trim().replace(/\s+/g, ' ').slice(0, LABEL_LENGTH);
    const job = jobArg(call.args) ?? 'analyze';
    const model = findModel(lead, workspace, textArg(call.args, 'model'));
    const effort = typeof call.args.effort === 'string' ? call.args.effort : model.defaultEffort;
    if (!model.efforts.includes(effort)) throw new ToolError(`${call.args.model} doesn't offer the thinking level ${effort}. It offers: ${model.efforts.join(', ')}.`);
    const profileId = signInArg(lead, workspace, model.agent, call.args);
    if (!canRun({ agent: model.agent, profileId }, system, getProject(workspace.projectId))) {
      throw new ToolError(`${signInName(profileId, model.agent)} isn't signed in, so ${call.args.model} can't run on it.\n\n${signInList(lead)}`);
    }
    checkRoom(workspace);
    checkOneWriter(lead, job);
    agent = createSession(workspace, { id, role: 'agent', title: label, agent: model.agent, model: call.args.model as string, effort, profileId, work: { job } });
  }
  const text = `Started ${nameOf(agent)}. End your turn: Lonca wakes you when it finishes.`;
  await deliver(agent, call, task, { lead, id: call.id, reply: { text } });
  return text;
}

async function messageAgent(lead: Session, workspace: Workspace, call: ToolCall): Promise<string> {
  const agent = agentArg(lead, call.args);
  const text = textArg(call.args, 'text');
  const job = jobArg(call.args);
  const newJob = job && job !== agent.work?.job;
  // Its job is what the one-writer rule goes by, so that can't change in the middle of a turn.
  if (newJob && agent.status === 'running') throw new ToolError(`${nameOf(agent)} is still working. Give it a new job once it's finished.`);
  // Earlier messages still carry the old job's instructions, even while their queue is held.
  if (newJob && agent.queue.length > 0) throw new ToolError(`${nameOf(agent)} has messages waiting. Let them finish before changing its job.`);
  // Held messages aren't about to start anything.
  if (!staysHeld(agent)) {
    checkRoom(workspace, agent);
    checkOneWriter(lead, job ?? agent.work?.job, agent);
  }
  const reply = agent.userStopped
    ? `${nameOf(agent)} was stopped by the user, so your message waits until they release it. Tell them if you need it.`
    : staysHeld(agent)
      ? `${nameOf(agent)} is paused, so your message is queued. Use retry_agent when it can continue.`
      : agent.status === 'running'
        ? `Sent to ${nameOf(agent)}, which is working, so it reads this ${READS_WHILE_WORKING[agent.agent] ? 'at its next step' : 'when its turn ends'}. End your turn: Lonca wakes you when it answers.`
        : `Sent to ${nameOf(agent)}. End your turn: Lonca wakes you when it answers.`;
  await deliver(agent, call, text, { lead, id: call.id, reply: { text: reply } }, job);
  return reply;
}

function latestRun(items: ChatItem[]): ChatItem[] {
  const runId = items.findLast((item) => item.runId)?.runId;
  return runId ? items.filter((item) => item.runId === runId) : [];
}

function readAgent(lead: Session, call: ToolCall): string {
  const agent = agentArg(lead, call.args);
  const items = latestRun(transcriptFor(agent.id).items);
  // Whatever stopped an agent can have stopped it before it said anything itself.
  const problems = items.filter((item): item is NoticeItem => item.type === 'notice' && item.level !== 'info').map((item) => item.text).join('\n').slice(-READ_LIMIT);
  const heading = `${nameOf(agent)}: ${stateOf(agent)}.${problems ? `\n\nWhat went wrong in its latest turn:\n${problems}` : ''}`;
  if (agent.unread) {
    agent.unread = false;
    publishSession(agent);
  }
  if (call.args.view === 'activity') {
    const tools = items.filter((item): item is ToolItem => item.type === 'tool')
      .map((tool) => `- ${tool.title}${tool.detail ? ` ${tool.detail.split('\n')[0]}` : ''}${tool.status === 'error' ? ' (failed)' : ''}`);
    return `${heading}\n\n${tools.join('\n').slice(-READ_LIMIT) || 'It hasn\'t used any tools in its latest turn.'}`;
  }
  const report = items.filter((item): item is TextItem => item.type === 'text' && !item.parentId).map((item) => item.text).join('\n\n');
  if (report.length > READ_LIMIT) return `${heading}\n\n${report.slice(-READ_LIMIT)}\n\n(Only the end of a longer report is shown.)`;
  return `${heading}\n\n${report || (agent.status === 'running' ? 'It hasn\'t written anything yet.' : 'It didn\'t write anything.')}`;
}

function teamStatus(lead: Session, workspace: Workspace): string {
  const agents = agentsOf(workspace.id).map((agent) => `- ${nameOf(agent)}, ${agent.effort}, job ${agent.work?.job}: ${stateOf(agent)}${agent.work?.activity ? `. Latest: ${agent.work.activity}` : ''}`);
  return [
    agents.length ? `Agents:\n${agents.join('\n')}` : 'You haven\'t started any agents.',
    `Models you can start agents on (model id, provider, thinking levels):\n${usableModels(lead, workspace)}`,
    signInList(lead),
    `At most ${state.settings.leadMaxAgents} agents can work at once.`,
  ].join('\n\n');
}

async function stopAgent(lead: Session, call: ToolCall): Promise<string> {
  const agent = agentArg(lead, call.args);
  const text = `Stopping ${nameOf(agent)}. Its conversation is kept.`;
  await interruptSession(agent.id, { holdQueue: true, receipt: { lead, id: call.id, reply: { text } } });
  return text;
}

const TRYING_AGAIN = 'Trying again';

/** What the turn being retried was asked, including what it was sent while it worked. */
function continuation(session: Session): string {
  const sent = transcriptFor(session.id).items.filter((item): item is UserItem => item.type === 'user' && !item.queued && item.summary !== TRYING_AGAIN);
  const start = sent.findLastIndex((item) => !item.midTurn);
  const later = sent.slice(start + 1).map((item) => item.text);
  return `Continue where you left off. If you hadn't started, this was the request:\n\n${sent[start]?.text ?? ''}${later.length ? `\n\nAnd this was sent to you while you worked on it:\n\n${later.join('\n\n')}` : ''}`;
}

/** Works for a usage limit or a failure, which a conversation survives. `patch` is saved with what carries it on. */
async function retrySession(session: Session, from: UserItem['from'], id?: string, receipt?: ToolReceipt, patch?: Partial<Session>): Promise<void> {
  if (session.status === 'running') throw new HttpError(409, `${nameOf(session)} is already working.`);
  if (session.queue.length > 0) return flushQueue(session.id, receipt, patch);
  await sendMessage(session.id, continuation(session), [], { id, from, summary: TRYING_AGAIN, receipt, patch });
}

async function retryAgent(lead: Session, workspace: Workspace, call: ToolCall): Promise<string> {
  const agent = agentArg(lead, call.args);
  if (agent.userStopped) return `${nameOf(agent)} was stopped by the user. Ask them before it continues.`;
  const profileId = signInArg(lead, workspace, agent.agent, call.args, profileIdOf(agent));
  checkRoom(workspace, agent);
  checkOneWriter(lead, agent.work?.job, agent);
  if (profileId !== profileIdOf(agent)) {
    if (agent.status === 'running') throw new ToolError(`${nameOf(agent)} is still working. Move it to another sign-in once it's finished.`);
    recordMove(agent, getProfile(profileId)!, 'lead');
  }
  const text = `Asked ${nameOf(agent)} to try again. End your turn: Lonca wakes you when it finishes.`;
  await retrySession(agent, 'lead', call.id, { lead, id: call.id, reply: { text } });
  return text;
}

export async function handleToolCall(lead: Session, call: ToolCall): Promise<{ text: string; failed?: boolean }> {
  const accepted = lead.toolReplies?.[call.id];
  if (accepted) return accepted;
  const workspace = getWorkspace(lead.workspaceId);
  if (!workspace) return { text: 'This workspace no longer exists.', failed: true };
  const reply = await dispatchToolCall(lead, workspace, call);
  if (!['spawn_agent', 'message_agent', 'stop_agent', 'retry_agent'].includes(call.tool)) return reply;
  // Mutations save their reply with acceptance. Save refusals and legacy deduplication too:
  // replay must not turn "ask the user" or "wait for room" into new work after state changes.
  const recorded = lead.toolReplies?.[call.id];
  if (recorded) return recorded;
  persistSession(lead, {}, { lead, id: call.id, reply });
  return reply;
}

async function dispatchToolCall(lead: Session, workspace: Workspace, call: ToolCall): Promise<{ text: string; failed?: boolean }> {
  try {
    switch (call.tool) {
      case 'spawn_agent': return { text: await spawnAgent(lead, workspace, call) };
      case 'message_agent': return { text: await messageAgent(lead, workspace, call) };
      case 'read_agent': return { text: readAgent(lead, call) };
      case 'team_status': return { text: teamStatus(lead, workspace) };
      case 'stop_agent': return { text: await stopAgent(lead, call) };
      case 'retry_agent': return { text: await retryAgent(lead, workspace, call) };
      default: return { text: `There's no tool called ${call.tool}.`, failed: true };
    }
  } catch (error) {
    if (error instanceof ToolError || error instanceof HttpError) return { text: error.message, failed: true };
    throw error;
  }
}

function describeTurn(agent: Session): string {
  const parts: string[] = [];
  if (agent.lastOutcome === 'limit') {
    const when = agent.limitResetsAt ? ` It ends at ${new Date(agent.limitResetsAt).toISOString()}.` : '';
    const elsewhere = hasSeveral(state.profiles, agent.agent) ? ', or with sign_in to carry on its conversation on another sign-in you may use (team_status lists them)' : '';
    parts.push(`${nameOf(agent)} hit the usage limit of ${limitName(agent)}.${when} Its work so far is kept: use retry_agent when it can run${elsewhere}, or start another agent on a different provider.`);
  } else if (agent.lastOutcome === 'failed') {
    parts.push(`${nameOf(agent)} failed. Look at it with read_agent, then use retry_agent or try another way.`);
  } else {
    parts.push(`${nameOf(agent)} finished. Read its report with read_agent.`);
  }
  if (agent.work?.filesChanged) parts.push('The workspace\'s files changed during its turn, and it was told not to change any, so it or another agent did.');
  if (agent.work?.userNote) parts.push(`The user wrote to it directly: ${JSON.stringify(agent.work.userNote)}`);
  return `- ${parts.join(' ')}`;
}

function wakeSummary(agents: Session[]): string {
  const limited = agents.find((agent) => agent.lastOutcome === 'limit');
  if (limited) return `${limited.title} hit the usage limit of ${limitName(limited)}`;
  const failed = agents.find((agent) => agent.lastOutcome === 'failed');
  if (failed) return `${failed.title} failed`;
  return agents.length === 1 ? `${agents[0].title} finished` : `${agents.length} agents finished`;
}

function clearReported(agents: Session[]): void {
  for (const agent of agents) {
    if (agent.work) persistSession(agent, { work: { ...agent.work, unreported: false, userNote: undefined } });
  }
}

/**
 * Starts a Lead's next turn when the agents it was waiting for have settled, or at once if one of
 * them is stuck. It checks for what still needs reporting each time, so nothing depends on seeing
 * the moment a turn ended, which a restart could miss.
 */
function wakeLead(workspaceId: string): void {
  const lead = leadOf(workspaceId);
  if (!lead?.hasMessages) return;
  const agents = agentsOf(workspaceId);
  const unreported = agents.filter((agent) => agent.work?.unreported);
  if (unreported.length === 0) return;
  const urgent = unreported.some((agent) => agent.lastOutcome === 'limit' || agent.lastOutcome === 'failed');
  if (!urgent && agents.some(isWorking)) return;

  const stillWorking = agents.filter(isWorking);
  const text = [
    'Update from Lonca. This isn\'t from the user.',
    ...unreported.map(describeTurn),
    stillWorking.length ? `Still working: ${stillWorking.map(nameOf).join(', ')}.` : 'None of your agents are working.',
  ].join('\n');
  const transcript = transcriptFor(lead.id);
  const waiting = lead.queue.map((id) => transcript.find(id)).find((item): item is UserItem => item?.type === 'user' && item.from === 'lonca');
  if (waiting) {
    // One wake at a time: the Lead reads it all at once when it next gets a turn.
    const merged = `${waiting.text}\n${text}`;
    transcript.upsert({ ...waiting, text: merged, summary: `${merged.match(/^- /gm)?.length ?? 2} updates from agents` });
    persistSession(lead, {});
  } else {
    const item: UserItem = { id: crypto.randomUUID(), ts: Date.now(), type: 'user', text, attachments: [], queued: true, from: 'lonca', summary: wakeSummary(unreported) };
    transcript.upsert(item);
    // Not through sendMessage: this mustn't release messages the user held, or start a stopped workspace.
    persistSession(lead, { queue: [...lead.queue, item.id] });
    startNextQueued(lead);
  }
  clearReported(unreported);
}

function needsYou(lead: Session, text: string): void {
  lead.unread = true;
  publishSession(lead);
  const workspace = getWorkspace(lead.workspaceId);
  if (workspace) notifyUser(`The Lead in ${workspace.name} ${text}`);
}

function settled(workspaceId: string, session?: Session): void {
  try {
    wakeLead(workspaceId);
  } catch (error) {
    // What needs reporting is still marked, so the next check picks it up.
    console.error('could not wake a Lead:', error instanceof Error ? error.message : error);
  }
  if (session?.role !== 'lead' || session.closedAt || session.status === 'running') return;
  if (session.lastOutcome === 'limit') needsYou(session, 'reached a usage limit.');
  else if (session.lastOutcome === 'failed') needsYou(session, 'stopped with an error.');
  // It's waiting for its agents, or has more to do, so this isn't the end of its work.
  else if (session.lastOutcome === 'completed' && session.queue.length === 0 && !agentsOf(workspaceId).some(isWorking)) needsYou(session, 'finished.');
}

function handover(workspace: Workspace): string | undefined {
  const agents = agentsOf(workspace.id);
  const earlier = state.sessions.filter((session) => session.workspaceId === workspace.id && session.role === 'lead' && session.closedAt)
    .sort((a, b) => b.closedAt! - a.closedAt!)[0];
  if (agents.length === 0 && !earlier) return undefined;
  const items = earlier ? transcriptFor(earlier.id).items : [];
  const lastWords = items.findLast((item): item is TextItem => item.type === 'text')?.text.slice(-2000);
  const asked = items.filter((item): item is UserItem => item.type === 'user' && !item.from).slice(-3).map((item) => item.text.slice(-2000));
  const note = [
    'You\'re taking over as Lead of this workspace from an earlier Lead, whose conversation you don\'t have.',
    ...(asked.length ? [`The user's latest messages to it, which it may not have finished with:\n\n${asked.join('\n\n---\n\n')}`] : []),
    ...(agents.length ? [`Its agents are yours now:\n${agents.map((agent) => `- ${nameOf(agent)}, job ${agent.work?.job}: ${stateOf(agent)}`).join('\n')}`] : []),
    ...(lastWords ? [`Its last message was:\n\n${lastWords}`] : []),
  ].join('\n\n');
  clearReported(agents.filter((agent) => agent.work?.unreported));
  return note;
}

/**
 * Says in the conversation that it moved to another sign-in, and why, and makes the move. A move
 * while a turn runs takes effect from its next one. A Lead's choice goes with the workspace.
 */
function recordMove(session: Session, to: Profile, by: 'user' | 'lead' | 'lonca'): void {
  const from = profileIdOf(session);
  const fromName = signInName(from, session.agent);
  const toName = profileName(to, state.catalog);
  const atLimit = session.lastOutcome === 'limit' && (session.limitProfileId ?? from) === from;
  const because = atLimit ? ` because ${fromName} reached its usage limit` : '';
  const text = by === 'lonca'
    ? `Lonca moved this to ${toName}${because}. You chose this in Settings.`
    : `${by === 'lead' ? 'The Lead moved this' : 'Moved'} from ${fromName} to ${toName}${because}.${session.status === 'running' ? ' The turn under way finishes on the one it started on.' : ''}`;
  if (session.hasMessages) notice(session.id, undefined, 'info', text);
  persistSession(session, { profileId: to.id });
  const workspace = getWorkspace(session.workspaceId);
  if (session.role === 'lead' && workspace) {
    workspace.lead = { agent: session.agent, model: session.model, effort: session.effort, profileId: to.id };
    publishWorkspace(workspace);
  }
}

/**
 * Moves a conversation to another of its provider's sign-ins, keeping the conversation, whatever
 * its model is locked to. With `retry`, a conversation that stopped carries on there at once.
 */
export async function moveToProfile(session: Session, profileId: string, { retry = false }: { retry?: boolean } = {}): Promise<Session> {
  if (session.closedAt) throw new HttpError(409, 'This Lead was closed. Its conversation can still be read.');
  const to = getProfile(profileId);
  if (!to) throw new HttpError(404, 'That sign-in was removed.');
  if (to.agent !== session.agent) throw new HttpError(409, `This conversation is with ${state.catalog[session.agent].label}, which can’t read another provider’s. Open a new tab for ${state.catalog[to.agent].label}.`);
  const workspace = getWorkspace(session.workspaceId);
  if (!isReady(profileStatus(system, to.id)) && !projectBringsKey(to.agent, workspace && getProject(workspace.projectId))) {
    throw new HttpError(409, `${profileName(to, state.catalog)} isn’t signed in.`);
  }
  const carryOn = retry && session.status !== 'running' && (session.lastOutcome === 'limit' || session.lastOutcome === 'failed' || session.queue.length > 0);
  // Said before anything changes, so a refusal doesn't leave it moved but stopped.
  if (carryOn) checkButtonCanStart(session);
  if (to.id !== profileIdOf(session)) recordMove(session, to, 'user');
  if (carryOn) await tryAgain(session);
  return session;
}

/**
 * A turn reached a usage limit, so the conversation goes on, on a sign-in the user chose for that,
 * if there's one that can. Not once someone pressed Stop, which a limit just before it can't overrule.
 */
export async function limitReached(session: Session, from: string, stopped = false): Promise<void> {
  if (stopped || session.closedAt || session.userStopped || session.lastOutcome !== 'limit' || profileIdOf(session) !== from) return;
  const workspace = getWorkspace(session.workspaceId);
  if (!workspace || ['archived', 'archiving', 'error', 'deleting', 'stopping'].includes(workspace.status)) return;
  if (projectBringsKey(session.agent, getProject(workspace.projectId))) return;
  const to = autoSwitchTarget(state.profiles, system, session.agent, from);
  if (!to) return;
  recordMove(session, to, 'lonca');
  // The limit doesn't apply where it's going, and a Lead mustn't hear of one that it carried on
  // from. That's saved with what carries it on, so a failure or a crash before then leaves it at
  // its limit, saying so, and carrying on where it moved once it's tried again.
  await retrySession(session, 'lonca', undefined, undefined, {
    lastOutcome: undefined, limitResetsAt: undefined, limitProfileId: undefined,
    ...(session.work ? { work: { ...session.work, unreported: false } } : {}),
    // Nobody asked for this, so a Lead's turns without the user go on counting towards its pause.
    ...(session.role === 'lead' ? { autonomousTurns: session.autonomousTurns } : {}),
  });
}

setTeamHooks({
  toolCall: handleToolCall,
  settled,
  handover,
  paused(lead, why) {
    notice(lead.id, undefined, 'warning', why);
    needsYou(lead, 'paused and needs you to let it continue.');
  },
  limitReached,
});

/**
 * Stopped by the user means stopped until the user says otherwise, whatever a Lead, a wake or a move
 * to another sign-in wants. That includes what's queued but hasn't started, such as a continuation
 * waiting for its workspace when Stop arrives.
 */
export function holdWhenStopped(session: Session): void {
  if (session.userStopped) return;
  session.held = true;
  session.userStopped = true;
  publishSession(session);
}

export async function stopAgents(workspaceId: string): Promise<void> {
  await Promise.all(agentsOf(workspaceId).filter(isWorking).map(async (agent) => {
    holdWhenStopped(agent);
    await interruptSession(agent.id);
  }));
}

export async function closeWorkspaceLead(lead: Session, stopTeam: boolean): Promise<void> {
  // In this order, so that anything the Lead starts while it's stopping gets stopped too.
  await closeLead(lead);
  if (stopTeam) await stopAgents(lead.workspaceId);
}

/** The one way a locked model can change: when it can't run at all. It leaves a record. */
export async function switchLead(workspace: Workspace, choice: LeadChoice): Promise<Session> {
  const lead = leadOf(workspace.id);
  if (!lead) throw new HttpError(409, 'This workspace has no Lead to switch.');
  if (!workspace.leadLockedAt) throw new HttpError(409, 'The Lead’s model can still be changed from its tab.');
  const blocker = leadBlocker(lead, state.catalog, system, getProject(workspace.projectId));
  if (!blocker) throw new HttpError(409, 'The Lead stays on its model while it can still run on it.');
  const model = state.catalog[choice.agent].models.find((entry) => entry.id === choice.model);
  if (!model?.efforts.includes(choice.effort)) throw new HttpError(400, 'That model isn’t available at that thinking level.');
  const previous = modelName(lead);
  const reason = { retired: 'is no longer available', 'signed-out': 'isn’t signed in', limit: 'reached its usage limit' }[blocker];
  const record = `The Lead moved from ${previous} to ${model.label} because ${previous} ${reason}.`;
  // A sign-in of another provider's, or one that's gone, means that provider's own choice.
  const sameProvider = choice.agent === lead.agent;
  const wanted = getProfile(choice.profileId ?? '');
  const profileId = wanted?.agent === choice.agent ? wanted.id : sameProvider ? profileIdOf(lead) : leadDefaultFor(lead, choice.agent, state.profiles);
  workspace.lead = { agent: choice.agent, model: choice.model, effort: choice.effort, profileId };
  if (sameProvider) {
    // The same CLI can carry on the conversation.
    Object.assign(lead, { model: choice.model, effort: choice.effort });
    notice(lead.id, undefined, 'info', record);
    persistSession(lead, {});
    if (profileId && profileId !== profileIdOf(lead)) recordMove(lead, getProfile(profileId)!, 'user');
    publishWorkspace(workspace);
    await retrySession(lead, 'lonca');
    return lead;
  }
  // Another CLI can't read this one's conversation, so this needs a new Lead, told what it can be.
  notice(lead.id, undefined, 'info', record);
  await closeLead(lead);
  const next = createLead(workspace);
  await sendMessage(next.id, `Update from Lonca. This isn't from the user. ${record} Carry on with the work.`, [], { from: 'lonca', summary: record });
  return next;
}

export function markRead(session: Session): void {
  if (!session.unread) return;
  session.unread = false;
  publishSession(session);
}

/** Starts a stopped workspace if it needs it, for retries the user asks for. */
export async function tryAgain(session: Session): Promise<void> {
  const workspace = getWorkspace(session.workspaceId);
  if (workspace?.status === 'stopped') await startWorkspace(workspace);
  // After waiting for that, with nothing to wait for before the turn is reserved, so that two clicks can't both pass.
  checkButtonCanStart(session);
  await retrySession(session, 'lonca');
}
