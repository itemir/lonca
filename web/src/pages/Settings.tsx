import { useRef, useState } from 'react';
import { Check, PanelLeft } from 'lucide-react';
import type { AgentId, AppSettings } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ModelPicker } from '../components/ModelPicker.tsx';
import { PlaybookEditor } from '../components/PlaybookEditor.tsx';
import { IconButton, Spinner } from '../components/ui.tsx';
import { useLayout } from '../layout.ts';
import { attempt, signInBlocker, useStore } from '../store.ts';

function AgentCard({ agent, name }: { agent: AgentId; name: string }) {
  const status = useStore((store) => store.system.agents[agent]);
  const setLoginAgent = useStore((store) => store.setLoginAgent);
  const blocker = useStore((store) => signInBlocker(store.system));
  const signedIn = status.signedIn && !status.rejected;
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <strong>{name}</strong>
        <span className={`settings-note ${status.rejected ? 'settings-note-error' : ''}`}>
          {signedIn && <><Check size={13} className="check-success" /> {status.summary ?? 'Signed in'}</>}
          {status.rejected && `${name} stopped accepting this sign-in.`}
          {!status.signedIn && (blocker ?? 'Not signed in')}
        </span>
      </div>
      {signedIn && <button type="button" className="button" onClick={() => void attempt(() => api.logout(agent))}>Sign out</button>}
      {status.rejected && <button type="button" className="button button-primary" onClick={() => setLoginAgent(agent)}>Sign in again</button>}
      {!status.signedIn && !blocker && <button type="button" className="button" onClick={() => setLoginAgent(agent)}>Sign in</button>}
    </div>
  );
}

function GithubCard() {
  const token = useStore((store) => store.secrets.githubToken);
  const [pasting, setPasting] = useState(false);
  const [value, setValue] = useState('');
  return (
    <div className="settings-block">
      <div className="settings-row">
        <div className="settings-row-text">
          <strong>GitHub</strong>
          <span className="settings-note">
            {token ? <><Check size={13} className="check-success" /> Connected with a token ending in {token.replace(/•/g, '')}</> : 'Lets agents fetch private repositories, push branches and open pull requests.'}
          </span>
        </div>
        {token
          ? <button type="button" className="button" onClick={() => void attempt(() => api.saveGithubToken(''))}>Disconnect</button>
          : <button type="button" className="button" onClick={() => void attempt(() => api.importGithubToken())}>Use my gh login</button>}
      </div>
      {!token && !pasting && <button type="button" className="link-button" onClick={() => setPasting(true)}>Use a token instead</button>}
      {!token && pasting && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) void attempt(() => api.saveGithubToken(value)).then(() => setValue(''));
          }}
        >
          <label className="field">
            <span className="field-label">GitHub token</span>
            <div className="input-row">
              <input className="input input-mono" type="password" autoComplete="off" autoFocus placeholder="github_pat_…" value={value} onChange={(event) => setValue(event.target.value)} />
              <button type="submit" className="button" disabled={!value.trim()}>Save token</button>
            </div>
          </label>
        </form>
      )}
      <p className="field-help">The token stays on this computer, and is added to requests as they leave a virtual machine. Anything running in one can still use it on GitHub, so a fine-grained token limited to the repositories you use here is the safer choice.</p>
    </div>
  );
}

const SANDBOX_DOCS = 'https://docs.docker.com/ai/sandboxes/';

function IsolationCard() {
  const sandbox = useStore((store) => store.system.sandbox);
  const [checking, setChecking] = useState(false);
  const ready = sandbox.state === 'ready';
  const check = () => {
    setChecking(true);
    void attempt(() => api.checkSandboxes()).finally(() => setChecking(false));
  };
  return (
    <div className="settings-block">
      <div className="settings-row">
        <div className="settings-row-text">
          <strong>Virtual machines</strong>
          <span className="settings-note">
            {ready && <><Check size={13} className="check-success" /> Each new workspace gets its own virtual machine, using Docker Sandboxes {sandbox.version}</>}
            {sandbox.state === 'checking' && 'Checking for Docker Sandboxes…'}
            {sandbox.state === 'not-installed' && 'Workspaces run in virtual machines from Docker Sandboxes, which isn’t installed.'}
            {sandbox.state === 'signed-out' && 'Docker Sandboxes isn’t signed in, so workspaces can’t run.'}
            {sandbox.state === 'unsupported' && `Workspaces can’t run on this computer. ${sandbox.detail}`}
            {sandbox.state === 'unavailable' && `Docker Sandboxes isn’t working, so workspaces can’t run: ${sandbox.detail}`}
          </span>
        </div>
        {!ready && sandbox.state !== 'unsupported' && (
          <button type="button" className="button" disabled={checking} onClick={check}>{checking ? <><Spinner size={12} /> Checking…</> : 'Check again'}</button>
        )}
      </div>
      {sandbox.state === 'not-installed' && (sandbox.install
        ? <><p className="field-help">To install it, run this in a terminal, then check again:</p><pre className="isolation-command">{sandbox.install}</pre></>
        : <p className="field-help"><a href={SANDBOX_DOCS} target="_blank" rel="noreferrer">Install Docker Sandboxes</a>, then check again.</p>)}
      {sandbox.state === 'signed-out' && <p className="field-help">Run <code>sbx login</code> in a terminal, then check again.</p>}
      {ready && sandbox.sshAgentForwarding && (
        <p className="field-help">
          Lonca keeps your SSH keys out of its virtual machines. On Docker Sandboxes 0.50, running <code>sbx exec</code> on one from a terminal lends it your keys until Lonca next runs a command there. To rule that out on any version, run <code>sbx settings set ssh.agentForwardingEnabled false</code> and <code>sbx daemon restart</code>.
        </p>
      )}
    </div>
  );
}

function ImageCard() {
  const image = useStore((store) => store.system.image);
  return (
    <div className="settings-block">
      <div className="settings-row">
        <div className="settings-row-text">
          <strong>Workspace template</strong>
          <span className="settings-note">
            {image.state === 'ready' && <code>{image.tag}</code>}
            {image.state === 'building' && <><Spinner size={12} /> Building…</>}
            {image.state === 'error' && `The last build failed: ${image.error}`}
            {image.state === 'unknown' && 'Checking…'}
          </span>
        </div>
        <button type="button" className="button" disabled={image.state === 'building'} onClick={() => void attempt(() => api.rebuildImage())}>Update agent CLIs</button>
      </div>
      <p className="field-help">Rebuilding installs the latest Claude Code and Codex. Existing workspaces move to the new template when you rebuild them.</p>
      {image.log && <pre className="build-log">{image.log.split('\n').slice(-30).join('\n')}</pre>}
    </div>
  );
}

function LeadSettings() {
  const settings = useStore((store) => store.settings);
  const catalog = useStore((store) => store.catalog);
  const [editing, setEditing] = useState(false);
  return (
    <section className="settings-section">
      <h2>Lead</h2>
      <div className="settings-row">
        <div className="settings-row-text">
          <strong>Default model</strong>
          <span className="settings-note">Each new workspace’s Lead starts on this. You can change it until the first message, then it stays for that workspace.</span>
        </div>
        <ModelPicker catalog={catalog} value={settings.leadDefault} up={false} right onChange={(leadDefault) => void attempt(() => api.updateSettings({ leadDefault }))} />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <strong>Agents at once</strong>
          <span className="settings-note">How many agents a Lead can have working at the same time. They all use your limits.</span>
        </div>
        <select className="input settings-select" aria-label="Agents at once" value={settings.leadMaxAgents} onChange={(event) => void attempt(() => api.updateSettings({ leadMaxAgents: Number(event.target.value) }))}>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <strong>Notifications</strong>
          <span className="settings-note">Tell this computer when a Lead needs you and you aren’t looking at Lonca.</span>
        </div>
        <button type="button" className="button" role="switch" aria-checked={settings.notifications} onClick={() => void attempt(() => api.updateSettings({ notifications: !settings.notifications }))}>
          {settings.notifications ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <div className="settings-block">
        <div className="settings-row">
          <div className="settings-row-text">
            <strong>Playbook</strong>
            <span className="settings-note">Instructions every Lead follows, in Markdown. A project can have its own.</span>
          </div>
          <button type="button" className="button" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{editing ? 'Hide playbook' : 'Edit playbook'}</button>
        </div>
        {editing && <PlaybookEditor />}
      </div>
    </section>
  );
}

export function Settings() {
  const settings = useStore((store) => store.settings);
  const { sidebarOpen, toggleSidebar } = useLayout();
  type Field = 'branchPrefix' | 'gitName' | 'gitEmail';
  const [drafts, setDrafts] = useState<Partial<Pick<AppSettings, Field>>>({});
  const pendingSaves = useRef<Partial<Record<Field, Promise<void>>>>({});
  const form = { ...settings, ...drafts };

  const updateField = (key: Field, value: string) => setDrafts((current) => ({ ...current, [key]: value }));
  const saveField = (key: Field) => {
    const value = drafts[key];
    if (value === undefined) return;
    // Keep saves to the same field in order, while other fields can save independently.
    const pending = (pendingSaves.current[key] ?? Promise.resolve()).then(async () => {
      const saved = await attempt(() => api.updateSettings({ [key]: value }));
      if (saved) setDrafts((current) => {
        if (current[key] !== value || pendingSaves.current[key] !== pending) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    });
    pendingSaves.current[key] = pending;
  };

  return (
    <div className="page">
      {!sidebarOpen && <div className="page-toolbar"><IconButton label="Show the sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton></div>}
      <div className="page-column">
        <h1 className="page-title">Settings</h1>
        <section className="settings-section">
          <h2>Sign-ins</h2>
          <AgentCard agent="claude" name="Claude" />
          <AgentCard agent="codex" name="Codex" />
          <p className="field-help">Sign in once and every workspace can use the agent. Your logins on this computer are left alone.</p>
        </section>
        <LeadSettings />
        <section className="settings-section">
          <h2>Integrations</h2>
          <GithubCard />
        </section>
        <section className="settings-section">
          <h2>Commits and branches</h2>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Commit author name</span>
              <input className="input" value={form.gitName} onChange={(event) => updateField('gitName', event.target.value)} onBlur={() => void saveField('gitName')} />
            </label>
            <label className="field">
              <span className="field-label">Commit author email</span>
              <input className="input" value={form.gitEmail} onChange={(event) => updateField('gitEmail', event.target.value)} onBlur={() => void saveField('gitEmail')} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Branch prefix</span>
            <input className="input input-mono" value={form.branchPrefix} onChange={(event) => updateField('branchPrefix', event.target.value)} onBlur={() => void saveField('branchPrefix')} />
          </label>
          <p className="field-help">New workspaces branch as {form.branchPrefix ? `${form.branchPrefix}/` : ''}city-name.</p>
        </section>
        <section className="settings-section">
          <h2>Isolation</h2>
          <IsolationCard />
          <ImageCard />
        </section>
      </div>
    </div>
  );
}
