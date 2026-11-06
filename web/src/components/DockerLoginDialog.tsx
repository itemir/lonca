import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { DockerLoginState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { DeviceCodeSteps } from './LoginDialog.tsx';
import { Modal } from './ui.tsx';

function failureText(login: DockerLoginState): { text: string; action: string; showOutput: boolean } {
  switch (login.failure) {
    case 'expired':
      return { text: 'That sign-in has expired.', action: 'Start again', showOutput: false };
    case 'no-code':
      return { text: 'Lonca couldn’t get a sign-in code from sbx.', action: 'Try again', showOutput: true };
    case 'unchecked':
      return {
        text: `sbx finished, but Lonca couldn’t check Docker Sandboxes yet${login.message ? `: ${login.message.replace(/\.$/, '')}` : ''}. This window closes by itself if it’s signed in.`,
        action: 'Try again',
        showOutput: false,
      };
    case 'unavailable':
      return { text: `Lonca couldn’t start the sign-in${login.message ? `: ${login.message}` : '.'}`, action: 'Try again', showOutput: false };
    default:
      return {
        text: login.message ? `Docker Sandboxes didn’t sign in: ${login.message}` : 'Sign-in stopped before it finished.',
        action: 'Try again',
        showOutput: true,
      };
  }
}

/**
 * Signs Docker Sandboxes in, with the one-time code `sbx login` prints. That runs on the server,
 * as the user, so it's their login for the whole computer.
 */
export function DockerLoginDialog({ onClose }: { onClose: () => void }) {
  const latest = useStore((store) => store.system.dockerLogin);
  const ready = useStore((store) => store.system.sandbox.state === 'ready');
  // One that ended before this window opened, perhaps in another tab, is none of its business.
  const [leftOver] = useState(() => (latest?.phase === 'failed' || latest?.phase === 'done' ? latest : null));
  const login = latest === leftOver ? undefined : latest;
  const [startFailure, setStartFailure] = useState<string | null>(null);
  // Null follows what the failure calls for, until someone shows or hides it.
  const [outputOpen, setOutputOpen] = useState<boolean | null>(null);
  const started = useRef(false);

  const start = useCallback(() => {
    started.current = true;
    setStartFailure(null);
    setOutputOpen(null);
    api.startDockerLogin().catch((failure: Error) => setStartFailure(failure.message));
  }, []);

  // Cancelled from another tab, which ends it here too.
  const seen = useRef(false);
  useEffect(() => {
    if (!started.current && !login) start();
    if (login) started.current = true;
    if (login) seen.current = true;
    else if (seen.current && !latest) onClose();
  }, [login, latest, start, onClose]);

  const close = useCallback(() => {
    void api.cancelDockerLogin().catch(() => {});
    onClose();
  }, [onClose]);

  // Ready is what matters, however it got there, including from a terminal.
  useEffect(() => {
    if (ready || login?.phase === 'done') onClose();
  }, [ready, login?.phase, onClose]);

  const failure = login?.phase === 'failed'
    ? failureText(login)
    : startFailure ? { text: `Lonca couldn’t start the sign-in: ${startFailure}`, action: 'Try again', showOutput: false } : null;
  const output = login?.phase === 'failed' ? login.output : undefined;
  const showOutput = Boolean(output) && (outputOpen ?? Boolean(failure?.showOutput));

  return (
    <Modal title="Sign in to Docker" onClose={close} closeOnBackdrop={false}>
      <p className="login-hint">This signs in Docker Sandboxes on this computer, which also signs in <code>sbx</code> in your terminal.</p>
      {failure ? (
        <div className="login-failure">
          <div className="notice notice-error" role="alert">
            <AlertTriangle size={15} />
            <span className="notice-text">{failure.text}</span>
          </div>
          <div className="login-failure-actions">
            <button type="button" className="button button-primary" onClick={start}>{failure.action}</button>
          </div>
        </div>
      ) : (
        <DeviceCodeSteps
          url={login?.url}
          code={login?.code}
          ending={login?.phase === 'checking'}
          title="Check that the sign-in page shows this code"
          hint={(host) => `Only approve it on ${host}, and only if you started this sign-in.`}
          openLabel="Open sign-in page"
          copyOnOpen={false}
        />
      )}
      <div className="login-footer">
        {output
          ? <button type="button" className="login-output-toggle" aria-expanded={showOutput} onClick={() => setOutputOpen(!showOutput)}>{showOutput ? 'Hide' : 'Show'} what sbx printed</button>
          : <span />}
        <button type="button" className="button" onClick={close}>Cancel</button>
      </div>
      {showOutput && <pre className="build-log login-log">{output}</pre>}
    </Modal>
  );
}
