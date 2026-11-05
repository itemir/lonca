import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { startConnection, useStore } from '../store.ts';
import { TerminalNotice, TerminalView } from './TerminalView.tsx';
import { Toasts } from './ui.tsx';

/**
 * Moves a terminal to a window of its own, or brings that window forward if it has one. The browser
 * only allows this straight from a click, so nothing can be awaited first. Returns whether it worked.
 */
export function openTerminalWindow(id: string): boolean {
  // A blank address finds a window that's already open, where a real one would reload it. Without
  // a position, it can open on a different screen from the window that asked for it.
  const features = `popup,width=960,height=640,left=${window.screenX + 60},top=${window.screenY + 60}`;
  const opened = window.open('', `lonca-terminal-${id}`, features);
  if (!opened) {
    useStore.getState().toast('Your browser blocked the new window. Allow pop-ups for this site, then try again. The terminal is still running here.');
    return false;
  }
  const path = `/terminals/${id}`;
  if (opened.location.pathname !== path) opened.location.replace(path);
  opened.focus();
  return true;
}

/** The whole page in a terminal's own window. The browser and the operating system supply the rest. */
export function TerminalWindow() {
  const { id = '' } = useParams();
  const locked = useStore((store) => store.locked);
  const ready = useStore((store) => store.ready);
  const connected = useStore((store) => store.connected);
  const terminal = useStore((store) => store.terminals.find((entry) => entry.id === id));
  const workspace = useStore((store) => store.workspaces.find((entry) => entry.id === terminal?.workspaceId));
  const [dismissed, setDismissed] = useState(false);
  const title = terminal && workspace && `${workspace.title ?? workspace.name} — ${terminal.title}`;

  useEffect(() => {
    startConnection();
  }, []);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  if (locked) return <div className="boot">Open Lonca with the link printed in the terminal where you started it.</div>;
  if (!ready) return null;
  // Normally the window has closed by now, but a browser only lets a page close a window it opened.
  if (dismissed || !terminal) return <div className="boot">This terminal is no longer here. You can close this window.</div>;
  return (
    <div className="terminal-window">
      {!connected && <div className="banner">Lost the connection to the Lonca server. Reconnecting…</div>}
      <TerminalView
        id={id}
        active
        onWindowClosed={() => {
          setDismissed(true);
          window.close();
        }}
      />
      <TerminalNotice terminal={terminal} canRestart={workspace?.status === 'ready'} />
      <Toasts />
    </div>
  );
}
