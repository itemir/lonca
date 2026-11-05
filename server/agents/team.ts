import crypto from 'node:crypto';
import type { AgentId, AgentJob, ChatItem, LeadChoice, Session, TextItem, ToolItem, UserItem, Workspace } from '../../shared/types.ts';
import { canRun, isWorking, leadBlocker } from '../../shared/lead.ts';
import { notifyUser } from '../notify.ts';
import { getProject, getSession, getWorkspace, state } from '../store.ts';
import { system } from '../system.ts';
import { transcriptFor } from '../transcript.ts';
import { HttpError } from '../util.ts';
import { publishWorkspace, startWorkspace } from '../workspaces.ts';
import type { ToolCall } from './process.ts';
import { newJobNote } from './prompt.ts';
import {
  agentsOf, closeLead, createLead, createSession, flushQueue, interruptSession, leadOf, notice, persistSession, publishSession, sendMessage, setTeamHooks, startNextQueued,
} from './runner.ts';

const READ_LIMIT = 30000;
const LABEL_LENGTH = 40;
const JOBS: AgentJob[] = ['analyze', 'implement', 'review'];

/** Fails a tool call with something the Lead can act on. */
class ToolError extends Error {}

function modelName(session: Session): string {
  return state.catalog[session.agent].models.find((model) => model.id === session.model)?.label ?? session.model;
}

function nameOf(session: Session): string {
  return `"${session.title}" (${modelName(session)}, id ${session.id})`;
}

function stateOf(session: Session): string {
  if (session.status === 'running') return 'working';
  if (session.held && session.lastOutcome !== 'limit') return 'stopped by the user';
  if (session.queue.length > 0) return 'queued';
  switch (session.lastOutcome) {
    case 'limit': return 'paused at a usage limit';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    case 'completed': return 'finished';
    default: return 'idle';
  }
}

function signedIn(agent: AgentId, workspace: Workspace): boolean {
  return canRun(agent, system, getProject(workspace.projectId));
}

function usableModels(workspace: Workspace): string {
  return (Object.keys(state.catalog) as AgentId[])
    .filter((agent) => signedIn(agent, workspace))
    .flatMap((agent) => state.catalog[agent].models.map((model) => `${model.id} (${state.catalog[agent].label}; ${model.efforts.join(', ')}; default ${model.defaultEffort})`))
    .join('\n');
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

/** The limit on how many work at once, for an agent that's about to start a turn. */
function checkRoom(workspace: Workspace, agent?: Session): void {
  const working = agentsOf(workspace.id).filter(isWorking);
  if (agent && working.includes(agent)) return;
  if (working.length >= state.settings.leadMaxAgents) {
    throw new ToolError(`${working.length} agents are already working, which is the most allowed at once. End your turn: Lonca wakes you when they finish.`);
  }
}

/** One agent at a time changes files, so that two don't overwrite each other's work. */
function checkOneWriter(lead: Session, job: AgentJob | undefined, except?: Session): void {
  if (job !== 'implement') return;
  const writer = agentsOf(lead.workspaceId).find((agent) => agent !== except && agent.work?.job === 'implement' && isWorking(agent));
  if (writer) throw new ToolError(`${nameOf(writer)} is already changing files, and only one agent can at a time. Wait for it to finish, or give this one a different job.`);
}

function findModel(workspace: Workspace, id: string): { agent: AgentId; efforts: string[]; defaultEffort: string } {
  for (const agent of Object.keys(state.catalog) as AgentId[]) {
    const model = state.catalog[agent].models.find((entry) => entry.id === id);
    if (!model) continue;
    if (!signedIn(agent, workspace)) throw new ToolError(`${state.catalog[agent].label} isn't signed in, so ${id} can't run. You can use:\n${usableModels(workspace)}`);
    return { agent, efforts: model.efforts, defaultEffort: model.defaultEffort };
  }
  throw new ToolError(`There's no model called ${id}. You can use:\n${usableModels(workspace)}`);
}

// A call is handled again if the server stops before its reply is written, so what it
// creates is named after it, and a repeat finds what's already there.
function deliver(session: Session, call: ToolCall, text: string): Promise<unknown> {
  if (transcriptFor(session.id).find(call.id)) return Promise.resolve();
  return sendMessage(session.id, text, [], { id: call.id, from: 'lead', keepHeld: true });
}

async function spawnAgent(lead: Session, workspace: Workspace, call: ToolCall): Promise<string> {
  const id = crypto.createHash('sha256').update(call.id).digest('hex').slice(0, 12);
  let agent = getSession(id);
  if (!agent) {
    const label = textArg(call.args, 'label').trim().replace(/\s+/g, ' ').slice(0, LABEL_LENGTH);
    const task = textArg(call.args, 'task');
    const job = jobArg(call.args) ?? 'analyze';
    const model = findModel(workspace, textArg(call.args, 'model'));
    const effort = typeof call.args.effort === 'string' ? call.args.effort : model.defaultEffort;
    if (!model.efforts.includes(effort)) throw new ToolError(`${call.args.model} doesn't offer the thinking level ${effort}. It offers: ${model.efforts.join(', ')}.`);
    checkRoom(workspace);
    checkOneWriter(lead, job);
    agent = createSession(workspace, { id, role: 'agent', title: label, agent: model.agent, model: call.args.model as string, effort, work: { job } });
    await deliver(agent, call, task);
  } else {
    await deliver(agent, call, textArg(call.args, 'task'));
  }
  return `Started ${nameOf(agent)}. End your turn: Lonca wakes you when it finishes.`;
}

async function messageAgent(lead: Session, workspace: Workspace, call: ToolCall): Promise<string> {
  const agent = agentArg(lead, call.args);
  const text = textArg(call.args, 'text');
  const job = jobArg(call.args);
  const newJob = job && job !== agent.work?.job;
  // Its job is what the one-writer rule goes by, so that can't change in the middle of a turn.
  if (newJob && agent.status === 'running') throw new ToolError(`${nameOf(agent)} is still working. Give it a new job once it's finished.`);
  // One the user stopped isn't about to start anything.
  if (!agent.held) {
    checkRoom(workspace, agent);
    checkOneWriter(lead, job ?? agent.work?.job, agent);
  }
  if (newJob && agent.work) persistSession(agent, { work: { ...agent.work, job } });
  await deliver(agent, call, newJob ? `${newJobNote(job)}\n\n${text}` : text);
  if (agent.held) return `${nameOf(agent)} was stopped by the user, so your message waits until they release it. Tell them if you need it.`;
  return `Sent to ${nameOf(agent)}. End your turn: Lonca wakes you when it answers.`;
}

function latestRun(items: ChatItem[]): ChatItem[] {
  const runId = items.findLast((item) => item.runId)?.runId;
  return runId ? items.filter((item) => item.runId === runId) : [];
}

function readAgent(lead: Session, call: ToolCall): string {
  const agent = agentArg(lead, call.args);
  const items = latestRun(transcriptFor(agent.id).items);
  const heading = `${nameOf(agent)}: ${stateOf(agent)}.${agent.work?.filesChanged ? ' The workspace\'s files changed during its latest turn, which it was told not to do.' : ''}`;
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
  return `${heading}\n\n${report || 'It hasn\'t written anything yet.'}`;
}

function teamStatus(lead: Session, workspace: Workspace): string {
  const agents = agentsOf(workspace.id).map((agent) => `- ${nameOf(agent)}, ${agent.effort}, job ${agent.work?.job}: ${stateOf(agent)}${agent.work?.activity ? `. Latest: ${agent.work.activity}` : ''}`);
  return [
    agents.length ? `Agents:\n${agents.join('\n')}` : 'You haven\'t started any agents.',
    `Models you can start agents on (model id, provider, thinking levels):\n${usableModels(workspace)}`,
    `At most ${state.settings.leadMaxAgents} agents can work at once.`,
  ].join('\n\n');
}

async function stopAgent(lead: Session, call: ToolCall): Promise<string> {
  const agent = agentArg(lead, call.args);
  await interruptSession(agent.id, { holdQueue: true });
  return `Stopping ${nameOf(agent)}. Its conversation is kept.`;
}

const TRYING_AGAIN = 'Trying again';

function continuation(session: Session): string {
  const last = transcriptFor(session.id).items.findLast((item): item is UserItem => item.type === 'user' && !item.queued && item.summary !== TRYING_AGAIN);
  return `Continue where you left off. If you hadn't started, this was the request:\n\n${last?.text ?? ''}`;
}

/** Works for a usage limit or a failure, which a conversation survives. */
async function retrySession(session: Session, from: UserItem['from'], id?: string): Promise<void> {
  if (session.status === 'running') throw new HttpError(409, `${nameOf(session)} is already working.`);
  if (session.queue.length > 0) return flushQueue(session.id);
  await sendMessage(session.id, continuation(session), [], { id, from, summary: TRYING_AGAIN });
}

async function retryAgent(lead: Session, workspace: Workspace, call: ToolCall): Promise<string> {
  const agent = agentArg(lead, call.args);
  if (agent.held && agent.lastOutcome !== 'limit') return `${nameOf(agent)} was stopped by the user. Ask them before it continues.`;
  if (transcriptFor(agent.id).find(call.id)) return `Asked ${nameOf(agent)} to try again.`;
  checkRoom(workspace, agent);
  checkOneWriter(lead, agent.work?.job, agent);
  await retrySession(agent, 'lead', call.id);
  return `Asked ${nameOf(agent)} to try again. End your turn: Lonca wakes you when it finishes.`;
}

async function handleToolCall(lead: Session, call: ToolCall): Promise<{ text: string; failed?: boolean }> {
  const workspace = getWorkspace(lead.workspaceId);
  if (!workspace) return { text: 'This workspace no longer exists.', failed: true };
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
    parts.push(`${nameOf(agent)} hit ${state.catalog[agent.agent].label}'s usage limit.${when} Its work so far is kept: use retry_agent when it can run, or start another agent on a different provider.`);
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
  if (limited) return `${limited.title} hit ${state.catalog[limited.agent].label}’s usage limit`;
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

setTeamHooks({
  toolCall: handleToolCall,
  settled,
  handover,
  paused(lead, why) {
    notice(lead.id, undefined, 'warning', why);
    needsYou(lead, 'paused and needs you to let it continue.');
  },
});

/** Stopped by the user means stopped until the user says otherwise, whatever a Lead or a wake wants. */
export function holdWhenStopped(session: Session): void {
  if (!session.role || session.held) return;
  session.held = true;
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
  workspace.lead = choice;
  if (choice.agent === lead.agent) {
    // The same CLI can carry on the conversation.
    Object.assign(lead, { model: choice.model, effort: choice.effort });
    notice(lead.id, undefined, 'info', record);
    persistSession(lead, {});
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
  await retrySession(session, 'lonca');
}
