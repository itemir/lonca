import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle, Archive, ArrowLeft, ArrowRight, ChevronRight, CircleHelp, GitBranch, Home, Hourglass, MoreHorizontal, PanelLeft,
  Pause, Plus, Search, Settings as SettingsIcon, Trash2,
} from 'lucide-react';
import type { Project, Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { compactNumber } from '../format.ts';
import { useLayout } from '../layout.ts';
import { attempt, useStore } from '../store.ts';
import { canClose, closeVerb, CloseWorkspaceDialog } from './CloseWorkspaceDialog.tsx';
import { Avatar, ConfirmDialog, type ConfirmOptions, IconButton, Menu, Spinner } from './ui.tsx';

function DiffBadge({ workspace }: { workspace: Workspace }) {
  const diff = workspace.diff;
  if (!diff || (diff.added === 0 && diff.removed === 0)) return null;
  return (
    <span className="diff-badge">
      {diff.added > 0 && <span className="added">+{compactNumber(diff.added)}</span>}
      {diff.removed > 0 && <span className="removed">-{compactNumber(diff.removed)}</span>}
    </span>
  );
}

function WorkspaceIcon({ workspace }: { workspace: Workspace }) {
  const running = useStore((store) => store.sessions.some((session) => session.workspaceId === workspace.id && session.status === 'running'));
  const lead = useStore((store) => store.sessions.find((session) => session.workspaceId === workspace.id && session.role === 'lead' && !session.closedAt));
  if (running || ['creating', 'restoring', 'rebuilding', 'archiving', 'deleting', 'stopping', 'starting'].includes(workspace.status)) return <Spinner size={13} />;
  if (workspace.status === 'error') return <AlertCircle size={14} className="icon-error" />;
  if (lead?.lastOutcome === 'limit') return <Hourglass size={14} className="tab-state-limit" />;
  if (lead?.unread) return <span className="unread-dot" title="The Lead needs you" />;
  if (workspace.status === 'stopped') return <Pause size={14} className="icon-dim" />;
  if (workspace.status === 'archived') return <Archive size={14} className="icon-dim" />;
  return <GitBranch size={14} />;
}

function WorkspaceRow({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const [closing, setClosing] = useState(false);
  // Two rows can share a title, and only the name tells them apart.
  const name = workspace.title ? `“${workspace.title}” (${workspace.name})` : workspace.name;
  return (
    <div className={`workspace-row ${active ? 'active' : ''}`}>
      <Link to={`/w/${workspace.id}`} className="workspace-link" aria-current={active ? 'page' : undefined}>
        <span className="workspace-row-icon"><WorkspaceIcon workspace={workspace} /></span>
        <span className="workspace-row-title">{workspace.title ?? workspace.name}</span>
        <DiffBadge workspace={workspace} />
      </Link>
      {canClose(workspace) && (
        <IconButton className="icon-button-danger workspace-close" label={`${closeVerb(workspace)} ${name}`} onClick={() => setClosing(true)}>
          <Trash2 size={14} />
        </IconButton>
      )}
      {closing && <CloseWorkspaceDialog workspace={workspace} onClose={() => setClosing(false)} />}
    </div>
  );
}

function ProjectGroup({ project, activeId }: { project: Project; activeId: string | null }) {
  const allWorkspaces = useStore((store) => store.workspaces);
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const workspaces = allWorkspaces.filter((workspace) => workspace.projectId === project.id);
  const visible = workspaces.filter((workspace) => workspace.status !== 'archived');
  const archived = workspaces.filter((workspace) => workspace.status === 'archived');

  const createWorkspace = async () => {
    const created = await attempt(() => api.createWorkspace(project.id));
    if (created) navigate(`/w/${created.workspace.id}`);
  };

  const removeProject = () => setConfirm({
    title: `Remove ${project.name}?`,
    body: workspaces.length > 0
      ? `This deletes its ${workspaces.length === 1 ? 'workspace' : `${workspaces.length} workspaces`} and any commits that were never pushed.${project.localPath ? ` Your checkout at ${project.localPath} isn’t touched.` : ''}`
      : `Lonca’s copy of the repository is deleted.${project.localPath ? ` Your checkout at ${project.localPath} isn’t touched.` : ''}`,
    action: 'Remove project',
    danger: true,
    onConfirm: () => void attempt(() => api.removeProject(project.id)),
  });

  return (
    <section className="project-group">
      <div className="project-row">
        <button
          type="button"
          className="project-name"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Avatar owner={project.githubOwner} name={project.name} />
          <span>{project.name}</span>
        </button>
        <Menu
          className="project-menu"
          label={`${project.name} options`}
          trigger={<MoreHorizontal size={15} />}
          align="right"
          entries={[
            { label: 'Project settings', icon: <SettingsIcon size={14} />, onSelect: () => navigate(`/projects/${project.id}`) },
            { label: 'Remove project', icon: <Trash2 size={14} />, danger: true, onSelect: removeProject },
          ]}
        />
        <IconButton label={`New workspace in ${project.name}`} onClick={createWorkspace} disabled={project.status !== 'ready'}>
          {project.status === 'cloning' ? <Spinner size={13} /> : <Plus size={15} />}
        </IconButton>
      </div>
      {project.status === 'cloning' && <p className="project-note">{project.progress ?? 'Cloning…'}</p>}
      {project.status === 'error' && <p className="project-note project-error">{project.error}</p>}
      {!collapsed && (
        <>
          {visible.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} active={workspace.id === activeId} />)}
          {archived.length > 0 && (
            <button type="button" className="archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
              <ChevronRight size={13} className={showArchived ? 'rotated' : ''} />
              {archived.length} archived
            </button>
          )}
          {showArchived && archived.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} active={workspace.id === activeId} />)}
        </>
      )}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}

function SandboxStatusChip() {
  const system = useStore((store) => store.system);
  let text = 'VMs ready';
  let state = 'ok';
  if (system.sandbox.state === 'checking') {
    text = 'Checking for VMs';
    state = 'busy';
  } else if (system.sandbox.state !== 'ready') {
    text = 'VMs unavailable';
    state = 'error';
  } else if (system.image.state === 'building') {
    text = 'Building template';
    state = 'busy';
  } else if (system.image.state === 'error') {
    text = 'Template failed';
    state = 'error';
  }
  return <Link to="/settings" className={`status-chip status-${state}`} title="Open settings">{text}</Link>;
}

export function Sidebar() {
  const me = useStore((store) => store.me);
  const projects = useStore((store) => store.projects);
  const setSearchOpen = useStore((store) => store.setSearchOpen);
  const setAddProjectOpen = useStore((store) => store.setAddProjectOpen);
  const toggleSidebar = useLayout((layout) => layout.toggleSidebar);
  const navigate = useNavigate();
  const location = useLocation();
  const activeId = /^\/w\/([^/]+)/.exec(location.pathname)?.[1] ?? null;

  return (
    <aside className="sidebar" aria-label="Projects and workspaces">
      <div className="sidebar-top">
        <IconButton label="Hide the sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton>
        <span className="spacer" />
        <IconButton label="Back" onClick={() => navigate(-1)}><ArrowLeft size={16} /></IconButton>
        <IconButton label="Forward" onClick={() => navigate(1)}><ArrowRight size={16} /></IconButton>
      </div>
      <div className="account">
        <Avatar name={me.name} size={20} />
        <span className="account-name">{me.machine}</span>
      </div>
      <nav className="sidebar-nav">
        <NavLink to="/" end className="nav-row"><Home size={15} />Home</NavLink>
        <NavLink to="/create" className="nav-row"><Plus size={15} />Create</NavLink>
        <button type="button" className="nav-row" onClick={() => setSearchOpen(true)}><Search size={15} />Search</button>
      </nav>
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <span>My projects</span>
          <IconButton label="Add a project" onClick={() => setAddProjectOpen(true)}><Plus size={15} /></IconButton>
        </div>
        {projects.length === 0 && (
          <button type="button" className="sidebar-empty" onClick={() => setAddProjectOpen(true)}>Add your first project</button>
        )}
        {projects.map((project) => <ProjectGroup key={project.id} project={project} activeId={activeId} />)}
      </div>
      <footer className="sidebar-footer">
        <SandboxStatusChip />
        <span className="spacer" />
        <a className="icon-button" href="https://github.com/itemir/lonca#readme" target="_blank" rel="noreferrer" aria-label="Help" title="Help"><CircleHelp size={16} /></a>
        <Link className="icon-button" to="/settings" aria-label="Settings" title="Settings"><SettingsIcon size={16} /></Link>
      </footer>
    </aside>
  );
}
