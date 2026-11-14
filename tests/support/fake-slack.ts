// A stand-in for Slack: as much of its Web API and Socket Mode as Lonca uses, in memory, so that
// tests never reach Slack itself. Its conversations can be read back, metadata included, so that
// Lonca can look for what it posted, and what a user writes arrives over the socket as Slack
// sends it: acknowledged or sent again, or missed altogether while nobody's connected. Each of its
// two apps has its own DM with each user, which only that app's tokens and connections reach.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

export const TEAM = { id: 'T0FAKE', name: 'Fake Team' };
export const BOT = { user: 'U0BOT', bot: 'B0BOT', app: 'A0APP' };
export const TOKENS = { bot: 'xoxb-1-fake-bot-token-for-tests', app: 'xapp-1-fake-app-token-for-tests' };
/** A second app in the same Slack workspace, whose tokens the user could paste instead. */
export const OTHER_BOT = { user: 'U0BOT2', bot: 'B0BOT2', app: 'A0APP2' };
export const OTHER_TOKENS = { bot: 'xoxb-2-fake-bot-token-of-another-app', app: 'xapp-2-fake-app-token-of-another-app' };

const APPS = [{ bot: BOT, tokens: TOKENS }, { bot: OTHER_BOT, tokens: OTHER_TOKENS }];

/** The app a token belongs to. */
function botOf(token: string): typeof BOT {
  return APPS.find((app) => app.tokens.bot === token || app.tokens.app === token)?.bot ?? BOT;
}
export const OWNER = 'U0OWNER';
export const OTHER = 'U0OTHER';
/** Conversations besides each user's DM with the app, which Lonca must never read or post in. */
export const PUBLIC = 'C0PUBLIC';
export const PRIVATE = 'G0PRIVATE';
export const GROUP_DM = 'G0MPIM';

export interface FakeMessage {
  type: 'message';
  ts: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text: string;
  subtype?: string;
  thread_ts?: string;
  edited?: { user?: string; ts: string };
  blocks?: { type: string; text?: string }[];
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
  reactions?: { name: string; users: string[] }[];
  files?: unknown[];
  /** What the poster asked for, to check. */
  posted?: Record<string, string>;
  /** Until when reading the conversation doesn't show it, as Slack can be a moment behind its events. */
  readableAt?: number;
}

interface Channel {
  id: string;
  type: 'im' | 'channel' | 'group' | 'mpim';
  user?: string;
  /** For a DM, the app whose bot it's with. */
  bot?: typeof BOT;
  messages: FakeMessage[];
}

/** An answer to give in place of the real one, for the next call to a method. */
export interface Failure {
  error?: string;
  status?: number;
  retryAfter?: number;
  /** Do what was asked, then close the connection without answering, as when an answer is lost on the way back. */
  loseAnswer?: boolean;
  /** With `loseAnswer`, do it only this much later, as a request that timed out can still land. */
  landAfterMs?: number;
  /** Do what was asked, then answer with the error anyway, as Slack can after partly succeeding. */
  afterDoing?: boolean;
}

export interface Envelope {
  envelope_id: string;
  type: string;
  payload: unknown;
  accepts_response_payload: boolean;
  retry_attempt: number;
  retry_reason: string;
}

function compare(a: string, b: string): number {
  const [as, am] = a.split('.').map(Number);
  const [bs, bm] = b.split('.').map(Number);
  return as - bs || am - bm;
}

export class FakeSlack {
  port = 0;
  /** Every Web API call, with its arguments, in order. */
  calls: { method: string; params: Record<string, string>; token: string; at: number }[] = [];
  /** Envelopes Lonca acknowledged, by id. */
  acked = new Set<string>();
  envelopes = new Map<string, Envelope>();
  /** Connections Slack would send events down, the newest last. */
  sockets: WebSocket[] = [];
  /** Tokens Slack takes. Removing one is like revoking it. */
  tokens = new Set([TOKENS.bot, TOKENS.app, OTHER_TOKENS.bot, OTHER_TOKENS.app]);
  failures = new Map<string, Failure[]>();
  /** Neither answers pings nor sends anything, like a connection that died without saying so. */
  silent = false;
  /** How long to wait before answering a method, once per entry. What it does happens at once. */
  delays = new Map<string, number[]>();
  connections = 0;
  /** How far Slack's clock is from this computer's, which its ts follow. */
  clockOffsetMs = 0;
  private lastTs = 0;
  private channels = new Map<string, Channel>();
  /** Each connection's URL, good for one connection, as Slack's are, for the app whose token asked for it. */
  private tickets = new Map<string, typeof BOT>();
  /** The app each connection is for. */
  private apps = new WeakMap<WebSocket, typeof BOT>();
  /** The app last connected, whose DMs are where a user writes unless a test says otherwise. */
  private app = BOT;
  private server: http.Server;
  private wss: WebSocketServer;
  private envelopeCount = 0;

  constructor() {
    for (const [index, bot] of [BOT, OTHER_BOT].entries()) {
      for (const [id, user] of [[`D${index}OWNER`, OWNER], [`D${index}OTHER`, OTHER]]) this.channels.set(id, { id, type: 'im', user, bot, messages: [] });
    }
    this.channels.set(PUBLIC, { id: PUBLIC, type: 'channel', messages: [] });
    this.channels.set(PRIVATE, { id: PRIVATE, type: 'group', messages: [] });
    this.channels.set(GROUP_DM, { id: GROUP_DM, type: 'mpim', messages: [] });
    this.wss = new WebSocketServer({ noServer: true, autoPong: false });
    this.server = http.createServer((req, res) => this.request(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      const ticket = new URL(req.url ?? '', 'http://fake').searchParams.get('ticket') ?? '';
      const bot = this.tickets.get(ticket);
      if (!req.url?.startsWith('/link/') || !bot) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.tickets.delete(ticket);
      this.wss.handleUpgrade(req, socket, head, (client) => this.connected(client, bot));
    });
  }

  /** What Lonca is given as its API's address. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/api`;
  }

  /** Strictly after the last one, and close to Slack's time, as Slack's are. */
  private nextTs(): string {
    this.lastTs = Math.max(this.lastTs + 1, (Date.now() + this.clockOffsetMs) * 1000);
    return `${Math.floor(this.lastTs / 1e6)}.${String(this.lastTs % 1e6).padStart(6, '0')}`;
  }

  /** The DM between an app, the one last connected unless it's said, and a user. */
  dm(user = OWNER, bot = this.app): string {
    return [...this.channels.values()].find((channel) => channel.type === 'im' && channel.user === user && channel.bot === bot)!.id;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.port = (this.server.address() as AddressInfo).port;
      resolve();
    }));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  fail(method: string, ...failures: Failure[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...failures]);
  }

  /** The next calls to a method are answered `ms` late, though what they do happens at once. */
  delay(method: string, ms: number, times = 1): void {
    this.delays.set(method, [...(this.delays.get(method) ?? []), ...Array.from({ length: times }, () => ms)]);
  }

  /** Deletes a message, as its writer can. Replies to it stay, but its thread can't be read or added to. */
  remove(ts: string, channel = this.dm()): void {
    const conversation = this.channels.get(channel)!;
    conversation.messages = conversation.messages.filter((message) => message.ts !== ts);
  }

  /** Changes what a message says, as its writer can, which Slack tells a connected app about. */
  edit(ts: string, text: string, channel = this.dm()): string | undefined {
    const conversation = this.channels.get(channel)!;
    const message = conversation.messages.find((entry) => entry.ts === ts)!;
    const previous = { ...message };
    Object.assign(message, { text, edited: { user: message.user, ts: this.nextTs() } });
    return this.deliver({
      type: 'message', subtype: 'message_changed', channel, channel_type: conversation.type, ts: this.nextTs(), team: TEAM.id,
      message: this.eventFor(conversation, message), previous_message: this.eventFor(conversation, previous),
    });
  }

  // Conversations

  messages(channel = this.dm()): FakeMessage[] {
    return this.channels.get(channel)?.messages ?? [];
  }

  /** What the app posted, in order. */
  posts(channel = this.dm()): FakeMessage[] {
    return this.messages(channel).filter((message) => APPS.some((app) => app.bot.bot === message.bot_id));
  }

  /** The thread a message started: it and its replies. */
  thread(ts: string, channel = this.dm()): FakeMessage[] {
    return this.messages(channel).filter((message) => message.ts === ts || message.thread_ts === ts);
  }

  /** Posts anywhere but a DM, which Lonca must never make. */
  postsOutsideDms(): FakeMessage[] {
    return [...this.channels.values()].filter((channel) => channel.type !== 'im').flatMap((channel) => channel.messages.filter((message) => message.bot_id));
  }

  /** The markdown Lonca posted, as one block per message. */
  markdown(message: FakeMessage): string {
    return message.blocks?.map((block) => block.text ?? '').join('') ?? '';
  }

  /**
   * A user writes something, which Slack keeps and sends over the socket as an event, if a
   * connection is open. Returns the envelope's id, or none if nobody was connected to get it.
   */
  say(
    user: string,
    text: string,
    options: { channel?: string; thread?: string; subtype?: string; files?: unknown[]; deliver?: boolean; readableAfterMs?: number } = {},
  ): { ts: string; envelope?: string } {
    const channel = this.channels.get(options.channel ?? this.dm(user))!;
    const message: FakeMessage = {
      type: 'message', ts: this.nextTs(), user, text,
      ...(options.thread ? { thread_ts: options.thread } : {}),
      ...(options.subtype ? { subtype: options.subtype } : {}),
      ...(options.files ? { files: options.files } : {}),
      ...(options.readableAfterMs ? { readableAt: Date.now() + options.readableAfterMs } : {}),
    };
    channel.messages.push(message);
    const envelope = options.deliver === false ? undefined : this.deliver(this.eventFor(channel, message));
    return { ts: message.ts, envelope };
  }

  /** What Slack sends for a message in a conversation. */
  eventFor(channel: { id: string; type: string }, message: FakeMessage): Record<string, unknown> {
    const { posted: _posted, reactions: _reactions, readableAt: _readableAt, ...rest } = message;
    return { ...rest, channel: channel.id, channel_type: channel.type, event_ts: message.ts, team: TEAM.id };
  }

  /** The newest connection an event in a conversation goes down: its app's, for a DM. */
  private socketFor(channel: unknown): WebSocket | undefined {
    const bot = this.channels.get(String(channel))?.bot;
    return this.sockets.findLast((socket) => !bot || this.apps.get(socket) === bot);
  }

  /** An event in an envelope, down the newest connection that gets it. */
  deliver(event: Record<string, unknown>): string | undefined {
    const socket = this.socketFor(event.channel);
    if (!socket || socket.readyState !== WebSocket.OPEN || this.silent) return undefined;
    const app = this.apps.get(socket) ?? BOT;
    const id = `envelope-${++this.envelopeCount}`;
    const envelope: Envelope = {
      envelope_id: id,
      type: 'events_api',
      payload: {
        token: 'verification-token', team_id: TEAM.id, api_app_id: app.app, event, type: 'event_callback',
        event_id: `Ev${this.envelopeCount}`, event_time: Math.floor(Date.now() / 1000),
        authorizations: [{ team_id: TEAM.id, user_id: app.user, is_bot: true }],
      },
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: '',
    };
    this.envelopes.set(id, envelope);
    socket.send(JSON.stringify(envelope));
    return id;
  }

  /** Sends an envelope again, as Slack does when it isn't acknowledged in time. */
  redeliver(id: string): void {
    const envelope = this.envelopes.get(id)!;
    const again = { ...envelope, retry_attempt: envelope.retry_attempt + 1, retry_reason: 'timeout' };
    this.envelopes.set(id, again);
    this.socketFor((envelope.payload as { event?: { channel?: string } }).event?.channel)?.send(JSON.stringify(again));
  }

  /** Slack says it's closing the connection, or wants a new one. */
  disconnect(reason: 'warning' | 'refresh_requested' | 'link_disabled'): void {
    for (const socket of this.sockets) socket.send(JSON.stringify({ type: 'disconnect', reason, debug_info: { host: 'fake' } }));
  }

  /** Every connection closes at once, without a word. */
  drop(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  // Socket Mode

  private connected(socket: WebSocket, bot: typeof BOT): void {
    this.connections++;
    this.sockets.push(socket);
    this.apps.set(socket, bot);
    this.app = bot;
    socket.on('ping', (data) => {
      if (!this.silent) socket.pong(data);
    });
    socket.on('message', (data) => {
      try {
        const { envelope_id: id } = JSON.parse(data.toString()) as { envelope_id?: string };
        if (id) this.acked.add(id);
      } catch {
        // Not something Lonca sends.
      }
    });
    socket.on('close', () => {
      this.sockets = this.sockets.filter((entry) => entry !== socket);
    });
    socket.send(JSON.stringify({
      type: 'hello', num_connections: this.sockets.length, connection_info: { app_id: bot.app },
      debug_info: { host: 'fake', build_number: 1, approximate_connection_time: 3600 },
    }));
  }

  // Web API

  private request(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\/api\//, '').split('?')[0];
      const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      this.calls.push({ method, params, token, at: Date.now() });
      const failure = this.failures.get(method)?.shift();
      const late = this.delays.get(method)?.shift() ?? 0;
      const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      }, late);
      if (failure?.loseAnswer) {
        if (failure.landAfterMs) setTimeout(() => this.answer(method, params, token), failure.landAfterMs);
        else this.answer(method, params, token);
        req.socket.destroy();
        return;
      }
      if (failure) {
        if (failure.afterDoing) this.answer(method, params, token);
        respond(failure.status ?? 200, { ok: false, error: failure.error ?? 'internal_error' }, failure.retryAfter ? { 'retry-after': String(failure.retryAfter) } : {});
        return;
      }
      respond(200, this.answer(method, params, token));
    });
  }

  private authorize(token: string, kind: 'bot' | 'app'): string | undefined {
    if (!this.tokens.has(token)) return APPS.some((app) => app.tokens.bot === token || app.tokens.app === token) ? 'token_revoked' : 'invalid_auth';
    if (kind === 'bot' && !token.startsWith('xoxb-')) return 'not_allowed_token_type';
    if (kind === 'app' && !token.startsWith('xapp-')) return 'not_allowed_token_type';
    return undefined;
  }

  private answer(method: string, params: Record<string, string>, token: string): Record<string, unknown> {
    const refused = this.authorize(token, method === 'apps.connections.open' ? 'app' : 'bot');
    if (refused) return { ok: false, error: refused };
    switch (method) {
      case 'auth.test':
        return { ok: true, url: 'https://fake.slack.com/', team: TEAM.name, user: 'lonca', team_id: TEAM.id, user_id: botOf(token).user, bot_id: botOf(token).bot };
      case 'apps.connections.open': {
        const ticket = String(Math.random()).slice(2);
        this.tickets.set(ticket, botOf(token));
        return { ok: true, url: `ws://127.0.0.1:${this.port}/link/?ticket=${ticket}&app_id=${botOf(token).app}` };
      }
      case 'conversations.open': {
        const channel = [...this.channels.values()].find((entry) => entry.type === 'im' && entry.user === params.users && entry.bot === botOf(token));
        if (!channel) return { ok: false, error: 'user_not_found' };
        return { ok: true, channel: params.return_im === 'true' ? { id: channel.id, is_im: true, user: channel.user } : { id: channel.id } };
      }
      case 'conversations.replies':
      case 'conversations.history':
        return this.read(method, params, botOf(token));
      case 'chat.postMessage':
        return this.post(params, botOf(token));
      case 'reactions.add': {
        if (!this.reaches(params.channel, botOf(token))) return { ok: false, error: 'channel_not_found' };
        const message = this.channels.get(params.channel)?.messages.find((entry) => entry.ts === params.timestamp);
        if (!message) return { ok: false, error: 'message_not_found' };
        const reaction = (message.reactions ??= []).find((entry) => entry.name === params.name);
        const by = botOf(token).user;
        if (reaction?.users.includes(by)) return { ok: false, error: 'already_reacted' };
        if (reaction) reaction.users.push(by);
        else message.reactions.push({ name: params.name, users: [by] });
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown_method' };
    }
  }

  /** Whether an app's bot is in a conversation: a DM only with its own app. */
  private reaches(id: string, bot: typeof BOT): boolean {
    const channel = this.channels.get(id);
    return Boolean(channel && (channel.type !== 'im' || channel.bot === bot));
  }

  private read(method: string, params: Record<string, string>, bot: typeof BOT): Record<string, unknown> {
    const channel = this.channels.get(params.channel);
    if (!channel || !this.reaches(channel.id, bot)) return { ok: false, error: 'channel_not_found' };
    const after = (message: FakeMessage) => (!params.oldest || compare(message.ts, params.oldest) > 0) && (message.readableAt ?? 0) <= Date.now();
    let found: FakeMessage[];
    if (method === 'conversations.replies') {
      const parent = channel.messages.find((message) => message.ts === params.ts);
      if (!parent) return { ok: false, error: 'thread_not_found' };
      // The parent comes first whatever `oldest` says, as Slack's does.
      found = [parent, ...channel.messages.filter((message) => message.thread_ts === params.ts && message.ts !== params.ts && after(message))];
    } else {
      // The top level, newest first: anything not in a thread, and replies also sent to the conversation.
      found = channel.messages.filter((message) => (!message.thread_ts || message.thread_ts === message.ts || message.subtype === 'thread_broadcast') && after(message)).reverse();
    }
    const start = Number(params.cursor ?? 0);
    const limit = Number(params.limit ?? 100);
    const page = found.slice(start, start + limit).map(({ posted: _posted, readableAt: _readableAt, ...message }) => {
      if (params.include_all_metadata === 'true' || !message.metadata) return message;
      const { metadata: _metadata, ...rest } = message;
      return rest;
    });
    const more = start + limit < found.length;
    return { ok: true, messages: page, has_more: more, response_metadata: { next_cursor: more ? String(start + limit) : '' } };
  }

  private post(params: Record<string, string>, bot = BOT): Record<string, unknown> {
    const channel = this.channels.get(params.channel);
    if (!channel || !this.reaches(channel.id, bot)) return { ok: false, error: 'channel_not_found' };
    if (channel.type !== 'im') return { ok: false, error: 'not_in_channel' };
    const blocks = params.blocks ? JSON.parse(params.blocks) as { type: string; text?: string }[] : undefined;
    // Its documented limit, for every markdown block in a message together.
    if ((blocks ?? []).filter((block) => block.type === 'markdown').reduce((total, block) => total + (block.text?.length ?? 0), 0) > 12000) {
      return { ok: false, error: 'msg_blocks_too_long' };
    }
    if (params.thread_ts && !channel.messages.some((message) => message.ts === params.thread_ts)) return { ok: false, error: 'thread_not_found' };
    const message: FakeMessage = {
      type: 'message', ts: this.nextTs(), user: bot.user, bot_id: bot.bot, app_id: bot.app, text: params.text ?? '',
      ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
      ...(blocks ? { blocks } : {}),
      ...(params.metadata ? { metadata: JSON.parse(params.metadata) } : {}),
      posted: params,
    };
    channel.messages.push(message);
    // Slack tells the app about its own messages in a DM too, which Lonca has to ignore.
    this.deliver(this.eventFor(channel, message));
    return { ok: true, channel: channel.id, ts: message.ts, message };
  }
}

export async function startFakeSlack(): Promise<FakeSlack> {
  const slack = new FakeSlack();
  await slack.listen();
  return slack;
}
