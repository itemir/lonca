import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { agentOfProfileId, hasSeveral, profileName, profileStatus } from '../../../shared/profiles.ts';
import type { AgentId, LoginFailure, LoginMethod, LoginState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { safeUrl } from '../format.ts';
import { useIsPhone } from '../hooks.ts';
import { useStore } from '../store.ts';
import { Modal, Spinner } from './ui.tsx';

/** Before a second Claude sign-in, since the page signs in whoever the browser already is. */
export const CLAUDE_ACCOUNT_HINT = 'Claude signs in with the account your browser is using on claude.ai. To add a different account, switch accounts there first, or open the sign-in page in a private window.';

const SUCCESS_HOLD_MS = 1500;

const CHATGPT_SECURITY = 'https://chatgpt.com/#settings/Security';

const KEY_PAGES: Record<AgentId, string> = {
  claude: 'https://console.anthropic.com/settings/keys',
  codex: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
};

const KEY_PREFIXES: Record<AgentId, string> = { claude: 'sk-ant-', codex: 'sk-', gemini: 'AIza' };

const KEY_LABELS: Record<AgentId, string> = { claude: 'API key or token', codex: 'OpenAI API key', gemini: 'Gemini API key' };

const ACCOUNT_LABELS: Record<AgentId, string> = { claude: 'Claude subscription', codex: 'ChatGPT account', gemini: 'Google account' };

/** Where the sign-in page is, before its link has come. */
const SIGN_IN_HOSTS: Record<AgentId, string> = { claude: 'claude.com', codex: 'auth.openai.com', gemini: 'accounts.google.com' };

/** Whose keys these are, in "That’s a key for another service. Claude keys start with sk-ant-." */
const KEY_OWNERS: Record<AgentId, string> = { claude: 'Claude', codex: 'OpenAI', gemini: 'Gemini' };

/** A sign-in of its own that doesn't need the page to come back to this computer. Claude's code to paste is part of its browser's. */
const OTHER_WAYS: Partial<Record<AgentId, { method: LoginMethod; button: string; link: string }>> = {
  codex: { method: 'device', button: 'Use a one-time code', link: 'use a one-time code instead' },
  gemini: { method: 'code', button: 'Paste a code instead', link: 'paste a code instead' },
};

/** Which agent a key is for, going by how it starts. */
function keyOwner(value: string): AgentId | null {
  if (value.startsWith('sk-ant-')) return 'claude';
  if (value.startsWith('sk-')) return 'codex';
  if (value.startsWith('AIza')) return 'gemini';
  return null;
}

const anotherServiceKey = (agent: AgentId) => `That’s a key for another service. ${KEY_OWNERS[agent]} keys start with ${KEY_PREFIXES[agent]}.`;

interface FailureCopy {
  text: string;
  action: string;
  /** Nothing explains this but what the CLI printed, so show it straight away. */
  showOutput?: boolean;
  /** Trying again won't help until this has been dealt with. */
  turnOn?: { label: string; href: string };
  /** The other way in doesn't need the browser to get back. */
  offerCode?: boolean;
  /** Another account may do, or a key. */
  offerKey?: boolean;
}

function failureCopy(failure: LoginFailure | undefined, name: string, agent: AgentId, message?: string): FailureCopy {
  switch (failure) {
    case 'rejected':
      return { text: `${name} didn’t accept that sign-in. It may have expired or already been used.`, action: 'Start again' };
    case 'expired':
      return { text: 'That sign-in has expired.', action: 'Start again' };
    case 'disabled':
      return {
        text: 'Device code login is turned off for your ChatGPT account. Turn it on in ChatGPT under Settings > Security. On a work account, an admin has to do this.',
        action: 'Try again',
        turnOn: { label: 'Open ChatGPT settings', href: CHATGPT_SECURITY },
      };
    case 'denied':
      // Gemini's says why an account can't use it.
      if (message) {
        return {
          text: `${name} won’t take this account. ${message} To use another, choose it on Google’s page, or open the sign-in page in a private window.`,
          action: 'Try another account',
          offerKey: true,
        };
      }
      return { text: 'The sign-in page didn’t approve this. If you cancelled it there, you can try again.', action: 'Try again' };
    case 'no-link':
      return { text: `Lonca couldn’t get a sign-in link from ${name}.`, action: 'Try again', showOutput: true };
    case 'save-failed':
      return { text: `${name} approved the sign-in, but Lonca couldn’t finish it${message ? `: ${message}` : '.'}`, action: 'Try again', showOutput: true };
    case 'unavailable':
      return { text: `Lonca couldn’t start the sign-in${message ? `: ${message}` : '.'}`, action: 'Try again' };
    case 'port-busy':
      return {
        text: agent === 'gemini'
          // Each try has a port of its own.
          ? `The sign-in page comes back to port ${message} on this computer, and something else took it. Try again, or paste a code instead.`
          : `The sign-in page comes back to port ${message} on this computer, and something else is using it. Close that and try again, or use a one-time code.`,
        action: 'Try again',
        offerCode: true,
      };
    default:
      return { text: 'Sign-in stopped before it finished.', action: 'Try again', showOutput: true };
  }
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    copied,
    (text) => {
      void navigator.clipboard.writeText(text).catch(() => {});
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), SUCCESS_HOLD_MS);
    },
  ];
}

function CopyLink({ url }: { url: string }) {
  const [copied, copy] = useCopied();
  return <button type="button" className="link-button" onClick={() => copy(url)}>{copied ? 'Copied' : 'Copy link'}</button>;
}

/** The sign-in page sends the browser back here by itself, as it does for the CLIs, so there's nothing to copy or type. */
function BrowserSteps({ login, otherWay, onOtherWay }: {
  login: LoginState | undefined;
  otherWay: string | null;
  onOtherWay: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const url = safeUrl(login?.url);
  const ending = login?.phase === 'submitting' || login?.phase === 'saving';
  return (
    <div className="login-browser">
      <div className="login-step-title">Approve access in your browser</div>
      {ending ? (
        <div className="login-waiting" role="status"><Spinner size={12} /> Finishing up…</div>
      ) : (
        <>
          <div className="login-actions">
            {url ? (
              <a
                className={`button ${opened ? '' : 'button-primary'}`}
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpened(true)}
              >
                {opened ? 'Open again' : 'Open sign-in page'}
              </a>
            ) : (
              <button type="button" className="button button-primary" disabled><Spinner size={12} /> Getting the link…</button>
            )}
            {url && <CopyLink url={url} />}
          </div>
          {opened
            ? <div className="login-waiting" role="status"><Spinner size={12} /> Waiting for you to approve. This window closes by itself.</div>
            : <p className="login-hint">This window closes by itself once you approve.</p>}
          {otherWay && <p className="login-hint">If the page can’t get back to this computer, <button type="button" className="link-button" onClick={onOtherWay}>{otherWay}</button>.</p>}
        </>
      )}
    </div>
  );
}

/** A page that shows a code, and where to paste it: Claude's, when its page can't come back, and Gemini's other way in. */
function PasteSteps({ profileId, agent, login, code, setCode, codeError, setCodeError, onUseAsKey }: {
  profileId: string;
  agent: AgentId;
  login: LoginState | undefined;
  code: string;
  setCode: (value: string) => void;
  codeError: string | null;
  setCodeError: (value: string | null) => void;
  onUseAsKey: (value: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const url = safeUrl(login?.pasteUrl);
  const working = login?.phase === 'submitting' || login?.phase === 'saving';
  const owner = keyOwner(code.trim());
  const looksLikeKey = owner !== null;
  const someOtherKey = looksLikeKey && owner !== agent;
  // Having a code in hand means the page has been dealt with, however it got here.
  const active = opened || working || Boolean(code.trim());
  // Pressing Continue again would only repeat the error. The way on is its link, or a new value.
  const stuck = looksLikeKey && Boolean(codeError);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim() || working) return;
    if (looksLikeKey) {
      setCodeError(someOtherKey ? anotherServiceKey(agent) : 'That’s a key, not a sign-in code.');
      input.current?.select();
      return;
    }
    setCodeError(null);
    try {
      await api.submitLoginCode(profileId, code);
    } catch (failure) {
      setCodeError((failure as Error).message);
      input.current?.select();
    }
  };

  return (
    <ol className="login-steps">
      <li className={`login-step ${active ? 'step-past' : 'step-now'}`}>
        <span className="login-step-number" aria-hidden="true">1</span>
        <div className="login-step-body">
          <div className="login-step-title">Approve access on {hostOf(url) || SIGN_IN_HOSTS[agent]}</div>
          <div className="login-actions">
            {url ? (
              <a
                className={`button ${active ? '' : 'button-primary'}`}
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  setOpened(true);
                  input.current?.focus();
                }}
              >
                {opened ? 'Open again' : 'Open sign-in page'}
              </a>
            ) : !working && (
              <button type="button" className="button button-primary" disabled><Spinner size={12} /> Getting the link…</button>
            )}
            {url && <CopyLink url={url} />}
          </div>
        </div>
      </li>
      <li className={`login-step ${active ? 'step-now' : 'step-next'}`}>
        <span className="login-step-number" aria-hidden="true">2</span>
        <div className="login-step-body">
          <div className="login-step-title">Paste the code you’re given</div>
          <form className="input-row" onSubmit={submit}>
            <input
              ref={input}
              className={`input input-mono ${codeError ? 'input-error' : ''}`}
              type={looksLikeKey ? 'password' : 'text'}
              aria-label="Sign-in code"
              aria-invalid={Boolean(codeError)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the code here"
              value={code}
              readOnly={working}
              onChange={(event) => {
                setCode(event.target.value);
                setCodeError(null);
              }}
            />
            <button type="submit" className={`button ${active && !stuck ? 'button-primary' : ''}`} disabled={!code.trim() || working || login?.phase !== 'waiting' || stuck}>
              {working ? <><Spinner size={12} /> Signing in…</> : 'Continue'}
            </button>
          </form>
          {codeError && (
            <p className="form-error" role="alert">
              {codeError}
              {looksLikeKey && !someOtherKey && <> <button type="button" className="link-button" onClick={() => onUseAsKey(code.trim())}>Use it as a key</button></>}
            </p>
          )}
        </div>
      </li>
    </ol>
  );
}

/** A one-time code to enter or check on a sign-in page, and the page, which the person goes to themselves. */
export function DeviceCodeSteps({ url: link, code, ending, title, hint, openLabel, copyOnOpen }: {
  url: string | undefined;
  code: string | undefined;
  /** Approved, and only the last of it is left. */
  ending: boolean;
  title: string;
  hint: (host: string) => string;
  openLabel: string;
  /** For a page where the code has to be typed in. */
  copyOnOpen: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [copied, copy] = useCopied();
  const url = safeUrl(link);
  return (
    <ol className="login-steps">
      <li className={`login-step ${opened || ending ? 'step-past' : 'step-now'}`}>
        <span className="login-step-number" aria-hidden="true">1</span>
        <div className="login-step-body">
          <div className="login-step-title">{title}</div>
          <div className="login-code-box">
            {code
              ? <><span className="login-code">{code}</span><button type="button" className="button button-small" onClick={() => copy(code)}>{copied ? 'Copied' : 'Copy'}</button></>
              : <span className="login-code-waiting">{ending ? 'Finishing up…' : 'Getting your code…'}</span>}
          </div>
          {url && <p className="login-hint">{hint(hostOf(url))}</p>}
          <div className="login-actions">
            {url && code ? (
              <a
                className={`button ${opened ? '' : 'button-primary'}`}
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  if (copyOnOpen) copy(code);
                  setOpened(true);
                }}
              >
                {opened ? 'Open again' : openLabel}
              </a>
            ) : (
              <button type="button" className="button button-primary" disabled>{openLabel}</button>
            )}
            {url && <CopyLink url={url} />}
          </div>
        </div>
      </li>
      <li className={`login-step ${opened || ending ? 'step-now' : 'step-next'}`}>
        <span className="login-step-number" aria-hidden="true">2</span>
        <div className="login-step-body">
          <div className="login-step-title">Approve in your browser</div>
          {opened || ending
            ? <div className="login-waiting" role="status"><Spinner size={12} /> Waiting for you to approve. This window closes by itself.</div>
            : <p className="login-hint">This window closes by itself once you approve.</p>}
        </div>
      </li>
    </ol>
  );
}

function CodexSteps({ login }: { login: LoginState | undefined }) {
  return (
    <DeviceCodeSteps
      url={login?.url}
      code={login?.code}
      ending={login?.phase === 'saving'}
      title="Enter this code on the sign-in page"
      hint={(host) => `Only enter it on ${host}, and only if you started this sign-in. It expires after a few minutes.`}
      openLabel="Copy code and open"
      copyOnOpen
    />
  );
}

function KeyForm({ profileId, agent, name, initial, canUseAsCode, onSaved, onCancel, onUseAsCode, onChecking }: {
  profileId: string;
  agent: AgentId;
  name: string;
  initial: string;
  /** There's a sign-in under way that's waiting for a code to be pasted. */
  canUseAsCode: boolean;
  onSaved: (verified: boolean) => void;
  onCancel: () => void;
  onUseAsCode: (value: string) => void;
  onChecking: (checking: boolean) => void;
}) {
  const isClaude = agent === 'claude';
  const prefix = KEY_PREFIXES[agent];
  const catalog = useStore((store) => store.catalog);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notAKey, setNotAKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();

  const refuse = (message: string) => {
    setNotAKey(true);
    setError(message);
    input.current?.select();
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed || checking) return;
    const owner = keyOwner(trimmed);
    if (isClaude && owner === 'codex') return refuse(anotherServiceKey(agent));
    if (owner && owner !== agent) return refuse(`That’s a key for ${catalog[owner].label}. Sign in to ${catalog[owner].label} with it instead.`);
    if (!trimmed.startsWith(prefix)) {
      return refuse(agent === 'codex'
        ? `That isn’t a key. Keys start with ${prefix}. A sign-in code goes in your browser.`
        : `That isn’t a key. Keys start with ${prefix}.`);
    }
    setChecking(true);
    onChecking(true);
    setError(null);
    setNotAKey(false);
    try {
      const { verified } = await api.saveKey(profileId, trimmed);
      onSaved(verified);
    } catch (failure) {
      setError((failure as Error).message);
      input.current?.select();
    } finally {
      setChecking(false);
      onChecking(false);
    }
  };

  return (
    <form onSubmit={save}>
      <label className="field login-key-field">
        <span className="field-label">{KEY_LABELS[agent]}</span>
        <input
          ref={input}
          className={`input input-mono ${error ? 'input-error' : ''}`}
          type="password"
          autoComplete="off"
          autoFocus
          aria-invalid={Boolean(error)}
          placeholder={`${prefix}…`}
          value={value}
          readOnly={checking}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
            setNotAKey(false);
          }}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
          {notAKey && canUseAsCode && !keyOwner(trimmed) && <> <button type="button" className="link-button" onClick={() => onUseAsCode(trimmed)}>Use it as the sign-in code</button></>}
        </p>
      )}
      <p className="login-hint login-key-help">
        {isClaude && <>An API key bills your Anthropic account directly, separately from any Claude subscription. A token from <code>claude setup-token</code> uses your subscription instead. </>}
        {agent === 'codex' && 'An API key bills your OpenAI account directly, separately from ChatGPT. '}
        {agent === 'gemini' && 'An API key bills its Google Cloud project, or uses its free tier, separately from any Google AI subscription. '}
        Lonca keeps it on this computer and gives it to every workspace.
      </p>
      <a className="link-button" href={KEY_PAGES[agent]} target="_blank" rel="noreferrer">Create an API key</a>
      <div className="modal-actions">
        <button type="button" className="button" disabled={checking} onClick={onCancel}>Cancel</button>
        <button type="submit" className={`button ${notAKey ? '' : 'button-primary'}`} disabled={!trimmed || checking || notAKey}>
          {checking ? <><Spinner size={12} /> Checking…</> : 'Save'}
        </button>
      </div>
      <span className="sr-only" role="status">{checking ? `Checking the key with ${name}` : ''}</span>
    </form>
  );
}

function LoginFlow({ profileId, agent }: { profileId: string; agent: AgentId }) {
  const latest = useStore((store) => store.logins[profileId]);
  // An attempt that ended before this window opened, perhaps in another tab, is none of its business.
  const [leftOver] = useState(() => (latest?.phase === 'failed' || latest?.phase === 'done' ? latest : null));
  const login = latest === leftOver ? undefined : latest;
  const status = useStore((store) => profileStatus(store.system, profileId));
  const applyEvent = useStore((store) => store.apply);
  const setLoginProfile = useStore((store) => store.setLoginProfile);
  const profile = useStore((store) => store.profiles.find((entry) => entry.id === profileId));
  const catalog = useStore((store) => store.catalog);
  const several = useStore((store) => hasSeveral(store.profiles, agent));
  const isClaude = agent === 'claude';
  const name = profile ? profileName(profile, catalog) : catalog[agent].label;
  // A phone is rarely the computer Lonca runs on, which the sign-in page comes back to.
  const phone = useIsPhone();
  const otherWay = OTHER_WAYS[agent];
  const [route, setRoute] = useState<'account' | 'key'>(status.rejected && status.usesKey ? 'key' : 'account');
  const [savedKey, setSavedKey] = useState<{ verified: boolean } | null>(null);
  const [pasting, setPasting] = useState(phone && isClaude);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [output, setOutput] = useState('');
  const [starting, setStarting] = useState(false);
  const [checkingKey, setCheckingKey] = useState(false);
  const started = useRef(false);
  const connected = useStore((store) => store.connected);
  const lostServer = useRef(false);
  if (!connected) lostServer.current = true;

  const start = useCallback((how: LoginMethod) => {
    started.current = true;
    setStarting(true);
    setStartFailure(null);
    setCode('');
    setCodeError(null);
    setOutputOpen(false);
    api.startLogin(profileId, how).then(
      (state) => applyEvent({ type: 'login', profileId, login: state }),
      (failure: Error) => setStartFailure(failure.message),
    ).finally(() => setStarting(false));
  }, [profileId, applyEvent]);

  useEffect(() => {
    if (route === 'account' && !started.current && !login) start(phone && otherWay ? otherWay.method : 'browser');
    if (login) started.current = true;
  }, [route, login, start, phone, otherWay]);

  // The page that comes back couldn't be offered, so the code is the way in.
  useEffect(() => {
    if (login?.pasteUrl && !login.url) setPasting(true);
  }, [login?.pasteUrl, login?.url]);

  const close = useCallback(() => {
    void api.cancelLogin(profileId).catch(() => {});
    setLoginProfile(null);
  }, [profileId, setLoginProfile]);

  const finished = login?.phase === 'done' || savedKey?.verified === true;
  // Signed in, but with something left to do, which mustn't vanish before it's been read.
  const needsProject = login?.phase === 'done' && login.needsProject === true;

  // Codex finishes while the person is on another tab, so the message waits for them to return.
  useEffect(() => {
    if (!finished || needsProject) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (!timer && document.visibilityState === 'visible') timer = setTimeout(close, SUCCESS_HOLD_MS);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [finished, needsProject, close]);

  const failed = login?.phase === 'failed';
  const missing = route === 'account' && started.current && !login && !startFailure && !starting;
  // A sign-in can't survive the server restarting. If that isn't what happened, another tab ended it.
  const interrupted = missing && lostServer.current;
  useEffect(() => {
    if (missing && !lostServer.current) setLoginProfile(null);
  }, [missing, setLoginProfile]);
  const failure = failed
    ? failureCopy(login.failure, name, agent, login.message)
    : startFailure
      ? failureCopy('unavailable', name, agent, startFailure)
      : interrupted
        ? { text: 'Lonca restarted during this sign-in.', action: 'Start again' }
        : null;
  const showOutput = outputOpen || Boolean(failed && failure?.showOutput);

  useEffect(() => {
    if (login?.output) setOutput(login.output);
  }, [login?.output]);

  const toggleOutput = () => {
    if (!showOutput && !login?.output) void api.loginOutput(profileId).then(setOutput, () => {});
    setOutputOpen(!showOutput);
  };

  if (needsProject) {
    return (
      <Modal title={`${name} is signed in`} onClose={close} closeOnBackdrop className="login-modal">
        <div className="login-done login-unchecked" role="status">
          <AlertTriangle size={15} />
          <div>
            <div>This account can only use Gemini through a Google Cloud project. To use it in a project here, add <code>GOOGLE_CLOUD_PROJECT</code> with the Cloud project’s ID to that project’s environment variables.</div>
            <div className="login-hint">{status.summary}</div>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-primary" onClick={close}>OK</button>
        </div>
      </Modal>
    );
  }

  if (finished) {
    return (
      <Modal title={`${name} is signed in`} onClose={close} closeOnBackdrop className="login-modal">
        <div className="login-done" role="status">
          <Check size={15} />
          <div>
            <div>Every workspace can use it now.</div>
            <div className="login-hint">{status.summary}</div>
          </div>
        </div>
      </Modal>
    );
  }

  // Saved, but saying "signed in" would be a guess, and it mustn't vanish before it's been read.
  if (savedKey) {
    return (
      <Modal title="Key saved, not checked yet" onClose={close} closeOnBackdrop className="login-modal">
        <div className="login-done login-unchecked" role="status">
          <AlertTriangle size={15} />
          <div>Lonca couldn’t check this key just now, so your first message will.</div>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-primary" onClick={close}>OK</button>
        </div>
      </Modal>
    );
  }

  return (
    // While a key is being checked it can still be saved, so closing wouldn't cancel anything.
    <Modal title={`Sign in to ${name}`} onClose={checkingKey ? () => {} : close} closeOnBackdrop={false} className="login-modal">
      <div className="segmented" role="tablist" aria-label={`How to sign in to ${name}`}>
        <button type="button" role="tab" aria-selected={route === 'account'} className={route === 'account' ? 'active' : ''} disabled={checkingKey} onClick={() => setRoute('account')}>
          {ACCOUNT_LABELS[agent]}
        </button>
        <button type="button" role="tab" aria-selected={route === 'key'} className={route === 'key' ? 'active' : ''} disabled={checkingKey} onClick={() => setRoute('key')}>
          API key
        </button>
      </div>
      {route === 'key' ? (
        <KeyForm
          key={keyDraft}
          profileId={profileId}
          agent={agent}
          name={name}
          initial={keyDraft}
          canUseAsCode={isClaude || (login?.method === 'code' && login.phase === 'waiting')}
          onSaved={(verified) => setSavedKey({ verified })}
          onChecking={setCheckingKey}
          onCancel={close}
          onUseAsCode={(value) => {
            setCode(value);
            setPasting(true);
            setRoute('account');
          }}
        />
      ) : (
        <>
          {failure ? (
            <div className="login-failure">
              <div className="notice notice-error" role="alert">
                <AlertTriangle size={15} />
                <span className="notice-text">{failure.text}</span>
              </div>
              <div className="login-failure-actions">
                {'turnOn' in failure && failure.turnOn && <a className="button button-primary" href={failure.turnOn.href} target="_blank" rel="noreferrer">{failure.turnOn.label}</a>}
                <button type="button" className={`button ${'turnOn' in failure && failure.turnOn ? '' : 'button-primary'}`} onClick={() => start(login?.method ?? 'browser')}>{failure.action}</button>
                {'offerCode' in failure && failure.offerCode && otherWay && <button type="button" className="button" onClick={() => start(otherWay.method)}>{otherWay.button}</button>}
                {(('turnOn' in failure && failure.turnOn) || ('offerKey' in failure && failure.offerKey)) && <button type="button" className="button" onClick={() => setRoute('key')}>Use an API key</button>}
              </div>
            </div>
          ) : (isClaude && pasting) || login?.method === 'code' ? (
            <PasteSteps
              profileId={profileId}
              agent={agent}
              login={login}
              code={code}
              setCode={setCode}
              codeError={codeError}
              setCodeError={setCodeError}
              onUseAsKey={(value) => {
                setKeyDraft(value);
                setCode('');
                setCodeError(null);
                setRoute('key');
              }}
            />
          ) : isClaude ? (
            <BrowserSteps login={login} otherWay={login?.pasteUrl ? 'paste a code instead' : null} onOtherWay={() => setPasting(true)} />
          ) : login?.method === 'device' ? (
            <CodexSteps login={login} />
          ) : (
            <BrowserSteps login={login} otherWay={login?.url && otherWay ? otherWay.link : null} onOtherWay={() => otherWay && start(otherWay.method)} />
          )}
          {isClaude && several && !failure && <p className="login-hint login-account-hint">{CLAUDE_ACCOUNT_HINT}</p>}
          <div className="login-footer">
            <button type="button" className="login-output-toggle" aria-expanded={showOutput} onClick={toggleOutput}>
              {showOutput ? 'Hide' : 'Show'} what {name} printed
            </button>
            <button type="button" className="button" onClick={close}>Cancel</button>
          </div>
          {showOutput && <pre className="build-log login-log">{output || 'Nothing yet.'}</pre>}
        </>
      )}
    </Modal>
  );
}

/** Signs in to one of an agent's sign-ins. The real CLI runs out of sight on the server; this is what's left for a person to do. */
export function LoginDialog() {
  const profileId = useStore((store) => store.loginProfile);
  const agent = useStore((store) => (profileId ? store.profiles.find((profile) => profile.id === profileId)?.agent ?? agentOfProfileId(profileId) : undefined));
  return profileId && agent ? <LoginFlow key={profileId} profileId={profileId} agent={agent} /> : null;
}
