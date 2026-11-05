import { createRequire } from 'node:module';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

// The CLIs paint their sign-in screens with cursor movements rather than printing lines, so
// their output means nothing until it's rendered. This renders it the way a terminal would.
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');

// Wide enough that long links and tokens are never wrapped onto a second row.
export const LOGIN_COLS = 500;
export const LOGIN_ROWS = 50;

export class LoginScreen {
  /** Links the CLI has marked as hyperlinks, which arrive whole however they're drawn. */
  readonly links: string[] = [];
  private terminal: HeadlessTerminal;

  constructor() {
    this.terminal = new Terminal({ cols: LOGIN_COLS, rows: LOGIN_ROWS, scrollback: 1000, allowProposedApi: true });
    this.terminal.parser.registerOscHandler(8, (data) => {
      const target = data.slice(data.indexOf(';') + 1);
      if (/^https?:\/\//.test(target) && !this.links.includes(target)) this.links.push(target);
      return true;
    });
  }

  write(data: Uint8Array | string): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  text(): string {
    const buffer = this.terminal.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && rows.length > 0) rows[rows.length - 1] += text;
      else rows.push(text);
    }
    return rows.join('\n').replace(/\n+$/, '');
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

/** A sign-in page that sends the browser back to a listener on `localhost`, and what it'll come back to. */
export interface RedirectLink {
  url: string;
  port: number;
  path: string;
  state: string;
}

function readRedirectLink(url: string): RedirectLink | null {
  try {
    const params = new URL(url).searchParams;
    const back = new URL(params.get('redirect_uri') ?? '');
    const state = params.get('state');
    if (back.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(back.hostname) || !back.port || !state) return null;
    return { url, port: Number(back.port), path: back.pathname, state };
  } catch {
    return null;
  }
}

/**
 * Claude only tells a browser about this one. Codex prints it too. A hyperlink arrives whole, but
 * a printed link could be cut short by where the output was split until something comes after it.
 */
export function findRedirectLink(screen: LoginScreen): RedirectLink | null {
  for (const link of [...screen.links, ...(screen.text().match(/https?:\/\/\S+(?=\s)/g) ?? [])]) {
    const redirect = readRedirectLink(link);
    if (redirect) return redirect;
  }
  return null;
}

/** The page that shows a code to paste, which is the one Claude prints. */
export function findClaudeLink(screen: LoginScreen): string | null {
  const printed = screen.text().match(/https:\/\/\S*oauth\S*(?=\s)/g) ?? [];
  return [...screen.links, ...printed].find((link) => /oauth/i.test(link) && !readRedirectLink(link)) ?? null;
}

// A token the CLI wrapped itself carries on across rows holding nothing else.
const WRAPPED_ROWS = '(?:[ \\t]*\\n[ \\t]*[\\w-]+[ \\t]*(?=\\n|$))*';

export function findClaudeToken(text: string): string | null {
  return new RegExp(`sk-ant-oat[\\w-]{20,}${WRAPPED_ROWS}`).exec(text)?.[0].replace(/\s/g, '') ?? null;
}

export function findCodexDevice(text: string): { url: string; code: string } | null {
  const instruction = /one-time code[^\n]*\n\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)/i.exec(text);
  if (!instruction) return null;
  // The link comes just before the code. Anything else printed above it could be a link too.
  const url = text.slice(0, instruction.index).match(/https?:\/\/\S+/g)?.at(-1);
  return url ? { url, code: instruction[1] } : null;
}

export function isClaudeCodeRejected(text: string): boolean {
  return /OAuth error|wasn't accepted/i.test(text);
}

/** It's stuck on something else, such as being unable to check the organization's settings, which it explains on screen. */
export function isClaudeStuck(text: string): boolean {
  return /Press Enter to retry/i.test(text);
}

export type CodexFailure = 'disabled' | 'expired' | 'denied' | 'rejected' | 'stopped';

export function classifyCodexFailure(text: string): CodexFailure {
  if (/not enabled/i.test(text)) return 'disabled';
  if (/timed out|expired/i.test(text)) return 'expired';
  if (/device auth failed|sign-in failed/i.test(text)) return 'denied';
  if (/token exchange failed/i.test(text)) return 'rejected';
  return 'stopped';
}

/** Whatever's shown to the user from a CLI's screen must not include a credential. */
export function redact(text: string): string {
  return text
    .replace(new RegExp(`sk-[\\w-]{8,}${WRAPPED_ROWS}`, 'g'), 'sk-…')
    .replace(/https?:\/\/\S+|[\w+/=_-]{40,}/g, (match) => (match.startsWith('http') ? match : '…'));
}

/** The `state` in the link, which a code from that same sign-in carries after a `#`. */
export function loginLinkState(url: string): string | null {
  try {
    return new URL(url).searchParams.get('state');
  } catch {
    return null;
  }
}
