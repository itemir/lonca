import type { ChatItem, SessionSnapshot } from '../shared/types.ts';
import { publish } from './events.ts';
import { appendTranscript, appendTranscriptMove, appendTranscriptRemoval, getSession, loadTranscript } from './store.ts';
import { HttpError } from './util.ts';

/** One session's chat in memory. Streaming text is only written to disk once it's complete. */
class Transcript {
  readonly sessionId: string;
  items: ChatItem[];
  private seq = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.items = loadTranscript(sessionId);
  }

  private indexOf(itemId: string): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].id === itemId) return i;
    }
    return -1;
  }

  find(itemId: string): ChatItem | undefined {
    return this.items[this.indexOf(itemId)];
  }

  upsert(item: ChatItem): void {
    const index = this.indexOf(item.id);
    if (index >= 0) this.items[index] = item;
    else this.items.push(item);
    const streaming = (item.type === 'text' || item.type === 'thinking') && item.streaming;
    if (!streaming) appendTranscript(this.sessionId, [item]);
    publish({ type: 'chat.item', sessionId: this.sessionId, seq: ++this.seq, item });
  }

  delta(itemId: string, text: string): void {
    const item = this.find(itemId);
    if (!item || (item.type !== 'text' && item.type !== 'thinking')) return;
    item.text += text;
    publish({ type: 'chat.delta', sessionId: this.sessionId, seq: ++this.seq, itemId, text });
  }

  remove(itemId: string): void {
    const index = this.indexOf(itemId);
    if (index < 0) return;
    this.items.splice(index, 1);
    appendTranscriptRemoval(this.sessionId, itemId);
    publish({ type: 'chat.remove', sessionId: this.sessionId, seq: ++this.seq, itemId });
  }

  moveToEnd(item: ChatItem): void {
    const index = this.indexOf(item.id);
    if (index >= 0) this.items.splice(index, 1);
    this.items.push(item);
    appendTranscriptMove(this.sessionId, item);
    publish({ type: 'chat.remove', sessionId: this.sessionId, seq: ++this.seq, itemId: item.id });
    publish({ type: 'chat.item', sessionId: this.sessionId, seq: ++this.seq, item });
  }

  removeRun(runId: string): void {
    for (const item of this.items.filter((entry) => entry.runId === runId)) this.remove(item.id);
  }

  get lastSeq(): number {
    return this.seq;
  }
}

const open = new Map<string, Transcript>();

export function transcriptFor(sessionId: string): Transcript {
  let transcript = open.get(sessionId);
  if (!transcript) {
    transcript = new Transcript(sessionId);
    open.set(sessionId, transcript);
  }
  return transcript;
}

export function dropTranscript(sessionId: string): void {
  open.delete(sessionId);
}

export function sessionSnapshot(sessionId: string): SessionSnapshot {
  const session = getSession(sessionId);
  if (!session) throw new HttpError(404, 'No such session');
  const transcript = transcriptFor(sessionId);
  return { session, items: transcript.items, seq: transcript.lastSeq };
}
