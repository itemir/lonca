// What a workspace's pull request is waiting for, in one place, so the header, the Checks tab and
// the server's check before a merge can't disagree.
import type { CheckRun, Checks, LocalState, MergeMethod, MergeSettings, PrSummary, PullRequest, Session, Workspace } from './types.ts';

export type PrKind =
  | 'none'
  | 'merging'
  | 'merged'
  | 'closed'
  /** Last known to be open, while it can't be checked. Never "ready", since that can't be known. */
  | 'open'
  | 'draft'
  | 'checking'
  | 'conflicts'
  | 'failing'
  | 'changes-requested'
  | 'needs-review'
  | 'behind'
  | 'checks-running'
  | 'blocked'
  /** GitHub would merge it, but says a check isn't passing, though none it listed failed. */
  | 'unstable'
  | 'not-pushed'
  /** The workspace's own checkout couldn't be read, so nobody can say what's in the pull request. */
  | 'local-unknown'
  | 'differs'
  | 'not-committed'
  | 'lead-working'
  | 'agent-working'
  | 'ready';

/** Green for ready, lilac for merged, amber for waiting, red for blocked, grey for nothing to do. */
export type PrTone = 'ready' | 'merged' | 'waiting' | 'blocked' | 'muted';

export type Working = 'lead' | 'agent' | null;

export interface PrStatusInput {
  /** The latest read, or null before the first one. */
  checks: Checks | null;
  /** The last known summary, for when the latest read can't say. */
  known: PrSummary | null | undefined;
  workspace: Pick<Workspace, 'status' | 'createdAt' | 'pendingOperation'>;
  working: Working;
  /** A merge request is running now. */
  merging: boolean;
  /**
   * GitHub accepted a merge that a read hasn't shown yet. Unlike a running request, it only shows
   * while the pull request can be read, so a stopped workspace falls back to what's known.
   */
  awaitingMerge?: boolean;
}

export interface PrStatus {
  kind: PrKind;
  tone: PrTone;
  /** Short enough for a narrow panel, and never the base branch's name, which can be any length. */
  label: string;
  /** The label in full, base branch and all, for its tooltip. */
  detail: string;
  /** Every reason that applies, in full, for the Checks tab. */
  reasons: string[];
  merge: 'primary' | 'plain' | null;
  archive: boolean;
  refreshSoon: boolean;
  /** How long until it's worth reading again. */
  refreshMs: number;
  /** The pull request this is about, from the latest read or the last known summary. */
  pr: PrSummary | null;
  /** Set when it's the last known summary, shown because the pull request can't be read now. */
  stale: { asOf: number; why: 'stopped' | 'unreachable' | 'loading'; note: string } | null;
}

export const NORMAL_REFRESH_MS = 30_000;
const BUSY_REFRESH_MS = 15_000;
const SETTLING_REFRESH_MS = 5_000;

const MERGE_STATES = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'];
/** GitHub merges only these straight away. UNSTABLE is a failing check that isn't required. */
const MERGEABLE_STATES = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'];
const CAN_MERGE = ['ADMIN', 'MAINTAIN', 'WRITE'];

/** GitHub's merge state, with anything missing or unfamiliar taken as UNKNOWN, which never reads as ready. */
export function mergeState(value: unknown): string {
  const state = typeof value === 'string' ? value.toUpperCase() : '';
  return MERGE_STATES.includes(state) ? state : 'UNKNOWN';
}

export const MERGE_METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];

/** The methods the repository allows, or all of them when GitHub didn't say, so it can refuse. */
export function allowedMethods(repo: MergeSettings | null): MergeMethod[] {
  if (!repo) return MERGE_METHODS;
  const allowed: Record<MergeMethod, boolean> = {
    squash: repo.squashMergeAllowed,
    merge: repo.mergeCommitAllowed,
    rebase: repo.rebaseMergeAllowed,
  };
  const methods = MERGE_METHODS.filter((method) => allowed[method]);
  return methods.length > 0 ? methods : MERGE_METHODS;
}

/** The user's usual method on GitHub, if it's allowed here, or else the first that is. */
export function defaultMethod(repo: MergeSettings | null): MergeMethod {
  const methods = allowedMethods(repo);
  const usual = repo?.viewerDefaultMergeMethod?.toLowerCase() as MergeMethod | undefined;
  return usual && methods.includes(usual) ? usual : methods[0];
}

/** A pull request opened before the workspace belongs to an earlier one that had the same branch name. */
export function predates(pr: Pick<PullRequest, 'createdAt'>, workspaceCreatedAt: number): boolean {
  return Date.parse(pr.createdAt) < workspaceCreatedAt;
}

export function summarize(pr: PullRequest, checkedAt: number): PrSummary {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    checkedAt,
  };
}

/**
 * The newer of what this page read itself and what the workspace last recorded. The workspace's
 * copy is only published when it changes, so the page's own read can be the more recent.
 */
export function latestKnown(read: Checks | null, recorded: PrSummary | null | undefined): PrSummary | null {
  if (read && read.github === 'connected' && read.checkedAt >= (recorded?.checkedAt ?? 0)) {
    return read.pr ? summarize(read.pr, read.checkedAt) : null;
  }
  return recorded ?? null;
}

/** Who's taking a turn in the workspace. Anything they push after a merge won't be in it. */
export function whoIsWorking(sessions: Session[], workspaceId: string): Working {
  const busy = sessions.filter((session) => session.workspaceId === workspaceId && !session.closedAt && session.status === 'running');
  if (busy.some((session) => session.role === 'lead')) return 'lead';
  return busy.length > 0 ? 'agent' : null;
}

/** Why GitHub wouldn't merge it right now, or null if it would. The server refuses a merge for the same reasons. */
export function mergeBlocker(checks: Checks): string | null {
  const pr = checks.pr;
  if (!pr) return 'There’s no pull request for this branch.';
  if (pr.state === 'MERGED') return `#${pr.number} is already merged.`;
  if (pr.state === 'CLOSED') return `#${pr.number} was closed.`;
  const state = mergeState(pr.mergeStateStatus);
  if (pr.isDraft || state === 'DRAFT') return `#${pr.number} is a draft.`;
  if (state === 'DIRTY' || pr.mergeable === 'CONFLICTING') return `#${pr.number} has conflicts with ${pr.baseRefName}.`;
  const permission = checks.repo?.viewerPermission;
  if (permission && !CAN_MERGE.includes(permission)) return `Your GitHub account can’t merge pull requests in this repository.`;
  if (!MERGEABLE_STATES.includes(state)) return `GitHub can’t merge #${pr.number} right now.`;
  return null;
}

/** How a merge that GitHub accepted, but hasn't shown as done, was left. */
export interface PendingMerge {
  outcome: string;
  number: number;
  head: string;
  /** Given up on: GitHub usually catches up in seconds, and this stops waiting after a while. */
  expired?: boolean;
}

/** Whether to keep showing a merge GitHub accepted as under way: until a read shows it done or changed, or it's given up on. */
export function stillAwaiting(merge: PendingMerge | null, checks: Checks | null): boolean {
  if (!merge || merge.outcome !== 'pending' || merge.expired) return false;
  const pr = checks?.pr;
  return !pr || (pr.state === 'OPEN' && pr.number === merge.number && pr.headRefOid === merge.head);
}

/** A count for the header, which has room for two digits. */
const short = (count: number, label: string) => `${count > 99 ? '99+' : count} ${label}`;

/** A sentence for one or for many, where `%` stands for how many. */
const count = (amount: number, one: string, many: string) => (amount === 1 ? one : many.replace('%', String(amount)));

/** Whether any check actually ran. A skipped one didn't. */
const anyRan = (checks: CheckRun[]) => checks.some((check) => check.status !== 'skipped');

/** A workspace that can be archived the usual way, with the trash icon's Archive. */
function archivable(workspace: PrStatusInput['workspace']): boolean {
  if (workspace.status === 'ready' || workspace.status === 'stopped') return true;
  return workspace.status === 'error' && workspace.pendingOperation !== 'archive' && workspace.pendingOperation !== 'delete';
}

interface Reason {
  kind: PrKind;
  tone: PrTone;
  label: string;
  detail: string;
}

/** Everything that stands between an open pull request and "ready", most serious first. */
function openReasons(checks: Checks, pr: PullRequest, working: Working): Reason[] {
  const base = pr.baseRefName;
  const failing = checks.checks.filter((check) => check.status === 'failure').length;
  const pending = checks.checks.some((check) => check.status === 'pending');
  const state = mergeState(pr.mergeStateStatus);
  const review = pr.reviewDecision || null;
  const local = checks.local;
  const reasons: Reason[] = [];
  const add = (kind: PrKind, tone: PrTone, label: string, detail: string) => reasons.push({ kind, tone, label, detail });

  if (pr.isDraft || state === 'DRAFT') add('draft', 'muted', 'Draft', 'It’s a draft. Mark it ready for review on GitHub before merging it.');
  if (pr.mergeable === 'UNKNOWN' || state === 'UNKNOWN') add('checking', 'muted', 'Checking…', 'GitHub is still working out whether it can be merged.');
  if (state === 'DIRTY' || pr.mergeable === 'CONFLICTING') add('conflicts', 'blocked', 'Has conflicts', `Conflicts with ${base}.`);
  if (failing > 0) add('failing', 'blocked', short(failing, failing === 1 ? 'check failing' : 'checks failing'), count(failing, '1 check is failing.', '% checks are failing.'));
  if (review === 'CHANGES_REQUESTED') add('changes-requested', 'blocked', 'Changes requested', 'A reviewer asked for changes.');
  if (state === 'BLOCKED' && review === 'REVIEW_REQUIRED') add('needs-review', 'waiting', 'Needs review', `${base}’s rules need an approving review before it can be merged.`);
  if (state === 'BEHIND') add('behind', 'waiting', 'Out of date', `Behind ${base}, and ${base}’s rules need branches to be up to date.`);
  // A protected branch reports BLOCKED while its required checks run, which isn't a rule to look up.
  if (state === 'BLOCKED' && review !== 'REVIEW_REQUIRED') {
    if (pending) add('checks-running', 'waiting', 'Checks running', `Checks are still running, and ${base}’s rules wait for them.`);
    else add('blocked', 'waiting', 'Blocked', `A rule on ${base} blocks merging. GitHub shows which.`);
  }
  // Ready needs GitHub to say so. This one would merge, but not every check passed.
  if (state === 'UNSTABLE' && failing === 0 && !pending) {
    add('unstable', 'waiting', 'Checks not passing', 'GitHub says not every check passed, though it would still merge it.');
  }
  // Lonca's own reasons: a merge takes only what's in the pull request, and archiving loses the rest.
  // Labels stay short enough to sit beside Merge in the panel. The tooltip and the card say it in full.
  if (!local) {
    add('local-unknown', 'waiting', 'Local work unknown', `Lonca couldn’t read this workspace, so it can’t tell whether everything here is in #${pr.number}.`);
  } else if (local.unpushed !== null && local.unpushed > 0) {
    add('not-pushed', 'waiting', short(local.unpushed, 'not pushed'), count(local.unpushed, '1 commit here isn’t in the pull request.', '% commits here aren’t in the pull request.'));
  } else if (local.unpushed === null && local.head !== pr.headRefOid) {
    add('differs', 'waiting', 'Differs from the PR', 'This workspace’s branch doesn’t match the pull request.');
  }
  if (local && local.uncommitted > 0) {
    add('not-committed', 'waiting', short(local.uncommitted, 'not committed'), count(local.uncommitted, '1 change here isn’t committed.', '% changes here aren’t committed.'));
  }
  if (pending && !reasons.some((reason) => reason.kind === 'checks-running')) add('checks-running', 'waiting', 'Checks running', 'Checks are still running.');
  if (working === 'lead') add('lead-working', 'waiting', 'Lead is working', 'The Lead is working, and may still change this branch.');
  if (working === 'agent') add('agent-working', 'waiting', 'An agent is working', 'An agent is working, and may still change this branch.');
  return reasons;
}

/** Says the checks passed only when some ran: plenty of repositories have none. */
function readyDetail(checks: CheckRun[]): string {
  return `GitHub can merge it, ${anyRan(checks) ? 'its checks passed' : 'no checks ran'}, and everything in this workspace is in it.`;
}

/** What the merge dialog shows, read just before it opened. That's what gets merged. */
export interface MergeSnapshot {
  pr: PullRequest;
  checks: CheckRun[];
  repo: MergeSettings | null;
  local: LocalState | null;
  working: Working;
}

/**
 * What the merge dialog warns about: every reason the header can give while it still offers Merge,
 * so the dialog never reads calmer than the header did.
 */
export function mergeWarnings(snapshot: MergeSnapshot): string[] {
  const { pr, local, checks } = snapshot;
  const base = pr.baseRefName;
  const lines: string[] = [];
  if (snapshot.working === 'lead') lines.push(`The Lead is still working. Anything it pushes after this won’t be in ${base}.`);
  if (snapshot.working === 'agent') lines.push(`An agent is still working. Anything it pushes after this won’t be in ${base}.`);
  if (!local) {
    lines.push('Lonca couldn’t check whether everything here is in the pull request.');
  } else if (local.unpushed !== null && local.unpushed > 0) {
    lines.push(count(local.unpushed, '1 commit here isn’t in the pull request, so it won’t be merged.', '% commits here aren’t in the pull request, so they won’t be merged.'));
  } else if (local.unpushed === null && local.head !== pr.headRefOid) {
    lines.push('This workspace’s branch doesn’t match the pull request.');
  }
  if (local && local.uncommitted > 0) {
    lines.push(count(local.uncommitted, '1 uncommitted change isn’t in the pull request.', '% uncommitted changes aren’t in the pull request.'));
  }
  const failing = checks.filter((check) => check.status === 'failure').length;
  if (failing > 0) lines.push(count(failing, '1 check is failing.', '% checks are failing.'));
  const running = checks.filter((check) => check.status === 'pending').length;
  if (running > 0) lines.push(count(running, '1 check is still running.', '% checks are still running.'));
  if (pr.reviewDecision === 'CHANGES_REQUESTED') lines.push(`Changes were requested on #${pr.number}.`);
  return lines;
}

/** Sooner while GitHub is still settling something, which it usually does in seconds. */
export function refreshInterval(checks: Checks | null, merging: boolean): number {
  const pr = checks?.pr;
  if (merging || (pr?.state === 'OPEN' && (pr.mergeable === 'UNKNOWN' || mergeState(pr.mergeStateStatus) === 'UNKNOWN'))) return SETTLING_REFRESH_MS;
  if (pr?.state === 'OPEN' && checks!.checks.some((check) => check.status === 'pending')) return BUSY_REFRESH_MS;
  return NORMAL_REFRESH_MS;
}

function staleNote(status: Workspace['status']): string {
  if (status === 'stopped') return 'Start the workspace to check again.';
  if (status === 'archived') return 'Restore the workspace to check again.';
  return '';
}

/** The pull request's state for a workspace's header and Checks tab. */
export function prStatus(input: PrStatusInput): PrStatus {
  const { checks, workspace, working } = input;
  const refreshMs = refreshInterval(checks, input.merging || Boolean(input.awaitingMerge));
  const status = (fields: Omit<PrStatus, 'refreshSoon' | 'refreshMs' | 'archive' | 'merge' | 'stale'> & Partial<PrStatus>): PrStatus => ({
    merge: null,
    archive: false,
    stale: null,
    refreshMs,
    refreshSoon: refreshMs < NORMAL_REFRESH_MS,
    ...fields,
  });
  const none = status({ kind: 'none', tone: 'muted', label: '', detail: '', reasons: [], pr: null });
  const fresh = checks?.github === 'connected' && checks.pr && !predates(checks.pr, workspace.createdAt) ? checks.pr : null;
  const known = input.known ?? null;

  const merging = (pr: PrSummary | null) => status({
    kind: 'merging', tone: 'muted', label: 'Merging…', detail: 'Merging the pull request.', reasons: ['Merging the pull request.'], pr,
  });
  // What the user asked for comes first, even if GitHub can't be reached while it happens.
  if (input.merging) return merging(fresh ? summarize(fresh, checks!.checkedAt) : known);
  if (checks?.github === 'not-github' || checks?.github === 'missing-token') return none;

  if (workspace.status !== 'ready' || !checks || checks.github === 'error') {
    if (!known) return none;
    const why = workspace.status !== 'ready' ? 'stopped' : checks ? 'unreachable' : 'loading';
    const note = why === 'stopped' ? staleNote(workspace.status) : why === 'unreachable' ? checks?.error || 'GitHub couldn’t be reached.' : '';
    const stale = { asOf: known.checkedAt, why, note } as const;
    if (known.state === 'MERGED') {
      return status({ kind: 'merged', tone: 'merged', label: 'Merged', detail: `Merged into ${known.baseRefName}.`, reasons: [`Merged into ${known.baseRefName}.`], pr: known, stale, archive: archivable(workspace) });
    }
    if (known.state === 'CLOSED') {
      return status({ kind: 'closed', tone: 'muted', label: 'Closed', detail: 'Closed without merging.', reasons: ['Closed without merging.'], pr: known, stale });
    }
    const label = known.isDraft ? 'Draft' : 'Open';
    return status({ kind: known.isDraft ? 'draft' : 'open', tone: 'muted', label, detail: `${label}.`, reasons: [`${label}.`], pr: known, stale });
  }

  if (!fresh) return none;
  const pr = fresh;
  const summary = summarize(pr, checks.checkedAt);
  if (pr.state === 'MERGED') {
    const unpushed = checks.local?.unpushed ?? 0;
    const reasons = [`Merged into ${pr.baseRefName}.`];
    if (unpushed > 0) {
      reasons.push(unpushed === 1
        ? `1 commit on this branch isn’t in #${pr.number}, so it isn’t in ${pr.baseRefName}.`
        : `${unpushed} commits on this branch aren’t in #${pr.number}, so they aren’t in ${pr.baseRefName}.`);
    }
    return status({ kind: 'merged', tone: 'merged', label: 'Merged', detail: `Merged into ${pr.baseRefName}.`, reasons, pr: summary, archive: archivable(workspace) });
  }
  if (pr.state === 'CLOSED') {
    return status({ kind: 'closed', tone: 'muted', label: 'Closed', detail: 'Closed without merging.', reasons: ['Closed without merging.'], pr: summary });
  }
  // GitHub took the merge and is finishing it, so offering Merge again would only confuse.
  if (input.awaitingMerge) return merging(summary);

  const reasons = openReasons(checks, pr, working);
  const merge = mergeBlocker(checks) === null && workspace.status === 'ready';
  const first = reasons[0];
  const ready = readyDetail(checks.checks);
  const details = reasons.length > 0 ? reasons.map((reason) => reason.detail) : [`Ready to merge. ${ready}`];
  if (!anyRan(checks.checks)) details.push('No checks ran on it, so only the Lead’s report says whether it works.');
  if (pr.reviewDecision === 'APPROVED') details.push('A reviewer approved it.');
  if (!first) {
    return status({ kind: 'ready', tone: 'ready', label: 'Ready to merge', detail: ready, reasons: details, pr: summary, merge: merge ? 'primary' : null });
  }
  return status({ kind: first.kind, tone: first.tone, label: first.label, detail: first.detail, reasons: details, pr: summary, merge: merge ? 'plain' : null });
}
