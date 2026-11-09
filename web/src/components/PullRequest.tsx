import { useEffect, useRef, useState } from 'react';
import {
  Archive, CircleAlert, CircleCheck, CircleDashed, CircleX, Crown, ExternalLink, FileDiff, FilePen, FileQuestionMark, GitCompare, GitCompareArrows, GitMerge,
  GitMergeConflict, GitPullRequest, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft, Lock, TriangleAlert, Upload, UserRoundSearch, Users,
  type LucideIcon,
} from 'lucide-react';
import { allowedMethods, defaultMethod, type MergeSnapshot, mergeWarnings, type PrKind, type PrStatus, whoIsWorking } from '../../../shared/pr.ts';
import type { CheckRun, MergeMethod, Project, Workspace } from '../../../shared/types.ts';
import { safeUrl } from '../format.ts';
import { currentPrStatus, mergePr, prEntry, refreshPr, setMergeDialogOpen, usePrStatus, usePrStore } from '../pr.ts';
import { useStore } from '../store.ts';
import { CloseWorkspaceDialog } from './CloseWorkspaceDialog.tsx';
import { Modal, Spinner, topDialog } from './ui.tsx';

// Every state has an icon and a word of its own: green and red are hard to tell apart for many people.
const ICONS: Record<PrKind, LucideIcon> = {
  none: GitPullRequest,
  merging: GitMerge,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  queued: GitPullRequestArrow,
  'auto-merge': GitPullRequestArrow,
  checking: CircleDashed,
  conflicts: GitMergeConflict,
  failing: CircleX,
  'changes-requested': FileDiff,
  'needs-review': UserRoundSearch,
  behind: GitCompareArrows,
  'checks-running': CircleDashed,
  blocked: Lock,
  unstable: CircleAlert,
  'not-pushed': Upload,
  'local-unknown': FileQuestionMark,
  differs: GitCompare,
  'not-committed': FilePen,
  'lead-working': Crown,
  'agent-working': Users,
  ready: CircleCheck,
};

/** The state's icon, or a spinner that turns in step with the others while it merges. */
export function PrIcon({ status, size = 14 }: { status: PrStatus; size?: number }) {
  if (status.kind === 'merging') return <Spinner size={size} />;
  const Icon = ICONS[status.kind];
  return <Icon size={size} className="pr-icon" aria-hidden="true" />;
}

function asOf(time: number): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? clock : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock}`;
}

/** What hovering says: the label in full, or how old a last known state is and why. */
function tooltip(status: PrStatus): string {
  if (!status.stale) return status.detail;
  return [`As of ${asOf(status.stale.asOf)}.`, status.stale.note].filter(Boolean).join(' ');
}

/** For the side panel's button while the panel is closed, which shows a dot for these two. */
export function panelNote(status: PrStatus): { kind: 'ready' | 'merged'; text: string } | null {
  if (!status.pr) return null;
  if (status.kind === 'ready') return { kind: 'ready', text: `#${status.pr.number} is ready to merge.` };
  if (status.kind === 'merged') return { kind: 'merged', text: `#${status.pr.number} is merged.` };
  return null;
}

const sentence = (label: string) => (/[.…]$/.test(label) ? label : `${label}.`);

function announcement(status: PrStatus): string {
  const number = status.pr ? `#${status.pr.number}` : '';
  switch (status.kind) {
    case 'merged': return `Pull request ${number} merged.`;
    case 'closed': return `Pull request ${number} was closed.`;
    case 'ready': return `Pull request ${number} is ready to merge.`;
    case 'merging': return `Merging pull request ${number}.`;
    default: return `Pull request ${number}: ${sentence(status.label)}`;
  }
}

/** Says when the pull request's state changes. Nothing on the first look, and nothing when a read changes nothing. */
export function PrAnnouncer({ workspace }: { workspace: Workspace }) {
  const status = usePrStatus(workspace);
  const [message, setMessage] = useState('');
  const seen = useRef<string | null>(null);
  const key = status.stale || status.kind === 'none' ? null : `${status.pr?.number}:${status.kind}:${status.label}`;
  useEffect(() => {
    if (key === null) return;
    if (seen.current !== null && seen.current !== key) setMessage(announcement(status));
    seen.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <div className="sr-only pr-announcer" role="status" aria-live="polite">{message}</div>;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many.replace('%', String(count)));

/** One line about the checks. A skipped check didn't run, so it isn't counted as passing. */
function checksSummary(checks: CheckRun[]): string {
  const count = (status: CheckRun['status']) => checks.filter((check) => check.status === status).length;
  const failing = count('failure');
  const running = count('pending');
  const passed = count('success');
  const skipped = count('skipped');
  const also = skipped > 0 ? `, and ${skipped} skipped` : '';
  if (failing + running + passed === 0) return `No checks ran${also}`;
  if (failing === 0 && running === 0) return `${plural(passed, '1 check passed', '% checks passed')}${also}`;
  const parts = [failing > 0 && `${failing} failing`, running > 0 && `${running} running`, passed > 0 && `${passed} passed`, skipped > 0 && `${skipped} skipped`];
  return `${plural(checks.length, '1 check', '% checks')}: ${parts.filter(Boolean).join(', ')}`;
}

const METHOD_LABELS: Record<MergeMethod, string> = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' };
const CONFIRM_LABELS: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };


function MergeDialog({ workspace, snapshot, onClose }: {
  workspace: Workspace;
  snapshot: MergeSnapshot;
  /** `toArchive` when focus should go on to Archive: it's merged, and the user is still here in the dialog. */
  onClose: (toArchive: boolean) => void;
}) {
  const { pr } = snapshot;
  const methods = allowedMethods(snapshot.repo);
  const [method, setMethod] = useState<MergeMethod>(() => defaultMethod(snapshot.repo));
  const [failure, setFailure] = useState<string | null>(null);
  const merging = usePrStore((store) => store.entries[workspace.id]?.merging ?? false);
  const open = useRef(true);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMergeDialogOpen(workspace.id, true);
    return () => {
      open.current = false;
      setMergeDialogOpen(workspace.id, false);
    };
  }, [workspace.id]);

  const confirm = async () => {
    setFailure(null);
    const attempt = await mergePr(workspace, { number: pr.number, headOid: pr.headRefOid, base: pr.baseRefName, method });
    // Closed while it merged: the toast and the header say how it went.
    if (!open.current) return;
    if (attempt.outcome === 'failed' || attempt.outcome === 'unknown') {
      setFailure(attempt.message ?? 'Nothing was merged.');
      return;
    }
    // Only if focus is still here, with nothing opened over the dialog, such as Search, while it merged.
    const dialog = body.current?.closest('[role="dialog"]');
    const here = Boolean(dialog) && dialog === topDialog() && dialog!.contains(document.activeElement);
    onClose(attempt.outcome === 'merged' && here);
  };

  const base = pr.baseRefName;
  return (
    <Modal className="sheet-dialog merge-dialog" title={`Merge #${pr.number} into ${base}?`} onClose={() => onClose(false)}>
      <div className="close-target">
        <span>{pr.title}</span>
        <code>{workspace.branch} → {base}</code>
      </div>
      <div className="confirm-body merge-body" ref={body}>
        <p>{checksSummary(snapshot.checks)}</p>
        {snapshot.queue ? (
          <p>{base} uses a merge queue, so GitHub merges #{pr.number} from it when it’s ready.</p>
        ) : methods.length > 1 && (
          <div className="segmented merge-methods" role="radiogroup" aria-label="How to merge">
            {methods.map((option) => (
              <label key={option} className={method === option ? 'active' : ''}>
                <input
                  type="radio"
                  name={`merge-method-${workspace.id}`}
                  value={option}
                  checked={method === option}
                  disabled={merging}
                  onChange={() => setMethod(option)}
                />
                {METHOD_LABELS[option]}
              </label>
            ))}
          </div>
        )}
        {mergeWarnings(snapshot).map((line) => <p key={line} className="close-warning">{line}</p>)}
        {failure && <p className="form-error" role="alert">{failure}</p>}
      </div>
      <div className="modal-actions">
        {/* Merging reaches beyond Lonca, so Enter pressed out of habit mustn't do it. */}
        <button type="button" className="button" autoFocus onClick={() => onClose(false)}>{merging ? 'Close' : 'Cancel'}</button>
        {/* Kept focusable while it merges, like the header's Merge, so focus doesn't drop to the page. */}
        <button
          type="button"
          className="button button-primary"
          aria-disabled={merging || undefined}
          onClick={() => {
            if (!merging) void confirm();
          }}
        >
          {merging ? <><Spinner size={13} /> Merging…</> : snapshot.queue ? 'Add to merge queue' : CONFIRM_LABELS[method]}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The top of the side panel: the pull request's state, which opens it on GitHub, and the one thing
 * to do next. It renders nothing at all when there's nothing to show, so a narrow window can hide it.
 */
export function PrHeader({ workspace, project, hasWork, onCreatePr }: {
  workspace: Workspace;
  project: Project;
  hasWork: boolean;
  onCreatePr: () => void;
}) {
  const status = usePrStatus(workspace);
  const [preparing, setPreparing] = useState(false);
  const [merging, setMerging] = useState<MergeSnapshot | null>(null);
  const [archiving, setArchiving] = useState(false);
  const archive = useRef<HTMLButtonElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const toast = useStore((store) => store.toast);

  const openMerge = async () => {
    setPreparing(true);
    // What the dialog shows has to be what GitHub says now, not as of the last poll.
    await refreshPr(workspace.id, { force: true });
    setPreparing(false);
    const latest = currentPrStatus(workspace);
    const read = prEntry(workspace.id).checks;
    const number = status.pr?.number;
    if (latest.merge && read?.pr) {
      setMerging({
        pr: read.pr, checks: read.checks, repo: read.repo, queue: Boolean(read.queue?.enabled), local: read.local,
        working: whoIsWorking(useStore.getState().sessions, workspace.id),
      });
    } else if (latest.kind === 'merged') {
      toast(`#${number} is already merged.`);
    } else {
      toast(`#${number} can’t be merged right now. ${latest.stale ? latest.stale.note || 'GitHub couldn’t be reached.' : latest.detail}`);
    }
  };

  const closeMerge = (toArchive: boolean) => {
    setMerging(null);
    requestAnimationFrame(() => {
      // Only straight after the user's own merge, with this workspace in front of them.
      if (toArchive && archive.current) {
        archive.current.focus();
        return;
      }
      // The dialog gives focus back to Merge, but Merge goes once it's queued or merged by someone
      // else. The pull request's link stays. Focus that went somewhere else went there on purpose.
      if (!document.activeElement || document.activeElement === document.body) link.current?.focus();
    });
  };

  if (status.kind === 'none' || !status.pr) {
    if (!hasWork || !project.githubOwner) return null;
    return (
      <button type="button" className="button button-small pr-action" onClick={onCreatePr}>
        <GitPullRequest size={13} /> Create PR
      </button>
    );
  }

  const pr = status.pr;
  return (
    <>
      <a
        ref={link}
        className={`pr-status pr-tone-${status.tone} ${status.stale ? 'is-stale' : ''}`}
        href={safeUrl(pr.url)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Pull request #${pr.number}: ${sentence(status.label)} Opens GitHub.`}
        title={tooltip(status)}
      >
        <PrIcon status={status} />
        {status.stale?.why === 'unreachable' && <TriangleAlert size={11} className="pr-unreachable" aria-hidden="true" />}
        <span className="pr-label">{status.label}</span>
        <span className="pr-number">#{pr.number}<ExternalLink size={11} aria-hidden="true" /></span>
      </a>
      {(status.merge || status.kind === 'merging') && (
        <button
          key="merge"
          type="button"
          className={`button button-small pr-action ${status.merge === 'primary' ? 'button-primary' : ''}`}
          aria-label={`Merge pull request #${pr.number}`}
          // Never `disabled`, which would push focus off it while it reads the status again or merges.
          // The dialog gives focus back here, and a keyboard user mustn't be dropped at the top of the page.
          aria-disabled={preparing || status.kind === 'merging' || undefined}
          onClick={() => {
            if (!preparing && status.kind !== 'merging') void openMerge();
          }}
        >
          {preparing ? <Spinner size={13} /> : <GitMerge size={13} aria-hidden="true" />} Merge
        </button>
      )}
      {status.archive && (
        <button key="archive" ref={archive} type="button" className="button button-small button-primary pr-action" aria-label="Archive this workspace" onClick={() => setArchiving(true)}>
          <Archive size={13} aria-hidden="true" /> Archive
        </button>
      )}
      {merging && <MergeDialog workspace={workspace} snapshot={merging} onClose={closeMerge} />}
      {archiving && <CloseWorkspaceDialog workspace={workspace} onClose={() => setArchiving(false)} />}
    </>
  );
}
