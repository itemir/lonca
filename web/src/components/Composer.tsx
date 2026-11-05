import { useEffect, useRef } from 'react';
import { ArrowUp, Paperclip, Plus, Square, X } from 'lucide-react';
import { create } from 'zustand';
import { canRun } from '../../../shared/lead.ts';
import type { Attachment, Session, Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { isTouch } from '../hooks.ts';
import { attempt, useStore } from '../store.ts';
import { type ModelChoice, ModelPicker } from './ModelPicker.tsx';
import { LockedModel } from './Team.tsx';
import { IconButton, Spinner } from './ui.tsx';

interface Draft {
  text: string;
  attachments: Attachment[];
  uploading: number;
}

// Pending sends and uploads keep updating their conversation, including after a tab switch.
const EMPTY_DRAFT: Draft = { text: '', attachments: [], uploading: 0 };
const useDrafts = create<Record<string, Draft>>(() => ({}));
const updateDraft = (sessionId: string, update: (draft: Draft) => Draft) => {
  useDrafts.setState((drafts) => ({ [sessionId]: update(drafts[sessionId] ?? EMPTY_DRAFT) }));
};

export function Composer({ session, workspace }: { session: Session; workspace: Workspace }) {
  const catalog = useStore((store) => store.catalog);
  const agentStatus = useStore((store) => store.system.agents[session.agent]);
  const cantRun = useStore((store) => !canRun(session.agent, store.system, store.projects.find((entry) => entry.id === workspace.projectId)));
  const setLoginAgent = useStore((store) => store.setLoginAgent);
  // A sign-in error at the end of the chat already says this, right above.
  const justAsked = useStore((store) => {
    const items = store.transcripts[session.id]?.items;
    return items?.findLast((item) => item.type !== 'result')?.type === 'notice'
      && (items.findLast((item) => item.type !== 'result') as { code?: string }).code === 'auth';
  });
  const { text, attachments, uploading } = useDrafts((drafts) => drafts[session.id] ?? EMPTY_DRAFT);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canAttach = workspace.status === 'ready';
  const blocked = ['archived', 'archiving', 'error', 'deleting', 'stopping'].includes(workspace.status);

  useEffect(() => {
    // Focusing would bring up an on-screen keyboard for someone who only wants to read.
    if (!isTouch()) textarea.current?.focus();
  }, [session.id]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    const tallest = isTouch() ? Math.min(320, window.innerHeight * 0.3) : 320;
    element.style.height = `${Math.min(element.scrollHeight, tallest)}px`;
  }, [text]);

  const updateText = (value: string) => {
    updateDraft(session.id, (draft) => ({ ...draft, text: value }));
  };

  const send = async () => {
    const message = text.trim();
    if (!message || uploading > 0 || blocked) return;
    const sending = attachments;
    updateDraft(session.id, () => EMPTY_DRAFT);
    const sent = await attempt(() => api.sendMessage(session.id, message, sending));
    if (!sent) {
      updateDraft(session.id, (draft) => ({
        ...draft,
        text: draft.text ? `${message}\n\n${draft.text}` : message,
        attachments: [...sending, ...draft.attachments.filter((file) => !sending.some((sent) => sent.path === file.path))],
      }));
    }
  };

  const upload = async (files: Iterable<File>) => {
    for (const file of files) {
      updateDraft(session.id, (draft) => ({ ...draft, uploading: draft.uploading + 1 }));
      const attachment = await attempt(() => api.uploadAttachment(workspace.id, file));
      updateDraft(session.id, (draft) => ({
        ...draft,
        uploading: draft.uploading - 1,
        attachments: attachment ? [...draft.attachments, attachment] : draft.attachments,
      }));
    }
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (files.length > 0 && canAttach) {
      event.preventDefault();
      void upload(files);
    }
  };

  const onDrop = (event: React.DragEvent) => {
    if (event.dataTransfer.files.length > 0 && canAttach) {
      event.preventDefault();
      void upload([...event.dataTransfer.files]);
    }
  };

  const changeModel = (choice: ModelChoice) => {
    void attempt(() => api.updateSession(session.id, choice));
  };

  const agentLabel = catalog[session.agent].label;
  const locked = session.role === 'agent' || (session.role === 'lead' && Boolean(workspace.leadLockedAt));
  const placeholder = ['creating', 'restoring', 'rebuilding', 'starting'].includes(workspace.status)
    ? 'Write now, and this sends once the workspace is ready'
    : session.role === 'agent'
      ? 'Message this agent directly. The Lead is told.'
      : session.status === 'running'
        ? 'Send a follow-up for when this turn finishes'
        : session.role === 'lead'
          ? session.hasMessages ? 'Ask or tell the Lead something' : `Tell the Lead what you want done in ${workspace.name}`
          : `Ask ${agentLabel} to do something in ${workspace.name}`;

  return (
    <div className="composer-wrap">
      {session.role === 'lead' && !locked && (
        <div className="composer-hint">The Lead’s model locks when you send the first message.</div>
      )}
      {cantRun && !justAsked && (
        <div className="composer-hint">
          {agentStatus.rejected ? `${agentLabel} stopped accepting this sign-in.` : `${agentLabel} isn’t signed in yet.`}
          <button type="button" className="link-button" onClick={() => setLoginAgent(session.agent)}>
            {agentStatus.rejected ? 'Sign in again' : 'Sign in'}
          </button>
        </div>
      )}
      <form
        className="composer"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {(attachments.length > 0 || uploading > 0) && (
          <div className="attachment-list composer-attachments">
            {attachments.map((file) => (
              <span className="attachment-chip" key={file.path}>
                <Paperclip size={12} />
                {file.name}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => updateDraft(session.id, (draft) => ({ ...draft, attachments: draft.attachments.filter((entry) => entry.path !== file.path) }))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {uploading > 0 && <span className="attachment-chip"><Spinner size={12} /> Uploading</span>}
          </div>
        )}
        <textarea
          ref={textarea}
          className="composer-input"
          aria-label="Message"
          rows={2}
          value={text}
          disabled={blocked}
          placeholder={blocked ? `${workspace.name} is ${workspace.status}` : placeholder}
          onChange={(event) => updateText(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            // An on-screen keyboard has no Shift-Enter, so its Enter starts a new line and the button sends.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !isTouch()) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bar">
          {locked ? <LockedModel session={session} /> : (
            <ModelPicker
              catalog={catalog}
              value={{ agent: session.agent, model: session.model, effort: session.effort }}
              lockAgent={session.hasMessages}
              onChange={changeModel}
            />
          )}
          <span className="spacer" />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void upload([...event.target.files]);
              event.target.value = '';
            }}
          />
          <IconButton label="Attach files" disabled={!canAttach} onClick={() => fileInput.current?.click()}><Plus size={17} /></IconButton>
          {session.status === 'running' && !text.trim() ? (
            <button type="button" className="send-button" aria-label="Stop" title="Stop" onClick={() => void attempt(() => api.interrupt(session.id))}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="send-button" aria-label="Send" title="Send" disabled={!text.trim() || uploading > 0 || blocked}>
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
