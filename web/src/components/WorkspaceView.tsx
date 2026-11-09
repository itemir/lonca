import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle, Archive, ArchiveRestore, Box, Check, ChevronDown, ChevronLeft, ChevronRight, Code2, Copy, Crown, Diff, File as FileIcon, Folder, GitBranch, Globe, Info, Layers, MoreHorizontal, PanelLeft,
  PanelRight, Pause, Pencil, Play, Plus, RotateCcw, Settings as SettingsIcon, Trash2, Users, X,
} from 'lucide-react';
import { profileIdOf } from '../../../shared/profiles.ts';
import type { Project, Session, Workspace, WorkspaceStep } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { basename, effortLabel } from '../format.ts';
import { useIsPhone } from '../hooks.ts';
import { useLayout } from '../layout.ts';
import { sessionSignIn } from '../signins.ts';
import { attempt, tabKey, useStore, type WorkspaceTab } from '../store.ts';
import { ChatTranscript } from './Chat.tsx';
import { canClose, closeVerb, useCloseWorkspace } from './CloseWorkspaceDialog.tsx';
import { Composer } from './Composer.tsx';
import { DiffTab, FileTab } from './FileViews.tsx';
import { modelLabel } from './ModelPicker.tsx';
import { RightPanel } from './RightPanel.tsx';
import { CloseLeadDialog, NoLead, SessionBanner, StatusGlyph, TabsSheet, TeamActivity, TeamStrip, sessionState } from './Team.tsx';
import { Avatar, ConfirmDialog, type ConfirmOptions, IconButton, Menu, Modal, Spinner } from './ui.tsx';

const portUrl = (workspace: Workspace) => `http://localhost:${workspace.port}`;

function copyPath(workspace: Workspace): void {
  void navigator.clipboard.writeText(workspace.path);
  useStore.getState().toast(`Copied ${workspace.path}`);
}

function StepRow({ step, children, icon }: { step: WorkspaceStep | undefined; children: React.ReactNode; icon: React.ReactNode }) {
  const status = step?.status;
  return (
    <li className={`intro-step step-${status ?? 'done'}`} data-step={step?.id}>
      <span className="intro-icon">{status === 'running' ? <Spinner size={14} /> : status === 'error' ? <AlertCircle size={16} /> : icon}</span>
      <span>{children}</span>
    </li>
  );
}

function WorkspaceIntro({ workspace, project, session, hasLead }: { workspace: Workspace; project: Project; session: Session; hasLead: boolean }) {
  const step = (id: WorkspaceStep['id']) => workspace.steps.find((entry) => entry.id === id);
  const worktree = step('worktree');
  const image = step('image');
  const sandbox = step('sandbox');
  const setup = step('setup');
  const files = step('files');
  const base = `origin/${workspace.baseBranch}`;
  const finished = (entry: WorkspaceStep | undefined) => entry?.status === 'done' || entry?.status === 'warning';
  const hasSetup = Boolean(project.settings.setupScript.trim()) || (setup && setup.status !== 'pending');
  // Rows keep their place while the workspace boots, so nothing jumps as steps finish.
  return (
    <div className="intro">
      <div className="intro-card">
        You’re in a new copy of <strong>{project.name}</strong> called <strong>{workspace.name}</strong>
      </div>
      <ul className="intro-steps">
        {image?.status === 'running' && (
          <StepRow step={image} icon={<Box size={16} />}>Preparing the workspace template. The first time takes a few minutes.</StepRow>
        )}
        <StepRow step={worktree} icon={<GitBranch size={16} />}>
          {finished(worktree) ? 'Branched' : 'Branching'} <code>{workspace.branch}</code> from <code>{base}</code>
          {worktree?.status === 'warning' && <span className="step-warning-text"> {worktree.detail}</span>}
        </StepRow>
        <StepRow step={files} icon={<Folder size={16} />}>
          {finished(files) ? 'Created' : 'Creating'}{' '}
          <Menu
            className="inline-menu"
            label={`${workspace.name} options`}
            trigger={<span className="chip">{workspace.name}<ChevronDown size={12} /></span>}
            entries={[{ label: 'Copy path', icon: <Copy size={14} />, onSelect: () => copyPath(workspace) }]}
          />
          {workspace.filesCopied > 0 && <> and copied {workspace.filesCopied} {workspace.filesCopied === 1 ? 'file' : 'files'}</>}
        </StepRow>
        <StepRow step={sandbox} icon={<Box size={16} />}>
          {finished(sandbox)
            ? <>Running in its own virtual machine, <code>{workspace.sandboxName}</code></>
            : 'Starting an isolated virtual machine'}
        </StepRow>
        {setup?.status === 'running' && <StepRow step={setup} icon={<Info size={16} />}>Running the setup script. Its output is in the Setup tab.</StepRow>}
        {setup?.status === 'done' && <StepRow step={setup} icon={<Check size={16} />}>Ran the setup script. Its output is in the Setup tab.</StepRow>}
        {setup?.status === 'error' && <StepRow step={setup} icon={<Info size={16} />}>{setup.detail ?? 'The setup script failed.'} Its output is in the Setup tab.</StepRow>}
        {workspace.status === 'ready' && !hasSetup && (
          <StepRow step={undefined} icon={<Info size={16} />}>
            Optional: <Link to={`/projects/${project.id}`}>add a setup script ↗</Link>
          </StepRow>
        )}
        {workspace.status === 'ready' && (
          <StepRow step={undefined} icon={<Globe size={16} />}>
            A server listening on <code>0.0.0.0</code> opens at <a href={portUrl(workspace)} target="_blank" rel="noreferrer">localhost:{workspace.port} ↗</a>. That port is in <code>$LONCA_PORT</code>, and the next nine are published too.
          </StepRow>
        )}
        {session.role === 'lead' && !session.hasMessages && (
          <StepRow step={undefined} icon={<Crown size={16} />}>
            Your Lead is ready. Tell it the outcome you want. It does the work itself or starts other agents, and it’s accountable for the result.
          </StepRow>
        )}
        {!session.role && hasLead && (
          <StepRow step={undefined} icon={<Users size={16} />}>
            This conversation is your own, not part of the Lead’s team. It shares the same files, and the Lead isn’t told what it does.
          </StepRow>
        )}
      </ul>
    </div>
  );
}

function StatusBanner({ workspace }: { workspace: Workspace }) {
  const act = (action: 'retry' | 'restore' | 'start') => () => void attempt(() => api.workspaceAction(workspace.id, action));
  switch (workspace.status) {
    case 'error':
      return (
        <div className="workspace-banner banner-error" role="alert">
          <AlertCircle size={15} />
          <span>{workspace.error ?? 'This workspace failed.'}</span>
          <button type="button" className="button button-small" onClick={act('retry')}><RotateCcw size={13} /> {workspace.pendingOperation ? `Retry ${workspace.pendingOperation}` : 'Try again'}</button>
        </div>
      );
    case 'stopped':
      // A failed start leaves the workspace stopped, and the reason has to stay in view to be fixed.
      return workspace.error ? (
        <div className="workspace-banner banner-error" role="alert">
          <AlertCircle size={15} />
          <span>{workspace.error}</span>
          <button type="button" className="button button-small" onClick={act('start')}><RotateCcw size={13} /> Try again</button>
        </div>
      ) : (
        <div className="workspace-banner">
          <Pause size={15} />
          <span>This workspace’s virtual machine is stopped. Sending a message starts it again.</span>
          <button type="button" className="button button-small" onClick={act('start')}><Play size={13} /> Start</button>
        </div>
      );
    case 'archived':
      return (
        <div className="workspace-banner">
          <Archive size={15} />
          <span>This workspace is archived. Its branch <code>{workspace.branch}</code> and chat history are kept.</span>
          <button type="button" className="button button-small" onClick={act('restore')}><ArchiveRestore size={13} /> Restore</button>
        </div>
      );
    case 'archiving':
      return <div className="workspace-banner"><Spinner /> <span>Archiving…</span></div>;
    case 'rebuilding':
      return <div className="workspace-banner"><Spinner /> <span>Rebuilding… New messages will wait until the workspace is ready.</span></div>;
    case 'stopping':
      return <div className="workspace-banner"><Spinner /> <span>Stopping…</span></div>;
    case 'starting':
      return <div className="workspace-banner"><Spinner /> <span>Starting… New messages will wait until the workspace is ready.</span></div>;
    case 'deleting':
      return <div className="workspace-banner"><Spinner /> <span>Deleting…</span></div>;
    default:
      return null;
  }
}

function RenameDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const [title, setTitle] = useState(workspace.title ?? workspace.name);
  return (
    <Modal title="Rename workspace" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) void attempt(() => api.renameWorkspace(workspace.id, title.trim()));
          onClose();
        }}
      >
        <label className="field">
          <span className="field-label">Name in the sidebar</span>
          <input className="input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button-primary">Save name</button>
        </div>
      </form>
    </Modal>
  );
}

function WorkspaceHeader({ workspace, project, earlierLeads, onReadLead, phone }: {
  workspace: Workspace;
  project: Project;
  earlierLeads: Session[];
  onReadLead: (session: Session) => void;
  /** A phone shows where you are and how to move between tabs here, in place of tabs. */
  phone?: { title?: string; subtitle?: string; onBack?: () => void; onShowTabs: () => void };
}) {
  const navigate = useNavigate();
  const { sidebarOpen, toggleSidebar, rightOpen, toggleRight } = useLayout();
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const [renaming, setRenaming] = useState(false);
  const close = useCloseWorkspace(workspace);
  const running = workspace.status === 'ready';

  const openInEditor = (name: string, scheme: string) => setConfirm({
    title: `Open in ${name}?`,
    body: `${name} runs on your computer, outside the virtual machine, and can act on settings, tasks and git config an agent left in this workspace. Open it if you trust what the agent has written.`,
    action: `Open in ${name}`,
    onConfirm: () => window.open(`${scheme}://file${workspace.path}`),
  });

  return (
    <header className="workspace-header">
      {!sidebarOpen && !phone?.onBack && <IconButton label="Show the sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton>}
      {phone?.onBack && (
        <button type="button" className="phone-back" onClick={phone.onBack}><ChevronLeft size={18} /> Lead</button>
      )}
      <div className="crumbs">
        {phone?.title ? (
          <div className="phone-title">
            <strong>{phone.title}</strong>
            {phone.subtitle && <span>{phone.subtitle}</span>}
          </div>
        ) : (
          <>
            {/* A phone's header is mostly buttons, so what's left goes to which workspace this is. */}
            {!phone && (
              <>
                <Avatar owner={project.githubOwner} name={project.name} size={20} />
                <Link to={`/projects/${project.id}`} className="crumb">{project.name}</Link>
                <ChevronRight size={14} className="crumb-separator" />
              </>
            )}
            <span className="crumb" title={workspace.branch}>{workspace.branch.split('/').at(-1)}</span>
          </>
        )}
        <Menu
          className="crumb-menu"
          label="Workspace options"
          trigger={<MoreHorizontal size={16} />}
          entries={[
            { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
            { label: 'Rebuild virtual machine', icon: <RotateCcw size={14} />, disabled: !running && workspace.status !== 'stopped', onSelect: () => void attempt(() => api.workspaceAction(workspace.id, 'recreate')) },
            ...earlierLeads.map((lead) => ({
              label: `Read the Lead closed ${new Date(lead.closedAt!).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
              icon: <Crown size={14} />,
              onSelect: () => onReadLead(lead),
            })),
            { label: 'Project settings', icon: <SettingsIcon size={14} />, onSelect: () => navigate(`/projects/${project.id}`) },
          ]}
        />
      </div>
      <span className="spacer" />
      {phone && <IconButton label="Show all tabs" onClick={phone.onShowTabs}><Layers size={17} /></IconButton>}
      <span className="workspace-name">{workspace.name}</span>
      <IconButton className="icon-button-danger" label={`${closeVerb(workspace)} this workspace`} disabled={!canClose(workspace)} onClick={close.press}>
        {close.checking ? <Spinner size={15} /> : <Trash2 size={16} />}
      </IconButton>
      <Menu
        className="open-in"
        label="Open this workspace elsewhere"
        align="right"
        trigger={<span className="open-in-button"><span className="open-in-icon"><Code2 size={14} /></span><span className="open-in-caret"><ChevronDown size={13} /></span></span>}
        entries={[
          { label: 'Open in VS Code', icon: <Code2 size={14} />, onSelect: () => openInEditor('VS Code', 'vscode') },
          { label: 'Open in Cursor', icon: <Code2 size={14} />, onSelect: () => openInEditor('Cursor', 'cursor') },
          { label: 'Copy path', icon: <Copy size={14} />, onSelect: () => copyPath(workspace) },
          { label: `Open localhost:${workspace.port}`, icon: <Globe size={14} />, disabled: !running, onSelect: () => window.open(portUrl(workspace), '_blank', 'noopener,noreferrer') },
        ]}
      />
      <IconButton label={rightOpen ? 'Hide the side panel' : 'Show the side panel'} onClick={toggleRight}><PanelRight size={16} /></IconButton>
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
      {renaming && <RenameDialog workspace={workspace} onClose={() => setRenaming(false)} />}
      {close.dialog}
    </header>
  );
}

/** The Lead and its agents keep their names, and show their state in a place that doesn't move. */
function TeamTabLabel({ session, active, onSelect, onClose }: { session: Session; active: boolean; onSelect: () => void; onClose: () => void }) {
  const catalog = useStore((store) => store.catalog);
  const state = sessionState(session);
  const lead = session.role === 'lead';
  return (
    <div className={`tab session-tab team-tab ${lead ? 'lead-tab' : ''} ${active ? 'active' : ''}`} role="tab" aria-selected={active}>
      <button type="button" className="tab-label" onClick={onSelect}>
        <span className="tab-slot">{state ? <StatusGlyph state={state} /> : lead && <Crown size={13} aria-hidden="true" />}</span>
        <span className="tab-title">{session.title}</span>
        {!lead && <span className="tab-model">{modelLabel(catalog, session.agent, session.model)}</span>}
      </button>
      <button type="button" className="tab-action tab-close" aria-label={`Close ${session.title}`} title="Close this tab" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

function SessionTabLabel({ session, active, canClose, onSelect, onClose }: {
  session: Session;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = () => {
    setEditing(false);
    if (title.trim() && title !== session.title) void attempt(() => api.updateSession(session.id, { title: title.trim() }));
    else setTitle(session.title);
  };
  return (
    <div className={`tab session-tab ${active ? 'active' : ''}`} role="tab" aria-selected={active}>
      {editing ? (
        <input
          ref={input}
          className="tab-rename"
          aria-label="Tab name"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') {
              setTitle(session.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button type="button" className="tab-label" onClick={onSelect}>
          {session.status === 'running' && <Spinner size={11} />}
          <span className="tab-title">{session.title}</span>
        </button>
      )}
      {active && !editing && (
        <button
          type="button"
          className="tab-action"
          aria-label="Rename this tab"
          title="Rename this tab"
          onClick={() => {
            setTitle(session.title);
            setEditing(true);
          }}
        >
          <Pencil size={13} />
        </button>
      )}
      {canClose && !editing && (
        <button type="button" className="tab-action tab-close" aria-label={`Close ${session.title}`} title="Close this tab" onClick={onClose}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function FileTabLabel({ tab, active, onSelect, onClose }: { tab: Exclude<WorkspaceTab, { kind: 'session' }>; active: boolean; onSelect: () => void; onClose: () => void }) {
  return (
    <div className={`tab file-tab ${active ? 'active' : ''}`} role="tab" aria-selected={active} title={tab.path}>
      <button type="button" className="tab-label" onClick={onSelect}>
        {tab.kind === 'diff' ? <Diff size={13} /> : <FileIcon size={13} />}
        <span className="tab-title">{basename(tab.path)}</span>
      </button>
      <button type="button" className="tab-action tab-close" aria-label={`Close ${basename(tab.path)}`} onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

/** Whatever's on screen has been read, as long as someone's looking at it. */
function MarkRead({ session }: { session: Session }) {
  const { id, unread } = session;
  useEffect(() => {
    if (!unread) return;
    const read = () => {
      if (document.hasFocus()) void attempt(() => api.markRead(id));
    };
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [id, unread]);
  return null;
}

const SESSION_ORDER = (session: Session) => (session.role === 'lead' ? 0 : session.role === 'agent' ? 1 : 2);

export function WorkspaceView() {
  const { id = '' } = useParams();
  const allWorkspaces = useStore((store) => store.workspaces);
  const allProjects = useStore((store) => store.projects);
  const allSessions = useStore((store) => store.sessions);
  const tabs = useStore((store) => store.tabs[id]);
  const openTab = useStore((store) => store.openTab);
  const closeTab = useStore((store) => store.closeTab);
  const setActiveTab = useStore((store) => store.setActiveTab);
  const rightOpen = useLayout((layout) => layout.rightOpen);
  const isPhone = useIsPhone();
  const catalog = useStore((store) => store.catalog);
  const profiles = useStore((store) => store.profiles);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const [closingLead, setClosingLead] = useState<Session | null>(null);
  const [tabsOpen, setTabsOpen] = useState(false);

  const workspace = allWorkspaces.find((entry) => entry.id === id);
  const project = allProjects.find((entry) => entry.id === workspace?.projectId);
  const sessions = useMemo(
    () => allSessions
      .filter((session) => session.workspaceId === id && !session.closedAt)
      .sort((a, b) => SESSION_ORDER(a) - SESSION_ORDER(b) || a.createdAt - b.createdAt),
    [allSessions, id],
  );
  const earlierLeads = useMemo(
    () => allSessions.filter((session) => session.workspaceId === id && session.closedAt).sort((a, b) => b.closedAt! - a.closedAt!),
    [allSessions, id],
  );

  if (!workspace || !project) {
    return <div className="tab-message">This workspace no longer exists. <Link to="/">Go home</Link></div>;
  }

  const fileTabs = (tabs?.files ?? []).filter((tab): tab is Exclude<WorkspaceTab, { kind: 'session' }> => tab.kind !== 'session');
  const activeKey = tabs?.active ?? null;
  const activeFile = fileTabs.find((tab) => tabKey(tab) === activeKey);
  const readingLead = earlierLeads.find((session) => `session:${session.id}` === activeKey);
  const activeSession = activeFile
    ? undefined
    : readingLead ?? sessions.find((session) => `session:${session.id}` === activeKey) ?? sessions[0];
  const lead = sessions.find((session) => session.role === 'lead');
  const mine = sessions.filter((session) => !session.role);
  const openSession = (sessionId: string) => openTab(id, { kind: 'session', id: sessionId });

  const newSession = async () => {
    const current = activeSession ?? sessions.at(-1);
    const created = await attempt(() => api.createSession(id, current ? { agent: current.agent, model: current.model, effort: current.effort, profileId: profileIdOf(current) } : {}));
    if (created) openTab(id, { kind: 'session', id: created.id });
  };

  const startLead = async () => {
    const created = await attempt(() => api.createLead(id));
    if (created) openSession(created.id);
  };

  const closeSession = (session: Session) => {
    if (session.role === 'lead' && session.hasMessages) {
      setClosingLead(session);
      return;
    }
    const remove = async () => {
      await attempt(() => api.deleteSession(session.id));
      closeTab(id, `session:${session.id}`);
    };
    if (!session.hasMessages) {
      void remove();
      return;
    }
    setConfirm({
      title: `Close ${session.title}?`,
      body: 'This conversation is deleted. The workspace’s files aren’t affected.',
      action: 'Close tab',
      danger: true,
      onConfirm: () => void remove(),
    });
  };

  const createPr = async () => {
    // A Lead's agents can't push, and it's the Lead that answers for what gets delivered.
    const target = lead ?? (activeSession && !activeSession.closedAt ? activeSession : sessions[0]);
    if (!target) return;
    openTab(id, { kind: 'session', id: target.id });
    await attempt(() => api.sendMessage(
      target.id,
      `Commit any uncommitted work with a clear message, push this branch, and open a pull request against ${workspace.baseBranch} with \`gh pr create\`. Write a title and description that explain the change.`,
      [],
    ));
  };

  return (
    <div className="workspace">
      <div className="workspace-main">
        <WorkspaceHeader
          key={workspace.id}
          workspace={workspace}
          project={project}
          earlierLeads={earlierLeads}
          onReadLead={(session) => openSession(session.id)}
          phone={isPhone ? {
            title: activeFile ? basename(activeFile.path) : activeSession && activeSession.role !== 'lead' ? activeSession.title : undefined,
            subtitle: activeSession?.role === 'agent'
              ? [modelLabel(catalog, activeSession.agent, activeSession.model), effortLabel(activeSession.effort), sessionSignIn(activeSession, profiles, catalog)].filter(Boolean).join(', ')
              : undefined,
            onBack: lead && activeSession?.id !== lead.id ? () => openSession(lead.id) : undefined,
            onShowTabs: () => setTabsOpen(true),
          } : undefined}
        />
        {!isPhone && <div className="tab-bar" role="tablist">
          {!lead && <button type="button" className="new-lead-tab" onClick={() => void startLead()}><Plus size={13} /> New Lead</button>}
          {sessions.filter((session) => session.role).map((session) => (
            <TeamTabLabel
              key={session.id}
              session={session}
              active={session.id === activeSession?.id}
              onSelect={() => setActiveTab(id, `session:${session.id}`)}
              onClose={() => closeSession(session)}
            />
          ))}
          {mine.length > 0 && sessions.length > mine.length && <span className="tab-divider" />}
          {mine.map((session) => (
            <SessionTabLabel
              key={session.id}
              session={session}
              active={session.id === activeSession?.id}
              canClose
              onSelect={() => setActiveTab(id, `session:${session.id}`)}
              onClose={() => closeSession(session)}
            />
          ))}
          {readingLead && (
            <div className="tab session-tab team-tab active" role="tab" aria-selected>
              <span className="tab-label"><span className="tab-slot"><Crown size={13} aria-hidden="true" /></span><span className="tab-title">Earlier Lead</span></span>
              <button type="button" className="tab-action tab-close" aria-label="Close Earlier Lead" title="Close this tab" onClick={() => closeTab(id, `session:${readingLead.id}`)}>
                <X size={13} />
              </button>
            </div>
          )}
          {fileTabs.map((tab) => (
            <FileTabLabel
              key={tabKey(tab)}
              tab={tab}
              active={tabKey(tab) === activeKey}
              onSelect={() => setActiveTab(id, tabKey(tab))}
              onClose={() => closeTab(id, tabKey(tab))}
            />
          ))}
          <IconButton label="New conversation" onClick={newSession}><Plus size={15} /></IconButton>
        </div>}
        <StatusBanner workspace={workspace} />
        {activeSession && <SessionBanner session={activeSession} />}
        {activeSession && <MarkRead session={activeSession} />}
        <div className="workspace-content">
          {activeFile?.kind === 'file' && <FileTab key={tabKey(activeFile)} workspace={workspace} path={activeFile.path} line={activeFile.line} />}
          {activeFile?.kind === 'diff' && <DiffTab key={tabKey(activeFile)} workspace={workspace} path={activeFile.path} untracked={activeFile.untracked} oldPath={activeFile.oldPath} />}
          {!activeSession && !activeFile && <NoLead workspace={workspace} earlier={earlierLeads[0]} onOpen={openSession} />}
          {activeSession && (
            <>
              <ChatTranscript
                session={activeSession}
                workspace={workspace}
                intro={activeSession.role === 'agent' || activeSession.closedAt ? null : <WorkspaceIntro workspace={workspace} project={project} session={activeSession} hasLead={Boolean(lead)} />}
                footer={activeSession.id === lead?.id && !isPhone && <TeamActivity lead={lead} onOpen={openSession} />}
              />
              {activeSession.closedAt
                ? <div className="closed-note">This Lead was closed, so its conversation can’t continue. {lead ? 'The current Lead has the Lead tab.' : <button type="button" className="link-button" onClick={() => void startLead()}>Start a new Lead</button>}</div>
                : (
                  <>
                    {isPhone && activeSession.id === lead?.id && <TeamStrip lead={lead} onShow={() => setTabsOpen(true)} />}
                    <Composer key={activeSession.id} session={activeSession} workspace={workspace} />
                  </>
                )}
            </>
          )}
        </div>
        {tabsOpen && (
          <TabsSheet
            workspace={workspace}
            sessions={sessions}
            files={fileTabs}
            activeKey={activeFile ? tabKey(activeFile) : activeSession ? `session:${activeSession.id}` : null}
            onSelect={(key) => {
              setActiveTab(id, key);
              setTabsOpen(false);
            }}
            onCloseSession={(session) => {
              setTabsOpen(false);
              closeSession(session);
            }}
            onCloseFile={(key) => closeTab(id, key)}
            onNew={() => {
              setTabsOpen(false);
              void newSession();
            }}
            onNewLead={() => {
              setTabsOpen(false);
              void startLead();
            }}
            onClose={() => setTabsOpen(false)}
          />
        )}
      </div>
      {rightOpen && (
        <RightPanel
          key={workspace.id}
          workspace={workspace}
          project={project}
          onOpenFile={(path, line) => openTab(id, { kind: 'file', path, line })}
          onOpenDiff={(path, untracked, oldPath) => openTab(id, { kind: 'diff', path, untracked, oldPath })}
          onCreatePr={createPr}
        />
      )}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
      {closingLead && <CloseLeadDialog lead={closingLead} onClose={() => setClosingLead(null)} onClosed={() => closeTab(id, `session:${closingLead.id}`)} />}
    </div>
  );
}
