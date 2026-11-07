import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, MoreHorizontal, PanelLeft, Plus } from 'lucide-react';
import { isReady, profileName, profileStatus, profilesOf } from '../../../shared/profiles.ts';
import type { AgentId, AppSettings, Profile } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { CLAUDE_ACCOUNT_HINT } from '../components/LoginDialog.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import { PlaybookEditor } from '../components/PlaybookEditor.tsx';
import { DockerLoginDialog } from '../components/DockerLoginDialog.tsx';
import { ConfirmDialog, type ConfirmOptions, IconButton, Menu, Modal, Spinner } from '../components/ui.tsx';
import { useLayout } from '../layout.ts';
import { limitNote } from '../signins.ts';
import { attempt, signInBlocker, useStore } from '../store.ts';

const TERMS = 'Each provider’s terms decide how its accounts may be used, including limits. Lonca doesn’t check them for you.';

function RenameSignIn({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const [name, setName] = useState(profile.name);
  return (
    <Modal title="Rename sign-in" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          void attempt(() => api.updateProfile(profile.id, { name: name.trim() })).then((saved) => saved && onClose());
        }}
      >
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" autoFocus maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={!name.trim()}>Save name</button>
        </div>
      </form>
    </Modal>
  );
}

/** A second sign-in for a provider, which means naming both so they can be told apart. */
function AddSignIn({ agent, onClose }: { agent: AgentId; onClose: () => void }) {
  const catalog = useStore((store) => store.catalog);
  const profiles = useStore((store) => store.profiles);
  const system = useStore((store) => store.system);
  const setLoginProfile = useStore((store) => store.setLoginProfile);
  const provider = catalog[agent].label;
  const existing = profilesOf(profiles, agent);
  const unnamed = existing.length === 1 && !existing[0].name ? existing[0] : undefined;
  // Which one it is, in case there's no telling from here.
  const summary = unnamed && profileStatus(system, unnamed.id).summary;
  const [first, setFirst] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = name.trim() && (!unnamed || first.trim());
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    const created = await attempt(() => api.addProfile(agent, name.trim(), unnamed ? first.trim() : undefined));
    setBusy(false);
    if (!created) return;
    onClose();
    setLoginProfile(created.id);
  };
  return (
    <Modal title={`Add another ${provider} sign-in`} onClose={onClose}>
      <form onSubmit={add}>
        {unnamed && (
          <label className="field">
            <span className="field-label">Name for the one you have{summary ? ` (${summary.replace(/^./, (letter) => letter.toLowerCase())})` : ''}</span>
            <input className="input" autoFocus maxLength={40} placeholder="work" value={first} onChange={(event) => setFirst(event.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field-label">{unnamed ? 'Name for the new one' : 'Name'}</span>
          <input className="input" autoFocus={!unnamed} maxLength={40} placeholder="personal" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {agent === 'claude' && <p className="field-help">{CLAUDE_ACCOUNT_HINT}</p>}
        <p className="field-help">{TERMS}</p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={!ready || busy}>{busy ? <><Spinner size={12} /> Adding…</> : 'Add and sign in'}</button>
        </div>
      </form>
    </Modal>
  );
}

function SignInCard({ profile, several, isDefault }: { profile: Profile; several: boolean; isDefault: boolean }) {
  const status = useStore((store) => profileStatus(store.system, profile.id));
  const catalog = useStore((store) => store.catalog);
  const profiles = useStore((store) => store.profiles);
  const setLoginProfile = useStore((store) => store.setLoginProfile);
  const blocker = useStore((store) => signInBlocker(store.system));
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  // A click shows at once, rather than flicking back until the server's answer arrives.
  const [autoSwitch, setAutoSwitch] = useState<boolean | null>(null);
  useEffect(() => {
    if (autoSwitch === Boolean(profile.autoSwitch)) setAutoSwitch(null);
  }, [autoSwitch, profile.autoSwitch]);
  const provider = catalog[profile.agent].label;
  const name = several ? profileName(profile, catalog) : provider;
  const signedIn = isReady(status);
  const limit = limitNote(status);
  // Where its conversations go: the provider's default, which is the next one if this is it.
  const destination = profilesOf(profiles, profile.agent).find((entry) => entry.id !== profile.id);
  const remove = () => setConfirm({
    title: `Remove ${name}?`,
    body: `Lonca deletes this sign-in from this computer. Conversations on it move to ${profileName(isDefault ? destination : profilesOf(profiles, profile.agent)[0], catalog)}, and say so.`,
    action: 'Remove',
    danger: true,
    onConfirm: () => void attempt(() => api.removeProfile(profile.id)),
  });
  return (
    <div className="sign-in-card">
      <div className="settings-row">
        <div className="settings-row-text">
          <strong>{name}{several && isDefault && <span className="sign-in-tag">Default</span>}</strong>
          <span className={`settings-note ${status.rejected ? 'settings-note-error' : ''}`}>
            {signedIn && <><Check size={13} className="check-success" /> {status.summary ?? 'Signed in'}</>}
            {status.rejected && `${provider} stopped accepting this sign-in.`}
            {!status.signedIn && (blocker ?? 'Not signed in')}
            {status.signedIn && limit && <span className="sign-in-limit">{limit}</span>}
          </span>
        </div>
        {signedIn && <button type="button" className="button" onClick={() => void attempt(() => api.logout(profile.id))}>Sign out</button>}
        {status.rejected && <button type="button" className="button button-primary" onClick={() => setLoginProfile(profile.id)}>Sign in again</button>}
        {!status.signedIn && !blocker && <button type="button" className="button" onClick={() => setLoginProfile(profile.id)}>Sign in</button>}
        {several && (
          <Menu
            className="sign-in-menu"
            label={`${name} options`}
            align="right"
            trigger={<MoreHorizontal size={16} />}
            entries={[
              { label: 'Rename', onSelect: () => setRenaming(true) },
              ...(isDefault ? [] : [{ label: 'Make default', onSelect: () => void attempt(() => api.updateProfile(profile.id, { makeDefault: true })) }]),
              { label: 'Remove', danger: true, onSelect: remove },
            ]}
          />
        )}
      </div>
      {several && (
        <label className="sign-in-switch">
          <input
            type="checkbox"
            checked={autoSwitch ?? Boolean(profile.autoSwitch)}
            onChange={(event) => {
              const on = event.target.checked;
              setAutoSwitch(on);
              void attempt(() => api.updateProfile(profile.id, { autoSwitch: on })).then((saved) => {
                if (!saved) setAutoSwitch(null);
              });
            }}
          />
          <span>
            Move conversations here by themselves when another {provider} sign-in reaches its usage limit
            {status.usesKey && <span className="sign-in-switch-note">. This one is an API key, so that’s billed per token.</span>}
          </span>
        </label>
      )}
      {renaming && <RenameSignIn profile={profile} onClose={() => setRenaming(false)} />}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** A provider's sign-ins. With one, it looks as it did before there could be more. */
function ProviderSignIns({ agent }: { agent: AgentId }) {
  const all = useStore((store) => store.profiles);
  const label = useStore((store) => store.catalog[agent].label);
  const profiles = profilesOf(all, agent);
  const [adding, setAdding] = useState(false);
  const several = profiles.length > 1;
  return (
    <div className={`sign-in-group ${several ? 'sign-in-group-several' : ''}`} role="group" aria-label={`${label} sign-ins`}>
      {profiles.map((profile, index) => <SignInCard key={profile.id} profile={profile} several={several} isDefault={index === 0} />)}
      <button type="button" className="link-button add-sign-in" onClick={() => setAdding(true)}><Plus size={13} /> Add another {label} sign-in</button>
      {adding && <AddSignIn agent={agent} onClose={() => setAdding(false)} />}
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

function SignOutWarning() {
  return (
    <div className="close-body">
      <p>This signs Docker Sandboxes out on this whole computer, not just in Lonca. <code>sbx</code> in your terminal is signed out too.</p>
      <p className="close-warning">It also stops every sandbox running on this computer: all of Lonca’s workspaces, any agents working in them, and sandboxes that aren’t Lonca’s.</p>
      <p>Workspaces can’t run again until you sign back in. Their files and conversations are kept.</p>
    </div>
  );
}

function IsolationCard() {
  const sandbox = useStore((store) => store.system.sandbox);
  const lowDisk = useStore((store) => store.system.lowDisk);
  // A sign-in carries on through a page reload, so its window comes back with it.
  const [signingIn, setSigningIn] = useState(() => {
    const phase = useStore.getState().system.dockerLogin?.phase;
    return phase === 'starting' || phase === 'waiting' || phase === 'checking';
  });
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [checking, setChecking] = useState(false);
  const ready = sandbox.state === 'ready';
  const check = () => {
    setChecking(true);
    void attempt(() => api.checkSandboxes()).finally(() => setChecking(false));
  };
  const signOut = () => {
    setSigningOut(true);
    void attempt(() => api.signOutOfDocker()).finally(() => setSigningOut(false));
  };
  const closeSignIn = useCallback(() => setSigningIn(false), []);
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
        {sandbox.state === 'signed-out' && (
          <button type="button" className="button button-primary" onClick={() => setSigningIn(true)}>Sign in to Docker</button>
        )}
        {!ready && sandbox.state !== 'unsupported' && sandbox.state !== 'signed-out' && (
          <button type="button" className="button" disabled={checking} onClick={check}>{checking ? <><Spinner size={12} /> Checking…</> : 'Check again'}</button>
        )}
        {ready && (
          <button type="button" className="button" disabled={signingOut} onClick={() => setConfirmSignOut(true)}>
            {signingOut ? <><Spinner size={12} /> Signing out…</> : 'Sign out of Docker'}
          </button>
        )}
      </div>
      {lowDisk && (
        <p className="field-help field-warning">
          {lowDisk.freeGb < 1 ? 'Less than 1 GB is' : `Only ${lowDisk.freeGb} GB is`} left on this computer’s disk. If it fills up, virtual machines’ disks can turn read-only and agents fail in confusing ways. Archive workspaces you aren’t using to get space back.
        </p>
      )}
      {sandbox.state === 'not-installed' && (sandbox.install
        ? <><p className="field-help">To install it, run this in a terminal, then check again:</p><pre className="isolation-command">{sandbox.install}</pre></>
        : <p className="field-help"><a href={SANDBOX_DOCS} target="_blank" rel="noreferrer">Install Docker Sandboxes</a>, then check again.</p>)}
      {sandbox.state === 'signed-out' && <p className="field-help">Docker Sandboxes needs a Docker account. Signing in here also signs in <code>sbx</code> in your terminal, since it’s one login for this computer.</p>}
      {ready && sandbox.sshAgentForwarding && (
        <p className="field-help">
          Lonca keeps your SSH keys out of its virtual machines. On Docker Sandboxes 0.50, running <code>sbx exec</code> on one from a terminal lends it your keys until Lonca next runs a command there. To rule that out on any version, run <code>sbx settings set ssh.agentForwardingEnabled false</code> and <code>sbx daemon restart</code>.
        </p>
      )}
      {signingIn && <DockerLoginDialog onClose={closeSignIn} />}
      {confirmSignOut && (
        <ConfirmDialog title="Sign out of Docker?" body={<SignOutWarning />} action="Sign out of Docker" danger focusCancel onConfirm={signOut} onClose={() => setConfirmSignOut(false)} />
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
          <span className="settings-note">How many agents a Lead can have working at the same time. Each uses the limits of the sign-in it runs on.</span>
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
  const several = useStore((store) => profilesOf(store.profiles, 'claude').length > 1 || profilesOf(store.profiles, 'codex').length > 1);
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
          <ProviderSignIns agent="claude" />
          <ProviderSignIns agent="codex" />
          <p className="field-help">Sign in once and every workspace can use the agent. Your logins on this computer are left alone.</p>
          {several && <p className="field-help">{TERMS}</p>}
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
