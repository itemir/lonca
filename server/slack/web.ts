// Slack's Web API, over fetch. A token goes only in the Authorization header of a request to
// Slack, and a failure says only Slack's error code, so neither can end up in a log or a chat.
import crypto from 'node:crypto';
import { sleep } from '../util.ts';
import type { SlackMessage } from './routing.ts';

/** Tests point this at a stand-in, so that they can never reach Slack. */
export function slackApiUrl(): string {
  return process.env.LONCA_SLACK_API_URL ?? 'https://slack.com/api';
}

// A token Slack won't take, or an app it won't serve, which trying again doesn't change.
const REFUSALS = new Set([
  'invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'not_allowed_token_type', 'missing_scope',
  'no_permission', 'ekm_access_denied', 'team_access_not_granted', 'access_denied', 'app_access_restricted',
  'two_factor_setup_required', 'missing_args', 'enterprise_is_restricted', 'invalid_token', 'link_disabled',
]);

// Slack's trouble rather than the request's, which goes away. Slack says a workspace is out of
// reach for the last two only while it moves into an Enterprise organization.
const PASSING = new Set([
  'ratelimited', 'rate_limited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'accesslimited',
  'org_login_required', 'team_added_to_org',
]);

// Slack says these can follow a request it partly carried out, so a post may have been made.
const MAYBE_DONE = new Set(['internal_error', 'fatal_error']);

export class SlackError extends Error {
  code: string;
  /** From a 429's Retry-After. */
  retryAfterMs?: number;
  /** There was no answer, so Slack may have done it, or may still. */
  uncertain: boolean;

  constructor(code: string, options: { retryAfterMs?: number; uncertain?: boolean } = {}) {
    super(`Slack said ${code}`);
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.uncertain = options.uncertain ?? false;
  }

  get refused(): boolean {
    return REFUSALS.has(this.code);
  }

  /** Whether trying again later could work. */
  get passing(): boolean {
    return this.uncertain || PASSING.has(this.code) || this.retryAfterMs !== undefined;
  }
}

export type SlackParams = Record<string, string | number | boolean | object | undefined>;

/**
 * When Slack said each method could be called again with each token, after a 429. Slack counts calls
 * per method, app and Slack workspace, which a token stands for, so every caller waits it out, not
 * only the one that was told. Answers can arrive out of order, and a shorter wait in one that came
 * later doesn't cut a longer one short.
 */
const cooldowns = new Map<string, number>();

/** A method and token's place in `cooldowns`, which doesn't keep the token itself. */
function cooldownKey(method: string, token: string): string {
  return `${crypto.createHash('sha256').update(token).digest('base64url')} ${method}`;
}

/**
 * Calls a method, form-encoded as every method takes, with structured arguments such as blocks as
 * JSON. Resolves with Slack's answer only if it says ok. Once `signal` is aborted it asks nothing
 * more, and gives up on an answer, so it's for reads: a write Slack has may land all the same.
 */
export async function slackCall<T extends object = Record<string, unknown>>(method: string, token: string, params: SlackParams = {}, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new SlackError('cancelled');
  const key = cooldownKey(method, token);
  const cooling = (cooldowns.get(key) ?? 0) - Date.now();
  if (cooling > 0) throw new SlackError('ratelimited', { retryAfterMs: cooling });
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  let response: Response;
  try {
    response = await fetch(`${slackApiUrl()}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
  } catch (error) {
    if (signal?.aborted) throw new SlackError('cancelled');
    // The request may have reached Slack before the answer was lost.
    throw new SlackError((error as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable', { uncertain: true });
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    const retryAfterMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
    cooldowns.set(key, Math.max(cooldowns.get(key) ?? 0, Date.now() + retryAfterMs));
    throw new SlackError('ratelimited', { retryAfterMs });
  }
  const data = await response.json().catch(() => null) as ({ ok?: boolean; error?: unknown } & T) | null;
  if (signal?.aborted) throw new SlackError('cancelled');
  if (response.ok && data?.ok === true) return data;
  // A server error may come after the work was done.
  const uncertain = response.status >= 500;
  if (typeof data?.error === 'string' && /^\w{1,80}$/.test(data.error)) throw new SlackError(data.error, { uncertain: uncertain || MAYBE_DONE.has(data.error) });
  throw new SlackError(response.ok ? 'unknown_error' : `http_${response.status}`, { uncertain: uncertain || !data });
}

/** How much a read asks for: messages a page, and at most so many pages, beyond which it says it didn't get everything. */
export const SLACK_PAGING = { limit: 200, maxPages: 100 };

/**
 * Every message a conversation has after `oldest`, page by page, waiting as long as Slack asks
 * between them. `complete` is false if there was more than Lonca reads at once. Once `signal` is
 * aborted, it stops, waiting included.
 */
export async function readMessages(
  method: 'conversations.history' | 'conversations.replies',
  token: string,
  params: SlackParams,
  signal?: AbortSignal,
): Promise<{ messages: SlackMessage[]; complete: boolean }> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  let waits = 0;
  for (let page = 0; page < SLACK_PAGING.maxPages;) {
    let answer: { messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } };
    try {
      answer = await slackCall(method, token, { ...params, limit: SLACK_PAGING.limit, ...(cursor ? { cursor } : {}) }, signal);
    } catch (error) {
      if (!(error instanceof SlackError) || error.retryAfterMs === undefined || ++waits > 5) throw error;
      await sleep(error.retryAfterMs, signal);
      continue;
    }
    messages.push(...(answer.messages ?? []));
    cursor = answer.response_metadata?.next_cursor || undefined;
    if (!cursor) return { messages, complete: true };
    page++;
  }
  return { messages, complete: false };
}
