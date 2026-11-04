import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle, Archive, ArchiveRestore, Box, Check, ChevronDown, ChevronRight, Code2, Copy, Diff, File as FileIcon, Folder, GitBranch, Info, MoreHorizontal, PanelLeft,
  PanelRight, Pause, Pencil, Play, Plus, RotateCcw, Settings as SettingsIcon, Trash2, X,
} from 'lucide-react';
import type { Project, Session, Workspace, WorkspaceStep } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { basename, runtimeName } from '../format.ts';
import { useLayout } from '../layout.ts';
import { attempt, tabKey, useStore, type WorkspaceTab } from '../store.ts';
import { ChatTranscript } from './Chat.tsx';
import { Composer } from './Composer.tsx';
import { DiffTab, FileTab } from './FileViews.tsx';
import { RightPanel } from './RightPanel.tsx';
import { Avatar, ConfirmDialog, type ConfirmOptions, IconButton, Menu, Modal, Spinner } from './ui.tsx';

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

function WorkspaceIntro({ workspace, project }: { workspace: Workspace; project: Project }) {
  const step = (id: WorkspaceStep['id']) => workspace.steps.find((entry) => entry.id === id);
  const worktree = step('worktree');
  const image = step('image');
  const container = step('container');
  const setup = step('setup');
  const files = step('files');
  const base = `origin/${workspace.baseBranch}`;
  const finished = (entry: WorkspaceStep | undefined) => entry?.status === 'done' || entry?.status === 'warning';
  const runtime = runtimeName(workspace);
  const hasSetup = Boolean(project.settings.setupScript.trim()) || (setup && setup.status !== 'pending');
  // Rows keep their place while the workspace boots, so nothing jumps as steps finish.
  return (
    <div className="intro">
      <div className="intro-card">
        You’re in a new copy of <strong>{project.name}</strong> called <strong>{workspace.name}</strong>
      </div>
      <ul className="intro-steps">
        {image?.status === 'running' && (
          <StepRow step={image} icon={<Box size={16} />}>Preparing the workspace image. The first time takes a few minutes.</StepRow>
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
        <StepRow step={container} icon={<Box size={16} />}>
          {finished(container)
            ? <>Running in its own {runtime}, <code>{workspace.containerName}</code></>
            : `Starting an isolated ${runtime}`}
        </StepRow>
        {setup?.status === 'running' && <StepRow step={setup} icon={<Info size={16} />}>Running the setup script. Its output is in the Setup tab.</StepRow>}
        {setup?.status === 'done' && <StepRow step={setup} icon={<Check size={16} />}>Ran the setup script. Its output is in the Setup tab.</StepRow>}
        {setup?.status === 'error' && <StepRow step={setup} icon={<Info size={16} />}>{setup.detail ?? 'The setup script failed.'} Its output is in the Setup tab.</StepRow>}
        {workspace.status === 'ready' && !hasSetup && (
          <StepRow step={undefined} icon={<Info size={16} />}>
            Optional: <Link to={`/projects/${project.id}`}>add a setup script ↗</Link>
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
          <span>This workspace’s {runtimeName(workspace)} is stopped. Sending a message starts it again.</span>
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

function WorkspaceHeader({ workspace, project }: { workspace: Workspace; project: Project }) {
  const navigate = useNavigate();
  const { sidebarOpen, toggleSidebar, rightOpen, toggleRight } = useLayout();
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const [renaming, setRenaming] = useState(false);
  const running = workspace.status === 'ready';

  const openInEditor = (name: string, scheme: string) => setConfirm({
    title: `Open in ${name}?`,
    body: `${name} runs on your computer, outside the ${runtimeName(workspace)}, and can act on settings, tasks and git config an agent left in this workspace. Open it if you trust what the agent has written.`,
    action: `Open in ${name}`,
    onConfirm: () => window.open(`${scheme}://file${workspace.path}`),
  });

  const archive = async () => {
    const changes = running ? await api.changes(workspace.id).catch(() => null) : null;
    const uncommitted = changes?.uncommitted ?? 0;
    const body = changes === null
      ? `Its ${runtimeName(workspace)} and checkout are removed, along with any uncommitted changes. Commits stay on ${workspace.branch}, and you can restore it later.`
      : uncommitted > 0
        ? `Its ${runtimeName(workspace)} and checkout are removed. ${uncommitted} uncommitted ${uncommitted === 1 ? 'change is' : 'changes are'} lost; commits stay on ${workspace.branch}.`
        : `Its ${runtimeName(workspace)} and checkout are removed. Commits stay on ${workspace.branch}, and you can restore it later.`;
    setConfirm({
      title: `Archive ${workspace.name}?`,
      body,
      action: 'Archive workspace',
      onConfirm: () => void attempt(() => api.workspaceAction(workspace.id, 'archive')),
    });
  };

  const remove = () => setConfirm({
    title: `Delete ${workspace.name}?`,
    body: `Its ${runtimeName(workspace)}, checkout, chat history and the branch ${workspace.branch} are deleted. Commits that were never pushed are lost.`,
    action: 'Delete workspace',
    danger: true,
    onConfirm: async () => {
      navigate('/');
      await attempt(() => api.deleteWorkspace(workspace.id));
    },
  });

  return (
    <header className="workspace-header">
      {!sidebarOpen && <IconButton label="Show the sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton>}
      <div className="crumbs">
        <Avatar owner={project.githubOwner} name={project.name} size={20} />
        <Link to={`/projects/${project.id}`} className="crumb">{project.name}</Link>
        <ChevronRight size={14} className="crumb-separator" />
        <span className="crumb" title={workspace.branch}>{workspace.branch.split('/').at(-1)}</span>
        <Menu
          className="crumb-menu"
          label="Workspace options"
          trigger={<MoreHorizontal size={16} />}
          entries={[
            { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
            ...(workspace.status === 'stopped'
              ? [{ label: `Start ${runtimeName(workspace)}`, icon: <Play size={14} />, onSelect: () => void attempt(() => api.workspaceAction(workspace.id, 'start')) }]
              : [{ label: `Stop ${runtimeName(workspace)}`, icon: <Pause size={14} />, disabled: !running, onSelect: () => void attempt(() => api.workspaceAction(workspace.id, 'stop')) }]),
            { label: `Rebuild ${runtimeName(workspace)}`, icon: <RotateCcw size={14} />, disabled: !running && workspace.status !== 'stopped', onSelect: () => void attempt(() => api.workspaceAction(workspace.id, 'recreate')) },
            { label: 'Project settings', icon: <SettingsIcon size={14} />, onSelect: () => navigate(`/projects/${project.id}`) },
            { label: 'Archive', icon: <Archive size={14} />, disabled: !['ready', 'stopped'].includes(workspace.status), onSelect: () => void archive() },
            { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: remove },
          ]}
        />
      </div>
      <span className="spacer" />
      <span className="workspace-name">{workspace.name}</span>
      <Menu
        className="open-in"
        label="Open this workspace elsewhere"
        align="right"
        trigger={<span className="open-in-button"><span className="open-in-icon"><Code2 size={14} /></span><span className="open-in-caret"><ChevronDown size={13} /></span></span>}
        entries={[
          { label: 'Open in VS Code', icon: <Code2 size={14} />, onSelect: () => openInEditor('VS Code', 'vscode') },
          { label: 'Open in Cursor', icon: <Code2 size={14} />, onSelect: () => openInEditor('Cursor', 'cursor') },
          { label: 'Copy path', icon: <Copy size={14} />, onSelect: () => copyPath(workspace) },
        ]}
      />
      <IconButton label={rightOpen ? 'Hide the side panel' : 'Show the side panel'} onClick={toggleRight}><PanelRight size={16} /></IconButton>
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
      {renaming && <RenameDialog workspace={workspace} onClose={() => setRenaming(false)} />}
    </header>
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
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);

  const workspace = allWorkspaces.find((entry) => entry.id === id);
  const project = allProjects.find((entry) => entry.id === workspace?.projectId);
  const sessions = useMemo(
    () => allSessions.filter((session) => session.workspaceId === id).sort((a, b) => a.createdAt - b.createdAt),
    [allSessions, id],
  );

  if (!workspace || !project) {
    return <div className="tab-message">This workspace no longer exists. <Link to="/">Go home</Link></div>;
  }

  const fileTabs = (tabs?.files ?? []).filter((tab): tab is Exclude<WorkspaceTab, { kind: 'session' }> => tab.kind !== 'session');
  const activeKey = tabs?.active ?? null;
  const activeFile = fileTabs.find((tab) => tabKey(tab) === activeKey);
  const activeSession = activeFile
    ? undefined
    : sessions.find((session) => `session:${session.id}` === activeKey) ?? sessions[0];

  const newSession = async () => {
    const current = activeSession ?? sessions.at(-1);
    const created = await attempt(() => api.createSession(id, current ? { agent: current.agent, model: current.model, effort: current.effort } : {}));
    if (created) openTab(id, { kind: 'session', id: created.id });
  };

  const closeSession = (session: Session) => {
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
    const target = activeSession ?? sessions[0];
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
        <WorkspaceHeader workspace={workspace} project={project} />
        <div className="tab-bar" role="tablist">
          {sessions.map((session) => (
            <SessionTabLabel
              key={session.id}
              session={session}
              active={session.id === activeSession?.id}
              canClose={sessions.length > 1}
              onSelect={() => setActiveTab(id, `session:${session.id}`)}
              onClose={() => closeSession(session)}
            />
          ))}
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
        </div>
        <StatusBanner workspace={workspace} />
        <div className="workspace-content">
          {activeFile?.kind === 'file' && <FileTab key={tabKey(activeFile)} workspace={workspace} path={activeFile.path} line={activeFile.line} />}
          {activeFile?.kind === 'diff' && <DiffTab key={tabKey(activeFile)} workspace={workspace} path={activeFile.path} untracked={activeFile.untracked} oldPath={activeFile.oldPath} />}
          {activeSession && (
            <>
              <ChatTranscript session={activeSession} workspace={workspace} intro={<WorkspaceIntro workspace={workspace} project={project} />} />
              <Composer key={activeSession.id} session={activeSession} workspace={workspace} />
            </>
          )}
        </div>
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
    </div>
  );
}
