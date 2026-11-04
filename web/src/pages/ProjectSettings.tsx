import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PanelLeft, Plus, Trash2 } from 'lucide-react';
import type { ProjectSettings as Settings } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ConfirmDialog, IconButton } from '../components/ui.tsx';
import { useLayout } from '../layout.ts';
import { attempt, useStore } from '../store.ts';

export function ProjectSettings() {
  const { id = '' } = useParams();
  const project = useStore((store) => store.projects.find((entry) => entry.id === id));
  const allWorkspaces = useStore((store) => store.workspaces);
  const workspaces = allWorkspaces.filter((workspace) => workspace.projectId === id);
  const toast = useStore((store) => store.toast);
  const { sidebarOpen, toggleSidebar } = useLayout();
  const navigate = useNavigate();
  const [form, setForm] = useState<Settings | null>(project?.settings ?? null);
  const [envRows, setEnvRows] = useState<[string, string][]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!project) return;
    setForm(project.settings);
    setEnvRows(Object.entries(project.settings.env));
    api.branches(project.id).then(setBranches, () => setBranches([]));
  }, [project?.id]);

  if (!project || !form) return <div className="tab-message">This project no longer exists.</div>;

  const update = (patch: Partial<Settings>) => setForm({ ...form, ...patch });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const env = Object.fromEntries(envRows.filter(([key]) => key.trim()).map(([key, value]) => [key.trim(), value]));
    const saved = await attempt(() => api.updateProject(project.id, { settings: { ...form, env } }));
    if (saved) {
      const needsRebuild = saved.settings.network !== project.settings.network
        || saved.settings.image !== project.settings.image
        || saved.settings.memoryGb !== project.settings.memoryGb
        || saved.settings.cpus !== project.settings.cpus;
      const running = workspaces.some((workspace) => workspace.status === 'ready' || workspace.status === 'stopped');
      toast(needsRebuild && running
        ? 'Saved. Rebuild a workspace from its menu to apply the isolation settings to it.'
        : 'Saved.');
    }
  };

  return (
    <div className="page">
      {!sidebarOpen && <div className="page-toolbar"><IconButton label="Show the sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton></div>}
      <form className="page-column" onSubmit={save}>
        <h1 className="page-title">{project.name}</h1>
        <p className="page-subtitle">{project.remoteUrl ?? project.localPath}</p>

        <section className="settings-section">
          <h2>New workspaces</h2>
          <label className="field">
            <span className="field-label">Branch workspaces from</span>
            <select className="input" value={form.defaultBranch} onChange={(event) => update({ defaultBranch: event.target.value })}>
              {!branches.includes(form.defaultBranch) && <option value={form.defaultBranch}>origin/{form.defaultBranch}</option>}
              {branches.map((branch) => <option key={branch} value={branch}>origin/{branch}</option>)}
            </select>
          </label>
          {project.localPath && (
            <label className="field">
              <span className="field-label">Files to copy from your checkout</span>
              <input className="input input-mono" value={form.filesToCopy.join(', ')} onChange={(event) => update({ filesToCopy: event.target.value.split(',').map((glob) => glob.trim()).filter(Boolean) })} />
              <span className="field-help">Comma-separated patterns for files git ignores, such as .env*. Off by default: these files often hold secrets, and agents can read and send whatever is in their workspace.</span>
            </label>
          )}
        </section>

        <section className="settings-section">
          <h2>Scripts</h2>
          <label className="field">
            <span className="field-label">Setup script</span>
            <textarea className="input input-mono" rows={4} placeholder="npm install" value={form.setupScript} onChange={(event) => update({ setupScript: event.target.value })} />
            <span className="field-help">Runs in the workspace when it’s created. Output is in the Setup tab.</span>
          </label>
          <label className="field">
            <span className="field-label">Run script</span>
            <textarea className="input input-mono" rows={3} placeholder="npm run dev -- --host 0.0.0.0 --port $LONCA_PORT" value={form.runScript} onChange={(event) => update({ runScript: event.target.value })} />
            <span className="field-help">Started from the Run tab. Each workspace publishes ten ports on localhost, starting at $LONCA_PORT. Servers must listen on 0.0.0.0.</span>
          </label>
        </section>

        <section className="settings-section">
          <h2>Isolation</h2>
          <div className="field">
            <span className="field-label">Network access</span>
            <label className="radio">
              <input type="radio" name="network" checked={form.network === 'internet'} onChange={() => update({ network: 'internet' })} />
              <span><strong>Internet only</strong><span className="field-help">Blocks this computer, your local network and other workspaces.</span></span>
            </label>
            <label className="radio">
              <input type="radio" name="network" checked={form.network === 'host'} onChange={() => update({ network: 'host' })} />
              <span><strong>Internet and this computer</strong><span className="field-help">Agents can reach services on this computer at host.docker.internal, including ports published by other workspaces, and anything on your local network.</span></span>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Memory limit (GB)</span>
              <input className="input" type="number" min="0" step="0.5" value={form.memoryGb || ''} placeholder="No limit" onChange={(event) => update({ memoryGb: Number(event.target.value) })} />
            </label>
            <label className="field">
              <span className="field-label">CPU limit</span>
              <input className="input" type="number" min="0" step="0.5" value={form.cpus || ''} placeholder="No limit" onChange={(event) => update({ cpus: Number(event.target.value) })} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Custom image</span>
            <input className="input input-mono" value={form.image} placeholder="Default Lonca image" onChange={(event) => update({ image: event.target.value })} />
            <span className="field-help">To add toolchains, build an image FROM the Lonca workspace image, whose tag is in Settings, and enter its tag here.</span>
          </label>
          <div className="field">
            <span className="field-label">Environment variables</span>
            {envRows.map(([key, value], index) => (
              <div className="input-row env-row" key={index}>
                <input className="input input-mono" aria-label="Variable name" placeholder="NAME" value={key} onChange={(event) => setEnvRows(envRows.map((row, row2) => (row2 === index ? [event.target.value, row[1]] : row)))} />
                <input className="input input-mono" aria-label="Variable value" placeholder="value" value={value} onChange={(event) => setEnvRows(envRows.map((row, row2) => (row2 === index ? [row[0], event.target.value] : row)))} />
                <IconButton label="Remove this variable" onClick={() => setEnvRows(envRows.filter((_, row2) => row2 !== index))}><Trash2 size={14} /></IconButton>
              </div>
            ))}
            <button type="button" className="link-button" onClick={() => setEnvRows([...envRows, ['', '']])}><Plus size={13} /> Add a variable</button>
          </div>
        </section>

        <div className="page-actions">
          <button type="submit" className="button button-primary">Save changes</button>
          <span className="spacer" />
          <button type="button" className="button button-danger" onClick={() => setConfirmRemove(true)}>Remove project</button>
        </div>
      </form>
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${project.name}?`}
          body={`This deletes its ${workspaces.length === 1 ? 'workspace' : `${workspaces.length} workspaces`} and any commits that were never pushed.${project.localPath ? ` Your checkout at ${project.localPath} isn’t touched.` : ''}`}
          action="Remove project"
          danger
          onConfirm={async () => {
            navigate('/');
            await attempt(() => api.removeProject(project.id));
          }}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}
