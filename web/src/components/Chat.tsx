import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, Bot, Brain, CheckCircle2, ChevronRight, Circle, CircleDot, ClipboardList, Eye, FilePen, Globe,
  Info, Paperclip, Search, Send, Terminal as TerminalIcon, Wrench, X,
} from 'lucide-react';
import type {
  ChatItem, NoticeItem, ResultItem, Session, ThinkingItem, ToolItem, ToolKind, UserItem, Workspace,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { formatDuration, relativeToWorkspace } from '../format.ts';
import { attempt, signInBlocker, useStore } from '../store.ts';
import { Markdown } from './Markdown.tsx';
import { ErrorBoundary, Spinner } from './ui.tsx';

const TOOL_ICONS: Record<ToolKind, typeof Wrench> = {
  command: TerminalIcon,
  read: Eye,
  edit: FilePen,
  search: Search,
  web: Globe,
  agent: Bot,
  todos: ClipboardList,
  other: Wrench,
};

function EditPreview({ item, root }: { item: ToolItem; root: string }) {
  return (
    <>
      {item.edits?.map((edit, index) => (
        <div className="edit-preview" key={index}>
          {(item.edits?.length ?? 0) > 1 && <div className="edit-path">{relativeToWorkspace(edit.path, root)}</div>}
          {edit.removed && edit.removed.split('\n').map((line, row) => <div className="diff-line removed" key={`r${row}`}><span>-</span>{line}</div>)}
          {edit.added && edit.added.split('\n').map((line, row) => <div className="diff-line added" key={`a${row}`}><span>+</span>{line}</div>)}
        </div>
      ))}
    </>
  );
}

function TodoList({ item }: { item: ToolItem }) {
  return (
    <ul className="todo-list">
      {item.todos?.map((todo, index) => (
        <li key={index} className={`todo todo-${todo.status}`}>
          {todo.status === 'completed' ? <CheckCircle2 size={14} /> : todo.status === 'in_progress' ? <CircleDot size={14} /> : <Circle size={14} />}
          <span>{todo.text}</span>
        </li>
      ))}
    </ul>
  );
}

function ToolRow({ item, root, nested }: { item: ToolItem; root: string; nested: ChatItem[] }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[item.kind];
  if (item.kind === 'todos' && item.todos?.length) {
    return <div className="tool tool-todos"><TodoList item={item} /></div>;
  }
  const detail = relativeToWorkspace(item.detail, root);
  const hasBody = Boolean(item.output || item.edits?.length || nested.length > 0 || (detail && detail.includes('\n')));
  const showCommand = item.kind === 'command' && detail;
  return (
    <div className={`tool tool-${item.status}`}>
      <button type="button" className="tool-head" aria-expanded={open} disabled={!hasBody} onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon">{item.status === 'running' ? <Spinner size={13} /> : <Icon size={14} />}</span>
        <span className="tool-title">{item.title}</span>
        {detail && <span className="tool-detail">{detail.split('\n')[0]}</span>}
        {item.status === 'error' && <span className="tool-failed">failed</span>}
        {hasBody && <ChevronRight size={14} className={`tool-chevron ${open ? 'rotated' : ''}`} />}
      </button>
      {open && (
        <div className="tool-body">
          {showCommand && <pre className="tool-command">{detail}</pre>}
          <EditPreview item={item} root={root} />
          {item.output && <pre className="tool-output">{item.output}{item.outputTruncated ? '\n… output shortened' : ''}</pre>}
          {nested.length > 0 && <Transcript items={nested} root={root} />}
        </div>
      )}
    </div>
  );
}

function ThinkingRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool tool-thinking">
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon"><Brain size={14} /></span>
        <span className="tool-title">Thinking</span>
        {!open && <span className="tool-detail thinking-preview">{item.text}</span>}
        <ChevronRight size={14} className={`tool-chevron ${open ? 'rotated' : ''}`} />
      </button>
      {open && <div className="thinking-body"><Markdown text={item.text} /></div>}
    </div>
  );
}

function UserMessage({ item, sessionId }: { item: UserItem; sessionId: string }) {
  const running = useStore((store) => store.sessions.find((session) => session.id === sessionId)?.status === 'running');
  return (
    <div className={`user-message ${item.queued ? 'queued' : ''}`}>
      <div className="user-text">{item.text}</div>
      {item.attachments && item.attachments.length > 0 && (
        <div className="attachment-list">
          {item.attachments.map((file) => (
            <span className="attachment-chip" key={file.path}><Paperclip size={12} />{file.name}</span>
          ))}
        </div>
      )}
      {item.queued && (
        <div className="queued-note">
          {running ? 'Sends when the current turn finishes' : 'Waiting to send'}
          {!running && (
            <button type="button" className="link-button" onClick={() => void attempt(() => api.flushQueue(sessionId))}>
              <Send size={12} /> Send now
            </button>
          )}
          <button type="button" className="link-button" onClick={() => void attempt(() => api.cancelQueued(sessionId, item.id))}>
            <X size={12} /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function AuthNotice({ item, sessionId }: { item: NoticeItem; sessionId: string }) {
  const session = useStore((store) => store.sessions.find((entry) => entry.id === sessionId));
  const items = useStore((store) => store.transcripts[sessionId]?.items);
  const catalog = useStore((store) => store.catalog);
  const agents = useStore((store) => store.system.agents);
  const signInBlocked = useStore((store) => signInBlocker(store.system) !== null);
  const setLoginAgent = useStore((store) => store.setLoginAgent);
  if (!session) return null;
  const status = agents[session.agent];
  const name = catalog[session.agent].label;
  const ready = status.signedIn && !status.rejected;
  const lastSent = items?.findLast((entry): entry is UserItem => entry.type === 'user' && !entry.queued);
  const canRetry = ready && session.status === 'idle' && lastSent !== undefined && item.ts >= lastSent.ts;
  const text = ready
    ? `This didn’t go through because ${name} wasn’t signed in.`
    : status.rejected
      ? `${name} stopped accepting this sign-in.`
      : `${name} isn’t signed in yet.`;
  return (
    <div className={`notice ${ready ? 'notice-info' : 'notice-error'}`} role={ready ? undefined : 'alert'} title={item.text}>
      {ready ? <Info size={15} /> : <AlertTriangle size={15} />}
      <span className="notice-text">{text}</span>
      {!ready && !signInBlocked && (
        <button type="button" className="button button-small" onClick={() => setLoginAgent(session.agent)}>
          {status.rejected ? 'Sign in again' : 'Sign in'}
        </button>
      )}
      {canRetry && (
        <button
          type="button"
          className="button button-small"
          onClick={() => void attempt(() => api.sendMessage(sessionId, lastSent.text, lastSent.attachments ?? []))}
        >
          Send again
        </button>
      )}
    </div>
  );
}

function NoticeRow({ item, sessionId }: { item: NoticeItem; sessionId: string }) {
  if (item.code === 'auth') return <AuthNotice item={item} sessionId={sessionId} />;
  const Icon = item.level === 'info' ? Info : AlertTriangle;
  return (
    <div className={`notice notice-${item.level}`} role={item.level === 'error' ? 'alert' : undefined}>
      <Icon size={15} />
      <span className="notice-text">{item.text}</span>
    </div>
  );
}

function ResultRow({ item }: { item: ResultItem }) {
  const parts: string[] = [];
  if (item.interrupted) parts.push('Stopped');
  else if (item.failed) parts.push('Failed');
  if (item.durationMs) parts.push(item.interrupted || item.failed ? `after ${formatDuration(item.durationMs)}` : `Finished in ${formatDuration(item.durationMs)}`);
  if (!parts.length) parts.push('Finished');
  if (item.costUsd) parts.push(`$${item.costUsd.toFixed(item.costUsd < 0.01 ? 4 : 2)}`);
  return <div className="result-row">{parts.join(', ')}</div>;
}

const ChatRow = memo(function ChatRow({ item, root, nested, sessionId }: { item: ChatItem; root: string; nested: ChatItem[]; sessionId: string }) {
  switch (item.type) {
    case 'user':
      return <UserMessage item={item} sessionId={sessionId} />;
    case 'text':
      return <div className="assistant-text"><Markdown text={item.text} /></div>;
    case 'thinking':
      return <ThinkingRow item={item} />;
    case 'tool':
      return <ToolRow item={item} root={root} nested={nested} />;
    case 'notice':
      return <NoticeRow item={item} sessionId={sessionId} />;
    case 'result':
      return <ResultRow item={item} />;
  }
});

const NO_ITEMS: ChatItem[] = [];

function Transcript({ items, root, sessionId = '' }: { items: ChatItem[]; root: string; sessionId?: string }) {
  const { top, children } = useMemo(() => {
    const ids = new Set(items.map((item) => item.id));
    const byParent = new Map<string, ChatItem[]>();
    const roots: ChatItem[] = [];
    for (const item of items) {
      if (item.parentId && ids.has(item.parentId)) {
        byParent.set(item.parentId, [...(byParent.get(item.parentId) ?? []), item]);
      } else {
        roots.push(item);
      }
    }
    return { top: roots, children: byParent };
  }, [items]);
  return (
    <>
      {top.map((item) => (
        <ErrorBoundary key={item.id} compact>
          <ChatRow item={item} root={root} nested={children.get(item.id) ?? NO_ITEMS} sessionId={sessionId} />
        </ErrorBoundary>
      ))}
    </>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Math.max(0, Date.now() - since))}</>;
}

const TRANSCRIPT_RETRY_MS = 3000;

export function ChatTranscript({ session, workspace, intro }: { session: Session; workspace: Workspace; intro: React.ReactNode }) {
  const transcript = useStore((store) => store.transcripts[session.id]);
  const loadTranscript = useStore((store) => store.loadTranscript);
  const loadFailure = useStore((store) => store.transcriptErrors[session.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    pinned.current = true;
    setShowJump(false);
    void loadTranscript(session.id);
  }, [session.id, loadTranscript]);

  // Opening the chat or reconnecting can fail. Each attempt fetches all of it, so nothing is missed.
  const failing = Boolean(loadFailure);
  useEffect(() => {
    if (!failing) return;
    const retry = setInterval(() => void loadTranscript(session.id), TRANSCRIPT_RETRY_MS);
    return () => clearInterval(retry);
  }, [session.id, failing, loadTranscript]);

  const items = transcript?.items ?? NO_ITEMS;
  // Queued messages stay below the turn they're waiting for.
  const [sent, waiting] = useMemo(() => {
    const isWaiting = (item: ChatItem) => item.type === 'user' && Boolean(item.queued);
    return [items.filter((item) => !isWaiting(item)), items.filter(isWaiting)];
  }, [items]);
  const startedAt = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'user' && !item.queued) return item.ts;
    }
    return session.updatedAt;
  }, [items, session.updatedAt]);

  // Follow new output unless the reader has scrolled up to look at something.
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    pinned.current = atBottom;
    setShowJump(!atBottom);
  };

  return (
    <div className="chat-scroller" ref={scroller} onScroll={onScroll}>
      <div className="chat-column">
        {intro}
        {loadFailure && (
          <div className="notice notice-error" role="alert">
            <AlertTriangle size={15} />
            <span className="notice-text">Lonca can’t read this conversation’s history, so it may look empty or out of date. It keeps trying and will load it once it can. ({loadFailure})</span>
          </div>
        )}
        <Transcript items={sent} root={workspace.path} sessionId={session.id} />
        {session.status === 'running' && (
          <div className="working-row"><Spinner size={13} /> Working… <Elapsed since={startedAt} /></div>
        )}
        <Transcript items={waiting} root={workspace.path} sessionId={session.id} />
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            pinned.current = true;
            setShowJump(false);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
          }}
        >
          <ArrowDown size={14} /> Latest
        </button>
      )}
    </div>
  );
}
