import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { RotateCcw } from 'lucide-react';
import type { TerminalInfo } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { socketUrl } from '../auth.ts';
import { safeUrl } from '../format.ts';
import { attempt } from '../store.ts';

const INPUT_CHUNK_BYTES = 64 * 1024;
const FONT_SIZE = 12.5;
const FONT_NAME = 'JetBrains Mono Variable';

const THEME = {
  background: '#1b1917',
  foreground: '#e6e3df',
  cursor: '#d8c2b3',
  cursorAccent: '#1b1917',
  selectionBackground: '#4a433d',
  black: '#2b2826',
  brightBlack: '#75716c',
  red: '#e5867a',
  brightRed: '#f0a096',
  green: '#9ec78d',
  brightGreen: '#b4d6a5',
  yellow: '#dcbc7f',
  brightYellow: '#e8cd97',
  blue: '#8fb2d6',
  brightBlue: '#a8c5e2',
  magenta: '#c9a4cf',
  brightMagenta: '#d8bcdc',
  cyan: '#8cc4bd',
  brightCyan: '#a5d4ce',
  white: '#d8d5d0',
  brightWhite: '#f2f0ed',
};

/**
 * A terminal connected to a process in a container. Stays mounted while hidden to keep its state.
 * `onWindowClosed` makes this the terminal's own window, and says when the server has closed that.
 */
export function TerminalView({ id, active, autoFocus = true, onWindowClosed }: {
  id: string;
  active: boolean;
  autoFocus?: boolean;
  onWindowClosed?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const terminal = new Terminal({
      fontFamily: `"${FONT_NAME}", ui-monospace, Menlo, monospace`,
      fontSize: FONT_SIZE,
      lineHeight: 1.25,
      theme: THEME,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      // Links a CLI marks as hyperlinks otherwise open behind a browser confirmation prompt.
      linkHandler: {
        activate: (_event, uri) => {
          if (safeUrl(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
        },
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminalRef.current = terminal;

    let closed = false;
    let retry = 0;
    let retryTimer: number | undefined;
    let replaying = false;
    // A popup keeps its identity through socket reconnects and page reloads. A dismissed
    // window must not become a new owner just because its connection came back.
    const windowKey = `lonca.terminal-window.${id}`;
    const windowId = onWindowClosed ? sessionStorage.getItem(windowKey) ?? crypto.randomUUID() : undefined;
    if (windowId) sessionStorage.setItem(windowKey, windowId);
    const encoder = new TextEncoder();
    const sendSize = () => {
      const socket = socketRef.current;
      if (!replaying && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const refit = () => {
      if (!replaying && element.offsetWidth > 0 && element.offsetHeight > 0) fit.fit();
    };
    const connect = () => {
      const url = new URL(socketUrl(`/ws/terminals/${id}${windowId ? '/window' : ''}`));
      if (windowId) url.searchParams.set('windowId', windowId);
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => {
        // The server replays its scrollback, so start from a clean screen.
        terminal.reset();
        replaying = true;
      };
      socket.onmessage = (message) => {
        // A handshake alone can still be followed by a missing terminal during recovery.
        retry = 0;
        if (typeof message.data === 'string') {
          const { type, cols, rows } = JSON.parse(message.data) as { type?: string; cols: number; rows: number };
          if (type === 'reset') terminal.reset();
          // Lines only come out right at the width they were written for, and rewrap well from there.
          if (type === 'replay') terminal.resize(cols, rows);
          if (type === 'replayed') {
            terminal.write('', () => {
              replaying = false;
              refit();
            });
          }
          if (type === 'window-closed') {
            closed = true;
            onWindowClosed?.();
          }
          return;
        }
        terminal.write(new Uint8Array(message.data as ArrayBuffer));
      };
      socket.onclose = () => {
        // A missing handle can be temporary after a server restart. Removing the tab
        // unmounts this view and stops retries when the terminal is actually deleted.
        if (closed) return;
        retry = Math.min(retry + 1, 10);
        retryTimer = window.setTimeout(() => {
          if (!closed) connect();
        }, 500 * retry);
      };
    };

    const input = terminal.onData((data) => {
      const socket = socketRef.current;
      // A view has already answered what programs asked in this. Answering again would type at the prompt.
      if (replaying || socket?.readyState !== WebSocket.OPEN) return;
      // A large paste goes in pieces rather than as one frame the server would refuse.
      const bytes = encoder.encode(data);
      for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
        socket.send(bytes.subarray(offset, offset + INPUT_CHUNK_BYTES));
      }
    });
    const resize = terminal.onResize(sendSize);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    observer.observe(element);

    // xterm measures its font as it opens and not again, so the font has to have arrived.
    void document.fonts.load(`${FONT_SIZE}px "${FONT_NAME}"`).catch(() => {}).then(() => {
      if (closed) return;
      terminal.open(element);
      if (active && autoFocus) terminal.focus();
      connect();
    });

    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socketRef.current?.close();
      terminal.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (!active || !autoFocus) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active, autoFocus]);

  return <div className="terminal-view" ref={container} style={{ display: active ? 'block' : 'none' }} />;
}

/** Says when a terminal has ended or lost its connection, wherever it's being shown. */
export function TerminalNotice({ terminal, canRestart }: { terminal: TerminalInfo; canRestart: boolean }) {
  const script = terminal.kind === 'setup';
  if (terminal.status !== 'exited' && !(terminal.disconnected && (!script || terminal.jobsOnly))) return null;
  return (
    <div className="terminal-exit">
      {terminal.status === 'exited' || terminal.jobsOnly
        ? <>{script ? 'The setup script ' : 'This terminal '}exited{terminal.exitCode ? ` with code ${terminal.exitCode}` : ''}{terminal.jobsOnly ? ', but something it started is still running.' : '.'}</>
        : 'This terminal is still running, but its connection was lost. Restart stops its old process.'}
      {!script && canRestart && (
        <button type="button" className="link-button" onClick={() => void attempt(() => api.restartTerminal(terminal.workspaceId, terminal.id))}>
          <RotateCcw size={12} /> Restart
        </button>
      )}
    </div>
  );
}
