import { Link, useNavigate } from 'react-router-dom';
import { Check, CircleDashed, GitBranch, PanelLeft, Plus, X } from 'lucide-react';
import type { Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { IconButton, Avatar, Spinner } from '../components/ui.tsx';
import { compactNumber, timeAgo } from '../format.ts';
import { useLayout } from '../layout.ts';
import { attempt, signInBlocker, useStore } from '../store.ts';

function SetupRow({ state, children, action }: { state: 'done' | 'busy' | 'todo' | 'error'; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <li className={`setup-row setup-${state}`}>
      <span className="setup-icon">
        {state === 'done' && <Check size={15} />}
        {state === 'busy' && <Spinner size={14} />}
        {state === 'todo' && <CircleDashed size={15} />}
        {state === 'error' && <X size={15} />}
      </span>
      <span className="setup-text">{children}</span>
      {action}
    </li>
  );
}

function Setup() {
  const system = useStore((store) => store.system);
  const projects = useStore((store) => store.projects);
  const setAddProjectOpen = useStore((store) => store.setAddProjectOpen);
  const setLoginAgent = useStore((store) => store.setLoginAgent);
  const { sandbox, image, agents } = system;
  const claudeReady = agents.claude.signedIn && !agents.claude.rejected;
  const codexReady = agents.codex.signedIn && !agents.codex.rejected;
  const anyAgent = claudeReady || codexReady;
  const blocker = signInBlocker(system);
  // The one white button goes on the next thing to do. Either agent is enough.
  const nextIsSignIn = !anyAgent;
  const signIn = (agent: 'claude' | 'codex', primary: boolean) => (blocker
    ? <span className="setup-waiting">{blocker}</span>
    : <button type="button" className={`button button-small ${primary ? 'button-primary' : ''}`} onClick={() => setLoginAgent(agent)}>Sign in</button>);
  if (sandbox.state === 'ready' && image.state === 'ready' && anyAgent && projects.length > 0) return null;
  return (
    <section className="home-section">
      <h2>Get set up</h2>
      <ul className="setup-list">
        {sandbox.state === 'ready' && <SetupRow state="done">Each workspace gets its own virtual machine, using Docker Sandboxes {sandbox.version}</SetupRow>}
        {sandbox.state === 'checking' && <SetupRow state="busy">Checking for Docker Sandboxes</SetupRow>}
        {(sandbox.state === 'not-installed' || sandbox.state === 'signed-out') && (
          <SetupRow state="todo" action={<Link className="button button-small button-primary" to="/settings">Set up</Link>}>
            {sandbox.state === 'signed-out' ? 'Sign in to Docker Sandboxes, which runs your workspaces' : 'Install Docker Sandboxes, which runs your workspaces'}
          </SetupRow>
        )}
        {(sandbox.state === 'unsupported' || sandbox.state === 'unavailable') && <SetupRow state="error">Workspaces can’t run: {sandbox.detail}</SetupRow>}
        {sandbox.state === 'ready' && (
          <SetupRow state={image.state === 'ready' ? 'done' : image.state === 'error' ? 'error' : 'busy'}>
            {image.state === 'ready' && 'The workspace template is ready'}
            {image.state === 'building' && 'Building the workspace template. This takes a few minutes the first time.'}
            {image.state === 'unknown' && 'Checking for the workspace template'}
            {image.state === 'error' && `The workspace template failed to build: ${image.error}`}
          </SetupRow>
        )}
        <SetupRow
          state={claudeReady ? 'done' : 'todo'}
          action={!claudeReady && signIn('claude', nextIsSignIn)}
        >
          {claudeReady ? 'Claude is signed in' : codexReady ? 'Sign in to Claude (optional)' : 'Sign in to Claude'}
        </SetupRow>
        <SetupRow
          state={codexReady ? 'done' : 'todo'}
          action={!codexReady && signIn('codex', false)}
        >
          {codexReady ? 'Codex is signed in' : claudeReady ? 'Sign in to Codex (optional)' : 'Or sign in to Codex'}
        </SetupRow>
        <SetupRow
          state={projects.length > 0 ? 'done' : 'todo'}
          action={projects.length === 0 && <button type="button" className={`button button-small ${nextIsSignIn ? '' : 'button-primary'}`} onClick={() => setAddProjectOpen(true)}>Add a project</button>}
        >
          {projects.length > 0 ? 'A project is ready' : 'Add your first project'}
        </SetupRow>
      </ul>
    </section>
  );
}

function WorkspaceLine({ workspace }: { workspace: Workspace }) {
  const project = useStore((store) => store.projects.find((entry) => entry.id === workspace.projectId));
  const running = useStore((store) => store.sessions.some((session) => session.workspaceId === workspace.id && session.status === 'running'));
  const diff = workspace.diff;
  return (
    <Link to={`/w/${workspace.id}`} className="home-row">
      <span className="home-row-icon">{running || workspace.status === 'creating' ? <Spinner size={14} /> : <GitBranch size={15} />}</span>
      <span className="home-row-main">
        <span className="home-row-title">{workspace.title ?? workspace.name}</span>
        <span className="home-row-detail">{project?.name} / {workspace.name}</span>
      </span>
      {diff && diff.files > 0 && (
        <span className="diff-badge"><span className="added">+{compactNumber(diff.added)}</span><span className="removed">-{compactNumber(diff.removed)}</span></span>
      )}
      <span className="home-row-time">{running ? 'Working' : workspace.status === 'stopped' ? 'Stopped' : timeAgo(workspace.updatedAt)}</span>
    </Link>
  );
}

export function Home() {
  const workspaces = useStore((store) => store.workspaces);
  const projects = useStore((store) => store.projects);
  const setAddProjectOpen = useStore((store) => store.setAddProjectOpen);
  const { sidebarOpen, toggleSidebar } = useLayout();
  const navigate = useNavigate();
  const recent = workspaces
    .filter((workspace) => workspace.status !== 'archived')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);

  const create = async (projectId: string) => {
    const created = await attempt(() => api.createWorkspace(projectId));
    if (created) navigate(`/w/${created.workspace.id}`);
  };

  return (
    <div className="page">
      {!sidebarOpen && <div className="page-toolbar"><IconButton label="Show the sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton></div>}
      <div className="page-column">
        <h1 className="home-title">Lonca</h1>
        <p className="home-lede">Run coding agents side by side. Each workspace gets its own branch and its own virtual machine.</p>
        <Setup />
        {recent.length > 0 && (
          <section className="home-section">
            <h2>Recent workspaces</h2>
            <div className="home-list">
              {recent.map((workspace) => <WorkspaceLine key={workspace.id} workspace={workspace} />)}
            </div>
          </section>
        )}
        {projects.length > 0 && (
          <section className="home-section">
            <h2>Projects</h2>
            <div className="home-list">
              {projects.map((project) => (
                <div className="home-row" key={project.id}>
                  <Avatar owner={project.githubOwner} name={project.name} size={18} />
                  <Link to={`/projects/${project.id}`} className="home-row-main">
                    <span className="home-row-title">{project.name}</span>
                    <span className="home-row-detail">{project.remoteUrl ?? project.localPath}</span>
                  </Link>
                  <button type="button" className="button button-small" disabled={project.status !== 'ready'} onClick={() => void create(project.id)}>
                    <Plus size={13} /> New workspace
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="link-button add-project-link" onClick={() => setAddProjectOpen(true)}><Plus size={13} /> Add a project</button>
          </section>
        )}
      </div>
    </div>
  );
}
