import { useCallback, useEffect, useRef, useState } from 'react';
import { Crown, FileText, Hourglass, Lock, MessageCircle, Pause, Plus, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { MAX_AUTONOMOUS_TURNS, isWorking, leadBlocker } from '../../../shared/lead.ts';
import type { Session, Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { basename, effortLabel } from '../format.ts';
import { useOutsideClick } from '../hooks.ts';
import { attempt, useStore, type WorkspaceTab } from '../store.ts';
import { Elapsed } from './Chat.tsx';
import { type ModelChoice, ModelPicker, modelLabel } from './ModelPicker.tsx';
import { IconButton, Modal, Spinner } from './ui.tsx';

export type SessionState = 'working' | 'limit' | 'failed' | 'unread' | 'stopped' | null;

/** One answer to "what's this doing?", wherever a session is shown. */
export function sessionState(session: Session): SessionState {
  if (session.status === 'running') return 'working';
  if (session.lastOutcome === 'limit') return 'limit';
  if (session.lastOutcome === 'failed') return 'failed';
  if (session.unread) return 'unread';
  return session.role === 'agent' && (session.lastOutcome === 'stopped' || session.held) ? 'stopped' : null;
}

const STATE_NAMES: Record<NonNullable<SessionState>, string> = {
  working: 'Working', limit: 'Paused at a usage limit', failed: 'Failed', unread: 'Has something new', stopped: 'Stopped',
};

export function StatusGlyph({ state, size = 13 }: { state: SessionState; size?: number }) {
  if (!state) return null;
  if (state === 'working') return <Spinner size={size - 2} />;
  if (state === 'unread') return <span className="unread-dot" role="img" aria-label={STATE_NAMES[state]} />;
  const Icon = { limit: Hourglass, failed: TriangleAlert, stopped: Pause }[state];
  return <Icon size={size} className={`tab-state-${state}`} role="img" aria-label={STATE_NAMES[state]} />;
}

function agentsIn(sessions: Session[], workspaceId: string): Session[] {
  return sessions.filter((session) => session.workspaceId === workspaceId && session.role === 'agent');
}

/** The model of a Lead or agent, which can't be changed from here, and why not. */
export function LockedModel({ session }: { session: Session }) {
  const catalog = useStore((store) => store.catalog);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick(ref, close, open);
  const name = modelLabel(catalog, session.agent, session.model);
  const effort = effortLabel(session.effort);
  return (
    <div className="model-picker" ref={ref}>
      <button type="button" className="model-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{name}</span>
        <span className="model-effort">{effort}</span>
        <Lock size={12} />
      </button>
      {open && (
        <div className="popover lock-popover popover-up" role="status">
          {session.role === 'lead'
            ? <><strong>The Lead stays on {name} {effort} for this workspace.</strong> For another model, start a new workspace.</>
            : <><strong>The Lead chose {name} {effort} for this agent.</strong> Ask the Lead if you want it on something else.</>}
        </div>
      )}
    </div>
  );
}

/** What the Lead's waiting for, at the end of its conversation. */
export function TeamActivity({ lead, onOpen }: { lead: Session; onOpen: (id: string) => void }) {
  const allSessions = useStore((store) => store.sessions);
  const catalog = useStore((store) => store.catalog);
  const agents = agentsIn(allSessions, lead.workspaceId);
  const working = agents.filter(isWorking);
  const paused = agents.filter((agent) => agent.lastOutcome === 'limit');
  if (working.length === 0 && paused.length === 0) return null;
  const providers = [...new Set(working.map((agent) => catalog[agent.agent].label))].join(' and ');
  return (
    <>
      <div className="team-card">
        {[...working, ...paused].map((agent) => (
          <div className="team-row-wrap" key={agent.id}>
            <button type="button" className="team-row" onClick={() => onOpen(agent.id)}>
              <span className="team-row-icon"><StatusGlyph state={agent.lastOutcome === 'limit' ? 'limit' : 'working'} size={14} /></span>
              <span className="team-row-main">
                <span className="team-row-title">{agent.title} <span className="tab-model">{modelLabel(catalog, agent.agent, agent.model)}, {effortLabel(agent.effort)}</span></span>
                <span className="team-row-detail">{agent.lastOutcome === 'limit' ? 'Paused at a usage limit. Its work so far is kept.' : agent.work?.activity ?? 'Starting'}</span>
              </span>
              {agent.status === 'running' && agent.work?.turnStartedAt && <span className="team-row-time"><Elapsed since={agent.work.turnStartedAt} /></span>}
            </button>
            {agent.lastOutcome === 'limit' && <button type="button" className="button button-small" onClick={() => void attempt(() => api.retrySession(agent.id))}>Try now</button>}
          </div>
        ))}
        {working.length > 0 && <div className="team-note">These use your {providers} {working.length === 1 && !providers.includes(' and ') ? 'limit' : 'limits'} alongside the Lead.</div>}
      </div>
      {working.length > 0 && (
        <div className="waiting-row">
          {lead.status !== 'running' && !lead.held && <>Waiting for {working.length === 1 ? '1 agent' : `${working.length} agents`}. The Lead continues when {working.length === 1 ? 'it finishes' : 'they finish'}.</>}
          {lead.status !== 'running' && lead.held && <>The Lead is stopped, so it won’t read what {working.length === 1 ? 'this agent reports' : 'they report'} until you write to it.</>}
          <button type="button" className="link-button" onClick={() => void attempt(() => api.stopAgents(lead.workspaceId))}>Stop the agents</button>
        </div>
      )}
    </>
  );
}

function ChooseModelDialog({ lead, onClose }: { lead: Session; onClose: () => void }) {
  const catalog = useStore((store) => store.catalog);
  const [choice, setChoice] = useState<ModelChoice>({ agent: lead.agent, model: lead.model, effort: lead.effort });
  const changesAgent = choice.agent !== lead.agent;
  const unchanged = choice.model === lead.model && choice.agent === lead.agent;
  return (
    <Modal title="Move the Lead to another model" onClose={onClose}>
      <div className="confirm-body">
        <p>This is recorded in the conversation. It’s only possible because the Lead can’t run on its current model.</p>
        <div className="switch-picker"><ModelPicker catalog={catalog} value={choice} up={false} onChange={setChoice} /></div>
        {changesAgent && <p className="field-help">{catalog[lead.agent].label} and {catalog[choice.agent].label} can’t read each other’s conversations, so a new Lead takes over and is told what this one did.</p>}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="button button-primary"
          disabled={unchanged}
          onClick={() => {
            onClose();
            // Moving to another provider starts a new Lead, which should be what's on screen.
            void attempt(() => api.switchLead(lead.workspaceId, choice)).then((next) => {
              if (next) useStore.getState().openTab(lead.workspaceId, { kind: 'session', id: next.id });
            });
          }}
        >
          Move the Lead
        </button>
      </div>
    </Modal>
  );
}

function resetTime(session: Session): string {
  return session.limitResetsAt ? ` It resets at ${new Date(session.limitResetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
}

/** What's stopping this session from running, and the way out. */
export function SessionBanner({ session }: { session: Session }) {
  const catalog = useStore((store) => store.catalog);
  const system = useStore((store) => store.system);
  const [switching, setSwitching] = useState(false);
  const workspace = useStore((store) => store.workspaces.find((entry) => entry.id === session.workspaceId));
  const project = useStore((store) => store.projects.find((entry) => entry.id === workspace?.projectId));
  // Only an unlocked workspace lets a new Lead's model be changed in its tab.
  if (session.closedAt || (session.role === 'lead' && !session.hasMessages && !workspace?.leadLockedAt)) return null;
  const provider = catalog[session.agent].label;
  const name = modelLabel(catalog, session.agent, session.model);
  const blocker = session.role === 'lead' ? leadBlocker(session, catalog, system, project) : session.lastOutcome === 'limit' ? 'limit' : null;
  if (session.role === 'lead' && session.held && (session.autonomousTurns ?? 0) >= MAX_AUTONOMOUS_TURNS && session.queue.length > 0) {
    return (
      <div className="workspace-banner">
        <Hourglass size={15} />
        <span>The Lead paused after {MAX_AUTONOMOUS_TURNS} turns without a word from you.</span>
        <button type="button" className="button button-small" onClick={() => void attempt(() => api.stopAgents(session.workspaceId))}>Stop the agents</button>
        <button type="button" className="button button-small" onClick={() => void attempt(() => api.flushQueue(session.id))}>Let it continue</button>
      </div>
    );
  }
  if (!blocker) return null;
  const who = session.role === 'lead' ? 'the Lead' : 'this agent';
  const text = {
    limit: `${provider}’s usage limit was reached, so ${who} is paused.${resetTime(session)}`,
    retired: `${name} is no longer available, so the Lead can’t run.`,
    'signed-out': `${provider} isn’t signed in, so the Lead can’t run.`,
  }[blocker];
  return (
    <div className="workspace-banner">
      <Hourglass size={15} />
      <span>{text}</span>
      {session.role === 'lead' && <button type="button" className="button button-small" onClick={() => setSwitching(true)}>Use another model</button>}
      {blocker === 'limit' && <button type="button" className="button button-small" onClick={() => void attempt(() => api.retrySession(session.id))}><RotateCcw size={13} /> Try now</button>}
      {switching && <ChooseModelDialog lead={session} onClose={() => setSwitching(false)} />}
    </div>
  );
}

export function CloseLeadDialog({ lead, onClose, onClosed }: { lead: Session; onClose: () => void; onClosed: () => void }) {
  const working = useStore((store) => agentsIn(store.sessions, lead.workspaceId).filter(isWorking).length);
  const catalog = useStore((store) => store.catalog);
  const model = `${modelLabel(catalog, lead.agent, lead.model)} ${effortLabel(lead.effort)}`;
  const close = (stopAgents: boolean) => {
    onClose();
    void attempt(() => api.closeLead(lead.id, stopAgents)).then(onClosed);
  };
  return (
    <Modal title="Close the Lead?" onClose={onClose}>
      <div className="confirm-body">
        You can still read its conversation from this workspace’s menu.{' '}
        {working > 0
          ? `${working === 1 ? '1 agent is' : `${working} agents are`} still working. If they keep going, their reports wait until you start a new Lead, which stays on ${model}.`
          : `A new Lead stays on ${model}.`}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        {working > 0 && <button type="button" className="button" onClick={() => close(true)}>Stop them too</button>}
        <button type="button" autoFocus className="button button-primary" onClick={() => close(false)}>{working > 0 ? 'Keep them working' : 'Close the Lead'}</button>
      </div>
    </Modal>
  );
}

/** A workspace with no Lead, because it was closed or the workspace is older than Leads. */
export function NoLead({ workspace, earlier, onOpen }: { workspace: Workspace; earlier?: Session; onOpen: (id: string) => void }) {
  const catalog = useStore((store) => store.catalog);
  const choice = workspace.leadLockedAt ? workspace.lead : undefined;
  const start = async (make: () => Promise<Session>) => {
    const created = await attempt(make);
    if (created) onOpen(created.id);
  };
  return (
    <div className="page">
      <div className="page-column no-lead">
        <div className="empty-card">
          <p>
            <strong>This workspace has no Lead.</strong><br />
            {choice ? `A new one starts on ${modelLabel(catalog, choice.agent, choice.model)} ${effortLabel(choice.effort)}, the model fixed for this workspace. ` : 'A new one starts on your default model. '}
            It’s told about the agents already here. It doesn’t get the last Lead’s conversation.
          </p>
          <div className="inline-actions">
            <button type="button" className="button button-primary" onClick={() => void start(() => api.createLead(workspace.id))}><Crown size={13} /> Start a new Lead</button>
            <button type="button" className="button" onClick={() => void start(() => api.createSession(workspace.id))}>New conversation</button>
            {earlier && <button type="button" className="link-button" onClick={() => onOpen(earlier.id)}>Read the last Lead’s conversation</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shown on a phone above the composer, in place of tabs, while agents are at work. */
export function TeamStrip({ lead, onShow }: { lead: Session; onShow: () => void }) {
  const allSessions = useStore((store) => store.sessions);
  const agents = agentsIn(allSessions, lead.workspaceId);
  const working = agents.filter(isWorking);
  const paused = agents.filter((agent) => agent.lastOutcome === 'limit');
  if (working.length === 0 && paused.length === 0) return null;
  const startedAt = working.map((agent) => agent.work?.turnStartedAt ?? 0).filter(Boolean);
  return (
    <button type="button" className="team-strip" onClick={onShow}>
      <StatusGlyph state={working.length > 0 ? 'working' : 'limit'} />
      <span>
        {working.length > 0 ? `${working.length === 1 ? '1 agent' : `${working.length} agents`} working` : `${paused.length === 1 ? '1 agent' : `${paused.length} agents`} paused at a limit`}
        {startedAt.length > 0 && <>, <Elapsed since={Math.min(...startedAt)} /></>}
      </span>
    </button>
  );
}

function SheetRow({ state, title, detail, active, onSelect, onClose }: { state: React.ReactNode; title: string; detail?: string; active: boolean; onSelect: () => void; onClose: () => void }) {
  return (
    <div className={`sheet-row ${active ? 'active' : ''}`}>
      <button type="button" className="sheet-open" aria-current={active ? 'true' : undefined} onClick={onSelect}>
        <span className="sheet-icon">{state}</span>
        <span className="team-row-main">
          <span className="team-row-title">{title}</span>
          {detail && <span className="team-row-detail">{detail}</span>}
        </span>
      </button>
      <IconButton label={`Close ${title}`} onClick={onClose}><X size={15} /></IconButton>
    </div>
  );
}

/** A phone's way between tabs: everything in the workspace, one row each. */
export function TabsSheet({ workspace, sessions, files, activeKey, onSelect, onCloseSession, onCloseFile, onNew, onNewLead, onClose }: {
  workspace: Workspace;
  sessions: Session[];
  files: Exclude<WorkspaceTab, { kind: 'session' }>[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onCloseSession: (session: Session) => void;
  onCloseFile: (key: string) => void;
  onNew: () => void;
  onNewLead: () => void;
  onClose: () => void;
}) {
  const catalog = useStore((store) => store.catalog);
  const lead = sessions.find((session) => session.role === 'lead');
  const agents = sessions.filter((session) => session.role === 'agent');
  const mine = sessions.filter((session) => !session.role);
  const working = agents.some(isWorking);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const describe = (session: Session) => [
    `${modelLabel(catalog, session.agent, session.model)}, ${effortLabel(session.effort)}`,
    session.status === 'running' ? session.work?.activity : undefined,
  ].filter(Boolean).join('. ');
  const key = (session: Session) => `session:${session.id}`;
  return (
    <div className="tabs-sheet" role="dialog" aria-label="Tabs in this workspace">
      <header className="tabs-sheet-head">
        <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        <strong>{workspace.name}</strong>
      </header>
      <div className="tabs-sheet-body">
        {lead && <SheetRow state={sessionState(lead) ? <StatusGlyph state={sessionState(lead)} size={14} /> : <Crown size={14} />} title="Lead" detail={describe(lead)} active={activeKey === key(lead)} onSelect={() => onSelect(key(lead))} onClose={() => onCloseSession(lead)} />}
        {agents.length > 0 && (
          <div className="panel-heading">
            <span>Agents</span>
            {working && <button type="button" className="link-button" onClick={() => void attempt(() => api.stopAgents(workspace.id))}>Stop the agents</button>}
          </div>
        )}
        {agents.map((agent) => <SheetRow key={agent.id} state={<StatusGlyph state={sessionState(agent)} size={14} />} title={agent.title} detail={describe(agent)} active={activeKey === key(agent)} onSelect={() => onSelect(key(agent))} onClose={() => onCloseSession(agent)} />)}
        {mine.length > 0 && <div className="panel-heading"><span>Your conversations</span></div>}
        {mine.map((session) => <SheetRow key={session.id} state={<MessageCircle size={14} />} title={session.title} detail={describe(session)} active={activeKey === key(session)} onSelect={() => onSelect(key(session))} onClose={() => onCloseSession(session)} />)}
        {files.length > 0 && <div className="panel-heading"><span>Open files</span></div>}
        {files.map((file) => {
          const fileKey = `${file.kind}:${file.path}`;
          return <SheetRow key={fileKey} state={<FileText size={14} />} title={basename(file.path)} detail={file.path} active={activeKey === fileKey} onSelect={() => onSelect(fileKey)} onClose={() => onCloseFile(fileKey)} />;
        })}
        {!lead && <button type="button" className="sheet-new" onClick={onNewLead}><span className="sheet-icon"><Crown size={15} /></span><span>New Lead</span></button>}
        <button type="button" className="sheet-new" onClick={onNew}><span className="sheet-icon"><Plus size={15} /></span><span>New conversation</span></button>
      </div>
    </div>
  );
}
