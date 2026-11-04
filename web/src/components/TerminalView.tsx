import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { socketUrl } from '../auth.ts';
import { safeUrl } from '../format.ts';

const INPUT_CHUNK_BYTES = 64 * 1024;

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

/** A terminal connected to a process in a container. Stays mounted while hidden to keep its state. */
export function TerminalView({ id, active, autoFocus = true }: { id: string; active: boolean; autoFocus?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
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
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let closed = false;
    let retry = 0;
    let retryTimer: number | undefined;
    const encoder = new TextEncoder();
    const sendSize = () => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const connect = () => {
      const socket = new WebSocket(socketUrl(`/ws/terminals/${id}`));
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => {
        // The server replays its scrollback, so start from a clean screen.
        terminal.reset();
        sendSize();
      };
      socket.onmessage = (message) => {
        // A handshake alone can still be followed by a missing terminal during recovery.
        retry = 0;
        if (typeof message.data === 'string') {
          if ((JSON.parse(message.data) as { type?: string }).type === 'reset') terminal.reset();
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
    connect();

    const input = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
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
      frame = requestAnimationFrame(() => {
        if (element.offsetWidth > 0 && element.offsetHeight > 0) fit.fit();
      });
    });
    observer.observe(element);

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
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (container.current && container.current.offsetWidth > 0) fitRef.current?.fit();
      if (autoFocus) terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, autoFocus]);

  return <div className="terminal-view" ref={container} style={{ display: active ? 'block' : 'none' }} />;
}
