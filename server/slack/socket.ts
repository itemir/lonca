// Slack's Socket Mode: a WebSocket that Lonca opens to Slack, which Slack sends events down. It
// needs nothing on this computer to be reachable, so Lonca still only listens on 127.0.0.1.
import { WebSocket } from 'ws';
import { SlackError } from './web.ts';

/** What Slack sends: an envelope with an event in it, or a word about the connection. */
export interface Envelope {
  type?: string;
  envelope_id?: string;
  payload?: unknown;
  /** How many times this has been sent before, for one that wasn't acknowledged. */
  retry_attempt?: number;
  retry_reason?: string;
  /** Why Slack is closing the connection, in a `disconnect`. */
  reason?: string;
}

export interface SocketEvents {
  /** Where to connect, which apps.connections.open says, a new place each time. */
  url(): Promise<string>;
  /** Acknowledged if this resolves true. Otherwise Slack sends it again. */
  envelope(envelope: Envelope): Promise<boolean>;
  /** A connection is up, so what was missed while there wasn't one can be looked for. */
  hello(): void;
  change(connection: 'connecting' | 'connected' | 'error', error?: string): void;
  /** Slack won't take a token, or Socket Mode was turned off, so this has stopped. */
  refused(code: string): void;
}

export interface SocketTiming {
  pingEveryMs: number;
  /** A connection that hears nothing from Slack for this long, answers to pings included, is taken for dead. */
  silentMs: number;
  /** The wait before connecting again after a failure, doubling with each one up to `maxRetryMs`. */
  retryMs: number;
  maxRetryMs: number;
}

export const SOCKET_TIMING: SocketTiming = { pingEveryMs: 15000, silentMs: 40000, retryMs: 1000, maxRetryMs: 60000 };

export class SlackSocket {
  private events: SocketEvents;
  private timing: SocketTiming;
  private running = false;
  /** The connection Slack is using. */
  private current: WebSocket | null = null;
  /** One being opened, because there isn't one or to take over from it. */
  private opening: WebSocket | null = null;
  private asking = false;
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(events: SocketEvents, timing: Partial<SocketTiming> = {}) {
    this.events = events;
    this.timing = { ...SOCKET_TIMING, ...timing };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.events.change('connecting');
    void this.open();
  }

  stop(): void {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.current?.terminate();
    this.opening?.terminate();
    this.current = null;
    this.opening = null;
  }

  /** Opens a connection, beside the one in use if there is one, which it takes over from once Slack says hello. */
  private async open(): Promise<void> {
    if (!this.running || this.opening || this.asking) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.asking = true;
    let url: string;
    try {
      url = await this.events.url();
    } catch (error) {
      this.asking = false;
      if (!this.running) return;
      if (error instanceof SlackError && error.refused) return this.refuse(error.code);
      if (!this.current) this.events.change('error', error instanceof SlackError ? error.code : 'unreachable');
      return this.later(error instanceof SlackError ? error.retryAfterMs : undefined);
    }
    this.asking = false;
    if (!this.running) return;
    const socket = new WebSocket(url, { handshakeTimeout: 15000, perMessageDeflate: false });
    this.opening = socket;
    this.watch(socket);
  }

  private watch(socket: WebSocket): void {
    let heard = Date.now();
    const alive = () => {
      heard = Date.now();
    };
    // Slack pings too, but a connection can die without either side being told, as when a laptop sleeps.
    const heartbeat = setInterval(() => {
      if (Date.now() - heard > this.timing.silentMs) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, this.timing.pingEveryMs);
    socket.on('ping', alive);
    socket.on('pong', alive);
    socket.on('message', (data, isBinary) => {
      alive();
      if (isBinary) return;
      let message: Envelope;
      try {
        message = JSON.parse(data.toString()) as Envelope;
      } catch {
        return;
      }
      if (message && typeof message === 'object') this.receive(socket, message);
    });
    // Always followed by a close, which is where it's handled.
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(heartbeat);
      this.closed(socket);
    });
  }

  private receive(socket: WebSocket, message: Envelope): void {
    if (message.type === 'hello') {
      if (socket !== this.opening) return;
      const previous = this.current;
      this.current = socket;
      this.opening = null;
      this.failures = 0;
      previous?.close(1000);
      this.events.change('connected');
      this.events.hello();
      return;
    }
    if (message.type === 'disconnect') {
      // Turned off in the app's settings, which only the user can turn back on.
      if (message.reason === 'link_disabled') return this.refuse('link_disabled');
      // A warning comes about ten seconds before Slack closes it, and a refresh asks for a new one now.
      void this.open();
      return;
    }
    const id = message.envelope_id;
    if (typeof id !== 'string') return;
    void this.events.envelope(message).then((acknowledge) => {
      // On the connection it came on. If that's gone, Slack sends it again on another.
      if (acknowledge && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: id }));
    }, () => {});
  }

  private closed(socket: WebSocket): void {
    if (socket === this.opening) this.opening = null;
    if (socket === this.current) {
      this.current = null;
      if (this.running && !this.opening) this.events.change('connecting');
    }
    if (this.running && !this.current && !this.opening) this.later();
  }

  /** At once after a connection that was working, since Slack closes them routinely, and later after each failure. */
  private later(wait?: number): void {
    if (!this.running || this.retry || this.asking) return;
    const backoff = this.failures === 0 ? 0 : Math.min(this.timing.maxRetryMs, this.timing.retryMs * 2 ** (this.failures - 1));
    this.failures++;
    // Spread out, so that a Slack outage isn't followed by every client at once.
    const delay = wait ?? backoff * (0.75 + Math.random() * 0.5);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.open();
    }, delay);
  }

  private refuse(code: string): void {
    this.stop();
    this.events.refused(code);
  }
}
