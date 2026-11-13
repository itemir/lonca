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

/** Gemini asks before it opens a browser for its sign-in, and goes on when Return is pressed. */
export function isGeminiConsent(text: string): boolean {
  return /Do you want to continue\? \[Y\/n\]:/.test(text);
}

/**
 * The page that shows Gemini's code to paste, once the CLI is ready to be given one. It's printed
 * across more than one row, which the screen puts back together.
 */
export function findGeminiCodeLink(text: string): string | null {
  const prompt = text.lastIndexOf('Enter the authorization code:');
  if (prompt < 0) return null;
  const links = text.slice(0, prompt).match(/https:\/\/accounts\.google\.com\/\S+/g) ?? [];
  const link = links.at(-1);
  try {
    return link && new URL(link).searchParams.get('redirect_uri') === 'https://codeassist.google.com/authcode' ? link : null;
  } catch {
    return null;
  }
}

/**
 * Google gives a refresh token only the first time an account lets a client in, unless its page is
 * told to ask again, and anyone who already uses the Gemini CLI has let it in. So the link shown
 * asks, after letting the person choose which account, unless the CLI's own already says how the
 * page should prompt.
 */
export function askingConsent(link: string): string {
  try {
    const url = new URL(link);
    if (url.searchParams.has('prompt')) return link;
    const prompt = 'prompt=select_account%20consent';
    url.search = url.search ? `${url.search}&${prompt}` : `?${prompt}`;
    return url.toString();
  } catch {
    return link;
  }
}

/** The OAuth client a Google sign-in link is for. */
export function linkClientId(link: string): string | undefined {
  try {
    return new URL(link).searchParams.get('client_id') || undefined;
  } catch {
    return undefined;
  }
}

export function isGeminiCodeRejected(text: string): boolean {
  return /Failed to authenticate with (authorization|user) code/.test(text);
}

/** Google signed the account in, but Gemini needs a Google Cloud project of its own to use with it. */
export function geminiNeedsProject(text: string): boolean {
  return /ProjectIdRequiredError|requires setting the GOOGLE_CLOUD_PROJECT/.test(text);
}

/** Why Gemini won't serve an account Google signed in, if that's what it said. */
export function geminiIneligibility(text: string): string | null {
  return /IneligibleTierError: ([^\n]+)/.exec(text)?.[1].trim() ?? null;
}

export type GeminiFailure = 'denied' | 'rejected' | 'expired' | 'stopped';

/** Gemini's CLI ends well even when its sign-in didn't, so its screen says why. */
export function classifyGeminiFailure(text: string): GeminiFailure {
  if (/access_denied/.test(text)) return 'denied';
  if (/Failed to exchange authorization code|state mismatch/.test(text) || isGeminiCodeRejected(text)) return 'rejected';
  if (/timed out/i.test(text)) return 'expired';
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
