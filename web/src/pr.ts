import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { latestKnown, prStatus, refreshInterval, whoIsWorking, type PrStatus } from '../../shared/pr.ts';
import type { Checks, MergeMethod, MergeOutcome, Workspace } from '../../shared/types.ts';
import { ApiError, api } from './api.ts';
import { useStore } from './store.ts';

// Each workspace's pull request, kept outside any component so that a merge and what's known
// survive the side panel closing, a resize, a tab switch or a visit to another workspace.

export interface MergeAttempt {
  outcome: MergeOutcome;
  message?: string;
  number: number;
  head: string;
  at: number;
}

export interface PrEntry {
  /** The latest read, which is an error when GitHub or Lonca couldn't answer it. */
  checks: Checks | null;
  /** The latest read GitHub answered. */
  good: Checks | null;
  /** The request whose answer is shown. An answer to an earlier one is dropped when it comes. */
  applied: number;
  sentAt: number;
  inFlight: number;
  merging: boolean;
  lastMerge: MergeAttempt | null;
  /** The merge dialog is showing, so a failure is told there rather than in a toast. */
  dialogOpen: boolean;
}

const EMPTY: PrEntry = { checks: null, good: null, applied: 0, sentAt: 0, inFlight: 0, merging: false, lastMerge: null, dialogOpen: false };

interface PrStore {
  entries: Record<string, PrEntry>;
  update(id: string, change: (entry: PrEntry) => Partial<PrEntry> | null): void;
}

export const usePrStore = create<PrStore>((set) => ({
  entries: {},
  update: (id, change) => set((store) => {
    const entry = store.entries[id] ?? EMPTY;
    const patch = change(entry);
    return patch ? { entries: { ...store.entries, [id]: { ...entry, ...patch } } } : store;
  }),
}));

export const prEntry = (id: string): PrEntry => usePrStore.getState().entries[id] ?? EMPTY;
const update = (id: string, change: (entry: PrEntry) => Partial<PrEntry> | null) => usePrStore.getState().update(id, change);

// Requests are numbered across every workspace, in the order they're sent.
let sequence = 0;

function unanswered(message: string): Checks {
  return { github: 'error', error: message, pr: null, checks: [], repo: null, queue: null, local: null, checkedAt: Date.now() };
}

/** What an answer changes, unless an answer to a later request is already shown. */
function shown(entry: PrEntry, request: number, checks: Checks): Partial<PrEntry> {
  if (entry.applied > request) return {};
  return { checks, applied: request, ...(checks.github === 'error' ? {} : { good: checks }) };
}

/**
 * Reads the pull request again. A background read leaves one already under way to finish; one the
 * user is waiting for, such as before the merge dialog opens, goes ahead anyway.
 */
export async function refreshPr(id: string, options: { force?: boolean } = {}): Promise<void> {
  if (prEntry(id).inFlight > 0 && !options.force) return;
  const request = ++sequence;
  update(id, (entry) => ({ sentAt: Date.now(), inFlight: entry.inFlight + 1 }));
  let checks: Checks;
  try {
    checks = await api.checks(id);
  } catch (error) {
    checks = unanswered(error instanceof Error ? error.message : String(error));
  }
  update(id, (entry) => ({ inFlight: entry.inFlight - 1, ...shown(entry, request, checks) }));
}

// GitHub has said it'll merge, so offering Merge again would only confuse. It usually catches up in seconds.
const PENDING_MS = 2 * 60 * 1000;

function awaitingMerge(entry: PrEntry): boolean {
  const last = entry.lastMerge;
  if (!last || last.outcome !== 'pending' || Date.now() - last.at > PENDING_MS) return false;
  const pr = entry.checks?.pr;
  return !pr || (pr.state === 'OPEN' && pr.number === last.number && pr.headRefOid === last.head);
}

function statusOf(workspace: Workspace, entry: PrEntry, working: ReturnType<typeof whoIsWorking>): PrStatus {
  return prStatus({
    checks: entry.checks,
    known: latestKnown(entry.good, workspace.pr),
    workspace,
    working,
    merging: entry.merging || awaitingMerge(entry),
  });
}

export function usePrStatus(workspace: Workspace): PrStatus {
  const entry = usePrStore((store) => store.entries[workspace.id]) ?? EMPTY;
  const working = useStore((store) => whoIsWorking(store.sessions, workspace.id));
  return useMemo(() => statusOf(workspace, entry, working), [workspace, entry, working]);
}

/** As it stands right now, for an action that has just read it again. */
export function currentPrStatus(workspace: Workspace): PrStatus {
  return statusOf(workspace, prEntry(workspace.id), whoIsWorking(useStore.getState().sessions, workspace.id));
}

export function setMergeDialogOpen(id: string, open: boolean): void {
  update(id, () => ({ dialogOpen: open }));
}

export interface MergeChoice {
  number: number;
  headOid: string;
  base: string;
  method: MergeMethod;
}

/**
 * Merges and says how it went: in the dialog if it's still open, or in a toast if it isn't. A
 * success is always told in a toast, since the dialog closes.
 */
export async function mergePr(workspace: Workspace, choice: MergeChoice): Promise<MergeAttempt> {
  const id = workspace.id;
  update(id, () => ({ merging: true, lastMerge: null }));
  let attempt: MergeAttempt;
  let checks: Checks | null = null;
  const at = () => ({ number: choice.number, head: choice.headOid, at: Date.now() });
  try {
    const reply = await api.mergePr(id, choice);
    checks = reply.checks;
    attempt = { outcome: reply.outcome, message: reply.message, ...at() };
  } catch (error) {
    // Lonca answering with a refusal means nothing was merged. No answer, or a crash, leaves it unknown.
    const refused = error instanceof ApiError && (error.status < 500 || error.status === 502);
    attempt = refused
      ? { outcome: 'failed', message: error.message, ...at() }
      : { outcome: 'unknown', message: `Lonca couldn’t confirm the merge. Check #${choice.number} on GitHub before trying again.`, ...at() };
  }
  // Counted as sent now, so that a read which started before this answer can't replace it.
  const request = ++sequence;
  update(id, (entry) => ({ merging: false, lastMerge: attempt, ...(checks ? shown(entry, request, checks) : {}) }));
  const { toast } = useStore.getState();
  if (attempt.outcome === 'merged') toast(`Merged #${choice.number} into ${choice.base}.`);
  else if (attempt.outcome === 'queued' || attempt.outcome === 'pending' || !prEntry(id).dialogOpen) toast(attempt.message ?? '');
  return attempt;
}

// Often enough to keep to each cadence closely, and cheap, since most beats send nothing.
const BEAT_MS = 1000;
// Focus and visibility can both fire for one return to the page.
const SETTLE_MS = 2000;

/** Keeps the pull request of the workspace on screen up to date. No other workspace is read. */
export function usePrPolling(id: string | undefined, running: boolean): void {
  const githubToken = useStore((store) => store.secrets.githubToken);
  const working = useStore((store) => (id ? whoIsWorking(store.sessions, id) : null));
  const wasWorking = useRef(working);

  // A turn that just ended may have pushed.
  useEffect(() => {
    if (id && running && wasWorking.current && !working) void refreshPr(id);
    wasWorking.current = working;
  }, [id, running, working]);

  useEffect(() => {
    if (!id || !running) return;
    const visible = () => document.visibilityState === 'visible';
    void refreshPr(id, { force: true });
    const beat = setInterval(() => {
      const entry = prEntry(id);
      const due = refreshInterval(entry.checks, entry.merging || awaitingMerge(entry));
      if (visible() && Date.now() - entry.sentAt >= due) void refreshPr(id);
    }, BEAT_MS);
    const back = () => {
      if (visible() && Date.now() - prEntry(id).sentAt > SETTLE_MS) void refreshPr(id);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(beat);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [id, running, githubToken]);
}
