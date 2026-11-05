import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import type { AgentId, LoginFailure, LoginMethod, LoginState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { safeUrl } from '../format.ts';
import { useStore } from '../store.ts';
import { Modal, Spinner } from './ui.tsx';

const SUCCESS_HOLD_MS = 1500;

const CHATGPT_SECURITY = 'https://chatgpt.com/#settings/Security';

const KEY_PAGES: Record<AgentId, string> = {
  claude: 'https://console.anthropic.com/settings/keys',
  codex: 'https://platform.openai.com/api-keys',
};

interface FailureCopy {
  text: string;
  action: string;
  /** Nothing explains this but what the CLI printed, so show it straight away. */
  showOutput?: boolean;
  /** Trying again won't help until this has been dealt with. */
  turnOn?: { label: string; href: string };
  /** Codex's one-time code doesn't need the browser to get back. */
  offerCode?: boolean;
}

function failureCopy(failure: LoginFailure | undefined, name: string, message?: string): FailureCopy {
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
      return { text: 'The sign-in page didn’t approve this. If you cancelled it there, you can try again.', action: 'Try again' };
    case 'no-link':
      return { text: `Lonca couldn’t get a sign-in link from ${name}.`, action: 'Try again', showOutput: true };
    case 'save-failed':
      return { text: `${name} approved the sign-in, but Lonca couldn’t finish it${message ? `: ${message}` : '.'}`, action: 'Try again', showOutput: true };
    case 'unavailable':
      return { text: `Lonca couldn’t start the sign-in${message ? `: ${message}` : '.'}`, action: 'Try again' };
    case 'port-busy':
      return {
        text: `The sign-in page comes back to port ${message} on this computer, and something else is using it. Close that and try again, or use a one-time code.`,
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

const ANOTHER_SERVICE_KEY = 'That’s a key for another service. Claude keys start with sk-ant-.';

function ClaudeSteps({ login, code, setCode, codeError, setCodeError, onUseAsKey }: {
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
  const looksLikeKey = /^sk-/.test(code.trim());
  const someOtherKey = /^sk-(?!ant-)/.test(code.trim());
  // Having a code in hand means the page has been dealt with, however it got here.
  const active = opened || working || Boolean(code.trim());
  // Pressing Continue again would only repeat the error. The way on is its link, or a new value.
  const stuck = looksLikeKey && Boolean(codeError);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim() || working) return;
    if (looksLikeKey) {
      setCodeError(someOtherKey ? ANOTHER_SERVICE_KEY : 'That’s a key, not a sign-in code.');
      input.current?.select();
      return;
    }
    setCodeError(null);
    try {
      await api.submitLoginCode('claude', code);
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
          <div className="login-step-title">Approve access on {hostOf(url) || 'claude.com'}</div>
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

function CodexSteps({ login }: { login: LoginState | undefined }) {
  const [opened, setOpened] = useState(false);
  const [copied, copy] = useCopied();
  const url = safeUrl(login?.url);
  const code = login?.code;
  const ending = login?.phase === 'saving';
  return (
    <ol className="login-steps">
      <li className={`login-step ${opened || ending ? 'step-past' : 'step-now'}`}>
        <span className="login-step-number" aria-hidden="true">1</span>
        <div className="login-step-body">
          <div className="login-step-title">Enter this code on the sign-in page</div>
          <div className="login-code-box">
            {code
              ? <><span className="login-code">{code}</span><button type="button" className="button button-small" onClick={() => copy(code)}>{copied ? 'Copied' : 'Copy'}</button></>
              : <span className="login-code-waiting">{ending ? 'Finishing up…' : 'Getting your code…'}</span>}
          </div>
          {url && <p className="login-hint">Only enter it on {hostOf(url)}, and only if you started this sign-in. It expires after a few minutes.</p>}
          <div className="login-actions">
            {url && code ? (
              <a
                className={`button ${opened ? '' : 'button-primary'}`}
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  copy(code);
                  setOpened(true);
                }}
              >
                {opened ? 'Open again' : 'Copy code and open'}
              </a>
            ) : (
              <button type="button" className="button button-primary" disabled>Copy code and open</button>
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

function KeyForm({ agent, name, initial, onSaved, onCancel, onUseAsCode, onChecking }: {
  agent: AgentId;
  name: string;
  initial: string;
  onSaved: (verified: boolean) => void;
  onCancel: () => void;
  onUseAsCode: (value: string) => void;
  onChecking: (checking: boolean) => void;
}) {
  const isClaude = agent === 'claude';
  const prefix = isClaude ? 'sk-ant-' : 'sk-';
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
    if (isClaude && /^sk-(?!ant-)/.test(trimmed)) return refuse(ANOTHER_SERVICE_KEY);
    if (!isClaude && trimmed.startsWith('sk-ant-')) return refuse('That’s a key for Claude. Sign in to Claude with it instead.');
    if (!trimmed.startsWith(prefix)) {
      return refuse(isClaude
        ? `That isn’t a key. Keys start with ${prefix}.`
        : `That isn’t a key. Keys start with ${prefix}. A sign-in code goes in your browser.`);
    }
    setChecking(true);
    onChecking(true);
    setError(null);
    setNotAKey(false);
    try {
      const { verified } = isClaude ? await api.saveClaudeToken(trimmed) : await api.saveCodexKey(trimmed);
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
        <span className="field-label">{isClaude ? 'API key or token' : 'OpenAI API key'}</span>
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
          {notAKey && isClaude && !/^sk-/.test(trimmed) && <> <button type="button" className="link-button" onClick={() => onUseAsCode(trimmed)}>Use it as the sign-in code</button></>}
        </p>
      )}
      <p className="login-hint login-key-help">
        {isClaude
          ? <>An API key bills your Anthropic account directly, separately from any Claude subscription. A token from <code>claude setup-token</code> uses your subscription instead. </>
          : 'An API key bills your OpenAI account directly, separately from ChatGPT. '}
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

function LoginFlow({ agent }: { agent: AgentId }) {
  const latest = useStore((store) => store.logins[agent]);
  // An attempt that ended before this window opened, perhaps in another tab, is none of its business.
  const [leftOver] = useState(() => (latest?.phase === 'failed' || latest?.phase === 'done' ? latest : null));
  const login = latest === leftOver ? undefined : latest;
  const status = useStore((store) => store.system.agents[agent]);
  const applyEvent = useStore((store) => store.apply);
  const setLoginAgent = useStore((store) => store.setLoginAgent);
  const isClaude = agent === 'claude';
  const name = isClaude ? 'Claude' : 'Codex';
  const [route, setRoute] = useState<'account' | 'key'>(status.rejected && status.usesKey ? 'key' : 'account');
  const [savedKey, setSavedKey] = useState<{ verified: boolean } | null>(null);
  const [pasting, setPasting] = useState(false);
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
    api.startLogin(agent, how).then(
      (state) => applyEvent({ type: 'login', agent, login: state }),
      (failure: Error) => setStartFailure(failure.message),
    ).finally(() => setStarting(false));
  }, [agent, applyEvent]);

  useEffect(() => {
    if (route === 'account' && !started.current && !login) start('browser');
    if (login) started.current = true;
  }, [route, login, start]);

  // The page that comes back couldn't be offered, so the code is the way in.
  useEffect(() => {
    if (login?.pasteUrl && !login.url) setPasting(true);
  }, [login?.pasteUrl, login?.url]);

  const close = useCallback(() => {
    void api.cancelLogin(agent).catch(() => {});
    setLoginAgent(null);
  }, [agent, setLoginAgent]);

  const finished = login?.phase === 'done' || savedKey?.verified === true;

  // Codex finishes while the person is on another tab, so the message waits for them to return.
  useEffect(() => {
    if (!finished) return;
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
  }, [finished, close]);

  const failed = login?.phase === 'failed';
  const missing = route === 'account' && started.current && !login && !startFailure && !starting;
  // A sign-in can't survive the server restarting. If that isn't what happened, another tab ended it.
  const interrupted = missing && lostServer.current;
  useEffect(() => {
    if (missing && !lostServer.current) setLoginAgent(null);
  }, [missing, setLoginAgent]);
  const failure = failed
    ? failureCopy(login.failure, name, login.message)
    : startFailure
      ? failureCopy('unavailable', name, startFailure)
      : interrupted
        ? { text: 'Lonca restarted during this sign-in.', action: 'Start again' }
        : null;
  const showOutput = outputOpen || Boolean(failed && failure?.showOutput);

  useEffect(() => {
    if (login?.output) setOutput(login.output);
  }, [login?.output]);

  const toggleOutput = () => {
    if (!showOutput && !login?.output) void api.loginOutput(agent).then(setOutput, () => {});
    setOutputOpen(!showOutput);
  };

  if (finished) {
    return (
      <Modal title={`${name} is signed in`} onClose={close} closeOnBackdrop>
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
      <Modal title="Key saved, not checked yet" onClose={close} closeOnBackdrop>
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
    <Modal title={`Sign in to ${name}`} onClose={checkingKey ? () => {} : close} closeOnBackdrop={false}>
      <div className="segmented" role="tablist" aria-label={`How to sign in to ${name}`}>
        <button type="button" role="tab" aria-selected={route === 'account'} className={route === 'account' ? 'active' : ''} disabled={checkingKey} onClick={() => setRoute('account')}>
          {isClaude ? 'Claude subscription' : 'ChatGPT account'}
        </button>
        <button type="button" role="tab" aria-selected={route === 'key'} className={route === 'key' ? 'active' : ''} disabled={checkingKey} onClick={() => setRoute('key')}>
          API key
        </button>
      </div>
      {route === 'key' ? (
        <KeyForm
          key={keyDraft}
          agent={agent}
          name={name}
          initial={keyDraft}
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
                {'offerCode' in failure && failure.offerCode && <button type="button" className="button" onClick={() => start('device')}>Use a one-time code</button>}
                {'turnOn' in failure && failure.turnOn && <button type="button" className="button" onClick={() => setRoute('key')}>Use an API key</button>}
              </div>
            </div>
          ) : isClaude && pasting ? (
            <ClaudeSteps
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
            <BrowserSteps login={login} otherWay={login?.url ? 'use a one-time code instead' : null} onOtherWay={() => start('device')} />
          )}
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

/** Signs in to an agent. The real CLI runs out of sight on the server; this is what's left for a person to do. */
export function LoginDialog() {
  const agent = useStore((store) => store.loginAgent);
  return agent ? <LoginFlow key={agent} agent={agent} /> : null;
}
