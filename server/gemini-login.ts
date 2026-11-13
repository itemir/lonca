import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_ID } from '../shared/profiles.ts';
import type { AgentStatus } from '../shared/types.ts';
import { paths } from './config.ts';
import { setBoundaryValue, writeAtomic } from './store.ts';
import { KeyedQueue, errorMessage } from './util.ts';

// A Gemini sign-in is a Google account's tokens or a Gemini API key, kept on this computer like
// Codex's. What the proxy sends for a Google account is its access token, which lasts about an
// hour, so this computer renews it with the refresh token, which no virtual machine ever has.

export interface GoogleLogin {
  kind: 'google';
  access_token: string;
  refresh_token: string;
  /** When the access token stops working, in milliseconds. */
  expiry_date: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
  /** The OAuth client the login came from, which is the only one that can renew it. */
  client_id?: string;
  client_secret?: string;
  /** Signing in found that its turns need a Google Cloud project. */
  needs_project?: boolean;
}

export interface KeyLogin {
  kind: 'key';
  apiKey: string;
}

export type GeminiLogin = GoogleLogin | KeyLogin;

/** Renewing when it has less than this left gives a turn that starts now a token to begin with. */
export const RENEW_WITHIN_MS = 10 * 60 * 1000;

// A refresh token only works with the OAuth client it was issued to, which is the CLI's own. So a
// login keeps that client beside its tokens, as signing in finds it in the CLI that made the login,
// and Lonca's source doesn't hold it. Google documents that an installed app's client secret isn't
// treated as a secret.
// Only for tests, to renew a made-up sign-in without going to the real service.
const TOKEN_URL = process.env.GEMINI_REFRESH_TOKEN_URL_OVERRIDE || 'https://oauth2.googleapis.com/token';

const MAX_LOGIN_BYTES = 65536;

/** Each Gemini sign-in's login is in a directory named after it. */
function loginDir(profileId: string): string {
  if (!PROFILE_ID.test(profileId) || !profileId.startsWith('gemini')) throw new Error('That isn’t a Gemini sign-in.');
  return path.join(paths.helperCredentials, profileId);
}

const loginFile = (profileId: string) => path.join(loginDir(profileId), 'login.json');

function readLoginText(profileId: string): string {
  try {
    const text = fs.readFileSync(loginFile(profileId), 'utf8');
    return text.length <= MAX_LOGIN_BYTES ? text : '';
  } catch {
    return '';
  }
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Only a whole login counts: an access token with what renews it, or a key. */
export function parseGeminiLogin(content: string): GeminiLogin | null {
  try {
    const login = JSON.parse(content) as Record<string, unknown>;
    if (login.kind === 'key') return text(login.apiKey) ? { kind: 'key', apiKey: login.apiKey as string } : null;
    if (login.kind !== 'google' || !text(login.access_token) || !text(login.refresh_token) || typeof login.expiry_date !== 'number') return null;
    return {
      kind: 'google',
      access_token: login.access_token as string,
      refresh_token: login.refresh_token as string,
      expiry_date: login.expiry_date,
      id_token: text(login.id_token),
      scope: text(login.scope),
      token_type: text(login.token_type),
      client_id: text(login.client_id),
      client_secret: text(login.client_secret),
      needs_project: login.needs_project === true || undefined,
    };
  } catch {
    return null;
  }
}

export function readGeminiLogin(profileId: string): GeminiLogin | null {
  return parseGeminiLogin(readLoginText(profileId));
}

/** When the credential the proxy has now was saved, which says whether a turn could have had an older one. */
export function geminiLoginSavedAt(profileId: string): number {
  return fs.statSync(loginFile(profileId), { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/** Where the proxy reads a Gemini sign-in's key. A Google account's token is in the sign-in's own file. */
export const geminiKeyFile = (profileId: string) => `${profileId}.key`;

/**
 * What the proxy sends for this sign-in: a Google account's token where Gemini sends it with a
 * Google account, and a key where a key goes, each from a file of its own, the other one empty.
 */
function shareWithProxy(profileId: string, login: GeminiLogin | null): void {
  setBoundaryValue(profileId, login?.kind === 'google' ? login.access_token : undefined);
  setBoundaryValue(geminiKeyFile(profileId), login?.kind === 'key' ? login.apiKey : undefined);
}

/** Only this server writes the login, and the proxy's copy follows it. */
function saveLogin(profileId: string, login: GeminiLogin): void {
  fs.mkdirSync(loginDir(profileId), { recursive: true, mode: 0o700 });
  writeAtomic(loginFile(profileId), JSON.stringify(login), 0o600);
  shareWithProxy(profileId, login);
}

/** The proxy's copy follows what's saved, so a file left by a sign-out that was cut short goes too. */
export function shareGeminiCredentialWithProxy(profileId: string): void {
  shareWithProxy(profileId, readGeminiLogin(profileId));
}

export function saveGeminiApiKey(key: string, profileId: string): void {
  saveLogin(profileId, { kind: 'key', apiKey: key });
}

export function signOutGemini(profileId: string): void {
  fs.rmSync(loginFile(profileId), { force: true });
  shareGeminiCredentialWithProxy(profileId);
}

/** For a sign-in that's been removed, which leaves nothing behind. */
export function forgetGeminiLogin(profileId: string): void {
  fs.rmSync(loginDir(profileId), { recursive: true, force: true });
  shareWithProxy(profileId, null);
}

function emailOf(idToken: string | undefined): string | undefined {
  try {
    const { email } = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString('utf8')) as { email?: unknown };
    return typeof email === 'string' && email ? email : undefined;
  } catch {
    return undefined;
  }
}

export function describeGeminiSignIn(login: GeminiLogin | null): Pick<AgentStatus, 'summary' | 'usesKey' | 'needsProject'> {
  if (!login) return {};
  if (login.kind === 'key') return { summary: `Using an API key ending in ${login.apiKey.slice(-4)}`, usesKey: true };
  const email = emailOf(login.id_token);
  return { summary: email ? `Signed in with Google as ${email}` : 'Signed in with Google', usesKey: false, ...(login.needs_project ? { needsProject: true } : {}) };
}

/**
 * How a renewal went. `refused` means Google won't renew it any more, because it was revoked, its
 * password changed or it went unused for too long, and only signing in again will do.
 */
export type Renewal = 'renewed' | 'not-due' | 'refused' | 'failed' | 'replaced';

const renewals = new KeyedQueue();
// Refresh tokens Google refused, which aren't tried again until there's another login.
const refused = new Map<string, string>();
// Logins that can't be renewed, which only need saying once.
const unrenewable = new Set<string>();

/** Whether Google refused to renew this sign-in's login as it is now. */
export function geminiRenewalRefused(profileId: string): boolean {
  const login = readGeminiLogin(profileId);
  return login?.kind === 'google' && refused.get(profileId) === login.refresh_token;
}

/**
 * Renews a Google account's access token when it's about to run out, here rather than in a virtual
 * machine, so that the refresh token never leaves this computer. One at a time for each sign-in.
 */
export function renewGeminiLogin(profileId: string): Promise<Renewal> {
  return renewals.run(profileId, async () => {
    const current = readLoginText(profileId);
    const login = parseGeminiLogin(current);
    if (login?.kind !== 'google' || login.expiry_date - Date.now() > RENEW_WITHIN_MS) return 'not-due';
    if (refused.get(profileId) === login.refresh_token) return 'refused';
    if (!login.client_id || !login.client_secret) {
      if (!unrenewable.has(login.refresh_token)) console.error(`could not renew the Gemini sign-in ${profileId}: its login doesn’t say which client it came from`);
      unrenewable.add(login.refresh_token);
      return 'failed';
    }
    const outcome = await refresh(login);
    // Signing out or in while this ran counts for more, and so does removing the sign-in, whatever
    // Google said about the login that was there before.
    if (readLoginText(profileId) !== current) return 'replaced';
    if (!('renewed' in outcome)) {
      if (outcome.error === 'invalid_grant') {
        refused.set(profileId, login.refresh_token);
        return 'refused';
      }
      console.error(`could not renew the Gemini sign-in ${profileId}: ${outcome.reason}`);
      return 'failed';
    }
    saveLogin(profileId, outcome.renewed);
    return 'renewed';
  });
}

/** Asks Google for a new access token, which only the client the login came from can. */
async function refresh(login: GoogleLogin): Promise<{ renewed: GoogleLogin } | { error?: string; reason: string }> {
  let response: Response;
  let body: Record<string, unknown>;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: login.refresh_token, client_id: login.client_id ?? '', client_secret: login.client_secret ?? '' }),
      signal: AbortSignal.timeout(20000),
    });
    body = await response.json().catch(() => ({})) as Record<string, unknown>;
  } catch (error) {
    // Most likely no network for now, which the next try may have.
    return { reason: errorMessage(error) };
  }
  const access = text(body.access_token);
  if (!response.ok || !access) return { error: text(body.error), reason: `${response.status} ${text(body.error) ?? ''}`.trim() };
  const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    renewed: {
      ...login,
      access_token: access,
      expiry_date: Date.now() + lifetime * 1000,
      // Google sends a new refresh token only if it replaced the old one.
      refresh_token: text(body.refresh_token) ?? login.refresh_token,
      id_token: text(body.id_token) ?? login.id_token,
      scope: text(body.scope) ?? login.scope,
      token_type: text(body.token_type) ?? login.token_type,
    },
  };
}

/** The OAuth client an ID token was issued to, which is the one the login came from. */
function audienceOf(idToken: string | undefined): string | undefined {
  try {
    const { aud } = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString('utf8')) as { aud?: unknown };
    return text(aud);
  } catch {
    return undefined;
  }
}

/** Which login a sign-in has, which signing out, saving a key or signing in again changes, and renewing doesn't. */
function loginIdentity(login: GeminiLogin | null): string {
  if (!login) return '';
  return login.kind === 'key' ? `key ${login.apiKey}` : `google ${login.refresh_token}`;
}

export interface GeminiAdoption {
  profileId: string;
  /** The OAuth client in the link the CLI printed, which a login without an ID token doesn't say. */
  clientId?: string;
  /** Finds the secret of the client the CLI signed in with, which only that CLI has. */
  clientSecret: () => Promise<string | null>;
  /** Signing in found that the account's turns need a Google Cloud project, which is kept to say so. */
  needsProject?: boolean;
  /** Whether this sign-in is still the one to keep. Cancelling it, or removing the sign-in, ends it. */
  current: () => boolean;
}

/**
 * Keeps what the CLI saved on signing in to Google, with the client it signed in with, once Google
 * has renewed it with that client, so that a login that would stop working within the hour isn't
 * kept. Reports whether it was kept, which it isn't if it wasn't a login or the sign-in ended
 * meanwhile, and throws if it wouldn't be renewed.
 */
export async function adoptGeminiLogin(saved: string, adoption: GeminiAdoption): Promise<boolean> {
  const { profileId } = adoption;
  // Signing out or saving a key while Google answers counts for more than this.
  const before = loginIdentity(readGeminiLogin(profileId));
  let creds: Record<string, unknown> | null;
  try {
    creds = JSON.parse(saved) as Record<string, unknown> | null;
  } catch {
    return false;
  }
  if (!creds || typeof creds !== 'object' || !text(creds.access_token)) return false;
  // Google gives one only the first time an account lets the client in, unless its page asks
  // again, which Lonca's link tells it to.
  if (!text(creds.refresh_token)) {
    throw new Error('Google didn’t give Lonca a way to renew this sign-in, so it would stop working within the hour. Try signing in again.');
  }
  const login: GoogleLogin = {
    kind: 'google',
    access_token: creds.access_token as string,
    refresh_token: creds.refresh_token as string,
    expiry_date: typeof creds.expiry_date === 'number' ? creds.expiry_date : Date.now(),
    id_token: text(creds.id_token),
    scope: text(creds.scope),
    token_type: text(creds.token_type),
    // Google sends an ID token only for some scopes, so the link the CLI printed says first.
    client_id: adoption.clientId ?? audienceOf(text(creds.id_token)),
    ...(adoption.needsProject ? { needs_project: true } : {}),
  };
  login.client_secret = await adoption.clientSecret() ?? undefined;
  if (!login.client_id || !login.client_secret) {
    throw new Error('Lonca couldn’t tell which client the Gemini CLI signed in with, so it couldn’t keep the sign-in working. Rebuilding the template may help.');
  }
  if (!adoption.current()) return false;
  const outcome = await refresh(login);
  if (!('renewed' in outcome)) {
    throw new Error(outcome.error
      ? `Google wouldn’t renew the sign-in (${outcome.error}), so it would have stopped working within the hour. Try signing in again.`
      : `Lonca couldn’t reach Google to check the sign-in: ${outcome.reason}. Try again.`);
  }
  if (!adoption.current()) return false;
  if (loginIdentity(readGeminiLogin(profileId)) !== before) {
    throw new Error('This sign-in changed while Lonca was finishing this one, so Lonca kept that change.');
  }
  saveLogin(profileId, outcome.renewed);
  return true;
}

// What an OAuth client secret looks like, written so that this file doesn't itself look like it holds one.
const CLIENT_SECRET = 'G[O]CSPX-[A-Za-z0-9_-]+';

/**
 * Lists the OAuth client secrets in the bundle of the CLI on PATH, which is where its login's
 * client is. The bundle repeats it in several of its files.
 */
export const CLIENT_SECRET_SEARCH = ['bash', '-c', `grep -ohE '${CLIENT_SECRET}' "$(dirname "$(readlink -f "$(command -v gemini)")")"/*.js | sort -u`];

/** The secret that search found, if it found exactly one, as anything else means it can't tell. */
export function clientSecretIn(found: string): string | null {
  const secrets = new Set(found.match(new RegExp(CLIENT_SECRET, 'g')) ?? []);
  return secrets.size === 1 ? [...secrets][0] : null;
}
