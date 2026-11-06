import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUp, PanelLeft } from 'lucide-react';
import { api } from '../api.ts';
import { type ModelChoice, ModelPicker } from '../components/ModelPicker.tsx';
import { IconButton } from '../components/ui.tsx';
import { useLayout } from '../layout.ts';
import { attempt, useStore } from '../store.ts';

export function Create() {
  const projects = useStore((store) => store.projects);
  const catalog = useStore((store) => store.catalog);
  const settings = useStore((store) => store.settings);
  const setAddProjectOpen = useStore((store) => store.setAddProjectOpen);
  const { sidebarOpen, toggleSidebar } = useLayout();
  const navigate = useNavigate();
  const ready = projects.filter((project) => project.status === 'ready');
  const [projectId, setProjectId] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<ModelChoice>(settings.leadDefault);

  const project = ready.find((entry) => entry.id === projectId) ?? ready[0];

  useEffect(() => {
    if (!project) return;
    setBranch(project.settings.defaultBranch);
    api.branches(project.id).then(setBranches, () => setBranches([]));
  }, [project?.id]);

  const create = async () => {
    if (!project) return;
    setBusy(true);
    const created = await attempt(() => api.createWorkspace(project.id, { baseBranch: branch, prompt, ...choice }));
    setBusy(false);
    if (created) navigate(`/w/${created.workspace.id}`);
  };

  return (
    <div className="page">
      {!sidebarOpen && <div className="page-toolbar"><IconButton label="Show the sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton></div>}
      <div className="page-column">
        <h1 className="page-title">New workspace</h1>
        {!project ? (
          <div className="empty-card">
            <p>Add a project first. Workspaces are branches of a project’s repository.</p>
            <button type="button" className="button button-primary" onClick={() => setAddProjectOpen(true)}>Add a project</button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="field-row">
              <label className="field">
                <span className="field-label">Project</span>
                <select className="input" value={project.id} onChange={(event) => setProjectId(event.target.value)}>
                  {ready.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Start from</span>
                <select className="input" value={branch} onChange={(event) => setBranch(event.target.value)}>
                  {!branches.includes(branch) && <option value={branch}>origin/{branch}</option>}
                  {branches.map((entry) => <option key={entry} value={entry}>origin/{entry}</option>)}
                </select>
              </label>
            </div>
            <div className="composer create-composer">
              <textarea
                className="composer-input"
                aria-label="First message (optional)"
                rows={5}
                autoFocus
                value={prompt}
                placeholder="What should the Lead work on? You can also leave this empty and write it later."
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void create();
                }}
              />
              <div className="composer-bar">
                <ModelPicker catalog={catalog} value={choice} onChange={setChoice} up={false} />
                <span className="field-help create-help">The Lead’s model. It locks when you send the first message.</span>
                <span className="spacer" />
                <button type="submit" className="send-button" aria-label="Create workspace" title="Create workspace" disabled={busy}>
                  <ArrowUp size={17} strokeWidth={2.4} />
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
