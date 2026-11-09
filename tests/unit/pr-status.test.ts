import { describe, expect, it } from 'vitest';
import {
  allowedMethods, defaultMethod, latestKnown, mergeBlocker, type MergeSnapshot, mergeWarnings, prStatus, type PrStatusInput, refreshInterval,
  stillAwaiting, whoIsWorking,
} from '../../shared/pr.ts';
import type { CheckRun, Checks, MergeSettings, PrSummary, PullRequest, Session } from '../../shared/types.ts';

const HEAD = 'a'.repeat(40);
const CREATED = Date.parse('2026-11-01T10:00:00Z');

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: 'Name terminals after the project and branch',
    url: 'https://github.com/itemir/lonca/pull/7',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: HEAD,
    baseRefName: 'main',
    createdAt: '2026-11-02T10:00:00Z',
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

const repo: MergeSettings = {
  mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH', viewerPermission: 'ADMIN',
};

function checks(overrides: Partial<PullRequest> = {}, extra: Partial<Checks> = {}): Checks {
  return {
    github: 'connected',
    pr: pr(overrides),
    checks: [{ name: 'test', status: 'success' }],
    repo,
    local: { head: HEAD, unpushed: 0, uncommitted: 0 },
    checkedAt: Date.parse('2026-11-03T14:02:00Z'),
    ...extra,
  };
}

const run = (status: CheckRun['status'], name: string = status): CheckRun => ({ name, status });

function status(input: Partial<PrStatusInput> = {}) {
  return prStatus({
    checks: checks(),
    known: null,
    workspace: { status: 'ready', createdAt: CREATED },
    working: null,
    merging: false,
    ...input,
  });
}

const known = (overrides: Partial<PrSummary> = {}): PrSummary => ({
  number: 7, title: 'T', url: 'https://github.com/itemir/lonca/pull/7', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: HEAD,
  checkedAt: Date.parse('2026-11-03T14:02:00Z'), ...overrides,
});

describe('the header’s pull request status', () => {
  it('says ready only when GitHub can merge it and everything here is in it', () => {
    const ready = status();
    expect(ready).toMatchObject({ kind: 'ready', tone: 'ready', label: 'Ready to merge', merge: 'primary', archive: false, refreshSoon: false });
    expect(ready.detail).toBe('GitHub can merge it, its checks passed, and everything in this workspace is in it.');
  });

  it('says checks passed only when some ran, which many repositories have none of', () => {
    for (const ran of [[], [run('skipped')]]) {
      const ready = status({ checks: checks({}, { checks: ran }) });
      expect(ready).toMatchObject({ kind: 'ready', detail: 'GitHub can merge it, no checks ran, and everything in this workspace is in it.' });
      expect(ready.reasons).toEqual([
        'Ready to merge. GitHub can merge it, no checks ran, and everything in this workspace is in it.',
        'No checks ran on it, so only the Lead’s report says whether it works.',
      ]);
    }
    expect(status({ checks: checks({}, { checks: [run('success'), run('skipped')] }) }).reasons).toEqual([
      'Ready to merge. GitHub can merge it, its checks passed, and everything in this workspace is in it.',
    ]);
  });

  it('treats an empty review decision as no review needed', () => {
    expect(status({ checks: checks({ reviewDecision: '' }) }).kind).toBe('ready');
    expect(status({ checks: checks({ reviewDecision: null }) }).kind).toBe('ready');
    expect(status({ checks: checks({ reviewDecision: 'APPROVED' }) }).reasons).toContain('A reviewer approved it.');
  });

  it('shows the first reason in the table’s order, and the card lists them all', () => {
    const many = status({
      checks: checks(
        { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' },
        { checks: [run('failure', 'lint'), run('failure', 'test'), run('pending', 'e2e')], local: { head: 'b'.repeat(40), unpushed: 2, uncommitted: 3 } },
      ),
      working: 'lead',
    });
    expect(many).toMatchObject({ kind: 'conflicts', tone: 'blocked', label: 'Has conflicts', detail: 'Conflicts with main.', merge: null });
    expect(many.reasons).toEqual([
      'Conflicts with main.',
      '2 checks are failing.',
      'A reviewer asked for changes.',
      '2 commits here aren’t in the pull request.',
      '3 changes here aren’t committed.',
      'Checks are still running.',
      'The Lead is working, and may still change this branch.',
    ]);
  });

  const rows: [string, Partial<PrStatusInput>, Partial<ReturnType<typeof status>>][] = [
    ['draft', { checks: checks({ isDraft: true, mergeStateStatus: 'DRAFT' }) }, { kind: 'draft', label: 'Draft', tone: 'muted', merge: null }],
    ['unknown mergeability', { checks: checks({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) }, { kind: 'checking', label: 'Checking…', refreshMs: 5000, merge: null }],
    ['conflicts', { checks: checks({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }) }, { kind: 'conflicts', tone: 'blocked', merge: null }],
    ['one failing check, which is required', { checks: checks({ mergeStateStatus: 'BLOCKED' }, { checks: [run('failure')] }) }, { kind: 'failing', label: '1 check failing', tone: 'blocked', merge: null }],
    ['a failing check that isn’t required', { checks: checks({ mergeStateStatus: 'UNSTABLE' }, { checks: [run('failure'), run('failure', 'b')] }) }, { kind: 'failing', label: '2 checks failing', merge: 'plain' }],
    ['changes requested', { checks: checks({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }) }, { kind: 'changes-requested', tone: 'blocked' }],
    ['review required', { checks: checks({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }) }, { kind: 'needs-review', label: 'Needs review', tone: 'waiting', merge: null }],
    ['behind', { checks: checks({ mergeStateStatus: 'BEHIND' }) }, { kind: 'behind', label: 'Out of date', detail: 'Behind main, and main’s rules need branches to be up to date.' }],
    ['blocked while checks run', { checks: checks({ mergeStateStatus: 'BLOCKED' }, { checks: [run('pending')] }) }, { kind: 'checks-running', label: 'Checks running', refreshMs: 15000, merge: null }],
    ['blocked by a rule', { checks: checks({ mergeStateStatus: 'BLOCKED' }) }, { kind: 'blocked', label: 'Blocked', detail: 'A rule on main blocks merging. GitHub shows which.', merge: null }],
    ['commits not pushed', { checks: checks({}, { local: { head: 'b'.repeat(40), unpushed: 2, uncommitted: 0 } }) }, {
      kind: 'not-pushed', label: '2 not pushed', detail: '2 commits here aren’t in the pull request.', merge: 'plain',
    }],
    ['one commit not pushed', { checks: checks({}, { local: { head: 'b'.repeat(40), unpushed: 1, uncommitted: 0 } }) }, {
      kind: 'not-pushed', label: '1 not pushed', detail: '1 commit here isn’t in the pull request.',
    }],
    ['a workspace that couldn’t be read', { checks: checks({}, { local: null }) }, {
      kind: 'local-unknown', label: 'Local work unknown', tone: 'waiting', merge: 'plain',
      detail: 'Lonca couldn’t read this workspace, so it can’t tell whether everything here is in #7.',
    }],
    ['a head the workspace doesn’t have', { checks: checks({}, { local: { head: 'b'.repeat(40), unpushed: null, uncommitted: 0 } }) }, {
      kind: 'differs', label: 'Differs from the PR', detail: 'This workspace’s branch doesn’t match the pull request.', merge: 'plain',
    }],
    ['uncommitted changes', { checks: checks({}, { local: { head: HEAD, unpushed: 0, uncommitted: 3 } }) }, {
      kind: 'not-committed', label: '3 not committed', detail: '3 changes here aren’t committed.',
    }],
    ['a lot of uncommitted changes', { checks: checks({}, { local: { head: HEAD, unpushed: 0, uncommitted: 250 } }) }, { label: '99+ not committed' }],
    ['checks running', { checks: checks({}, { checks: [run('success'), run('pending')] }) }, { kind: 'checks-running', refreshSoon: true, merge: 'plain' }],
    ['the Lead working', { working: 'lead' }, { kind: 'lead-working', label: 'Lead is working', merge: 'plain' }],
    ['an agent working', { working: 'agent' }, { kind: 'agent-working', label: 'An agent is working' }],
    ['hooks to run', { checks: checks({ mergeStateStatus: 'HAS_HOOKS' }) }, { kind: 'ready', merge: 'primary' }],
  ];

  it.each(rows)('handles %s', (_name, input, expected) => {
    expect(status(input)).toMatchObject(expected);
  });

  it('never says ready without a local comparison', () => {
    expect(status({ checks: checks({}, { local: null }) }).kind).not.toBe('ready');
    expect(status({ checks: checks({}, { local: { head: 'b'.repeat(40), unpushed: null, uncommitted: 0 } }) }).kind).not.toBe('ready');
    // Behind the pull request is fine: everything here is still in it.
    expect(status({ checks: checks({}, { local: { head: 'b'.repeat(40), unpushed: 0, uncommitted: 0 } }) }).kind).toBe('ready');
  });

  it('says when no checks ran', () => {
    expect(status({ checks: checks({}, { checks: [] }) }).reasons).toContain('No checks ran on it, so only the Lead’s report says whether it works.');
  });

  it('offers Merge only where GitHub would take it, from someone allowed to', () => {
    expect(status({ checks: checks({}, { repo: { ...repo, viewerPermission: 'READ' } }) }).merge).toBeNull();
    expect(status({ checks: checks({}, { repo: null }) }).merge).toBe('primary');
    expect(status({ checks: checks({ mergeStateStatus: 'BEHIND' }) }).merge).toBeNull();
    expect(status({ checks: checks({ mergeStateStatus: 'DIRTY' }) }).merge).toBeNull();
    expect(status({ merging: true }).merge).toBeNull();
  });

  it('shows a merge in flight with nothing to press', () => {
    expect(status({ merging: true })).toMatchObject({ kind: 'merging', label: 'Merging…', merge: null, archive: false, refreshMs: 5000 });
    // Even when GitHub can't be reached at that moment.
    const unreachable = { ...checks(), github: 'error' as const, error: 'timeout', pr: null };
    expect(status({ merging: true, checks: unreachable, known: known() })).toMatchObject({ kind: 'merging', pr: { number: 7 } });
  });

  it('offers Archive once it’s merged, and nothing once it’s closed', () => {
    expect(status({ checks: checks({ state: 'MERGED', mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }) }))
      .toMatchObject({ kind: 'merged', tone: 'merged', label: 'Merged', archive: true, merge: null, refreshSoon: false });
    expect(status({ checks: checks({ state: 'CLOSED' }) })).toMatchObject({ kind: 'closed', tone: 'muted', label: 'Closed', archive: false, merge: null });
  });

  it('says how many commits a merged branch has that its pull request doesn’t', () => {
    const merged = status({ checks: checks({ state: 'MERGED' }, { local: { head: 'b'.repeat(40), unpushed: 2, uncommitted: 0 } }) });
    expect(merged.reasons).toEqual(['Merged into main.', '2 commits on this branch aren’t in #7, so they aren’t in main.']);
  });

  it('has nothing to say without GitHub, a token or a pull request', () => {
    expect(status({ checks: { ...checks(), github: 'not-github', pr: null } }).kind).toBe('none');
    expect(status({ checks: { ...checks(), github: 'missing-token', pr: null } }).kind).toBe('none');
    expect(status({ checks: { ...checks(), pr: null } }).kind).toBe('none');
  });

  it('ignores a pull request opened before the workspace', () => {
    expect(status({ checks: checks({ createdAt: '2026-10-01T00:00:00Z', state: 'MERGED' }) })).toMatchObject({ kind: 'none', archive: false });
  });

  it('shows the last known summary, dimmed and without Merge, while the workspace is stopped', () => {
    const stopped = { status: 'stopped' as const, createdAt: CREATED };
    expect(status({ checks: null, known: known(), workspace: stopped })).toMatchObject({
      kind: 'open', label: 'Open', merge: null, stale: { why: 'stopped', note: 'Start the workspace to check again.' },
    });
    // Even when the latest read said it was ready.
    expect(status({ known: known(), workspace: stopped }).label).toBe('Open');
    expect(status({ checks: null, known: known({ state: 'MERGED' }), workspace: stopped })).toMatchObject({ kind: 'merged', archive: true });
    expect(status({ checks: null, known: known({ state: 'CLOSED' }), workspace: stopped })).toMatchObject({ kind: 'closed', archive: false });
    expect(status({ checks: null, known: known({ state: 'MERGED' }), workspace: { status: 'archived', createdAt: CREATED } }).archive).toBe(false);
    expect(status({ checks: null, known: null, workspace: stopped }).kind).toBe('none');
  });

  it('shows the last known summary when GitHub can’t be reached, rather than no pull request', () => {
    const failed: Checks = { ...checks(), github: 'error', error: 'HTTP 502', pr: null, checks: [] };
    expect(status({ checks: failed, known: known() })).toMatchObject({ kind: 'open', label: 'Open', merge: null, stale: { why: 'unreachable', note: 'HTTP 502' } });
    expect(status({ checks: failed, known: known({ state: 'MERGED' }) })).toMatchObject({ kind: 'merged', archive: true, stale: { why: 'unreachable' } });
  });

  it('shows the last known summary before the first read', () => {
    expect(status({ checks: null, known: known({ isDraft: true }) })).toMatchObject({ kind: 'draft', label: 'Draft', stale: { why: 'loading' } });
  });

  it('keeps labels short whatever the base branch is called', () => {
    const base = 'release/2026-11-very-long-branch-name-for-a-customer';
    for (const [, input] of rows) {
      const result = status({ ...input, checks: input.checks ? { ...input.checks, pr: { ...input.checks.pr!, baseRefName: base } } : checks({ baseRefName: base }) });
      expect(result.label).not.toContain(base);
      // The longest are "An agent is working", "Differs from the PR" and "99+ checks failing".
      expect(result.label.length).toBeLessThanOrEqual(19);
    }
  });
});

describe('evidence for ready', () => {
  it('takes a merge state that’s missing or new to Lonca as one GitHub is still working out', () => {
    for (const mergeStateStatus of [null, '', 'SOMETHING_NEW', 'clean-ish']) {
      expect(status({ checks: checks({ mergeStateStatus }) }), String(mergeStateStatus)).toMatchObject({ kind: 'checking', label: 'Checking…', merge: null });
    }
    expect(status({ checks: checks({ mergeStateStatus: 'clean' }) })).toMatchObject({ kind: 'ready', merge: 'primary' });
  });

  it('doesn’t call it ready when GitHub says a check isn’t passing, even with none listed as failing', () => {
    expect(status({ checks: checks({ mergeStateStatus: 'UNSTABLE' }) })).toMatchObject({
      kind: 'unstable', label: 'Checks not passing', tone: 'waiting', merge: 'plain',
      detail: 'GitHub says not every check passed, though it would still merge it.',
    });
  });

  it('treats a merge state of DRAFT as a draft', () => {
    expect(status({ checks: checks({ mergeStateStatus: 'DRAFT', isDraft: false }) })).toMatchObject({ kind: 'draft', merge: null });
  });
});

describe('a merge GitHub accepted but hasn’t shown yet', () => {
  const pending = { outcome: 'pending', number: 7, head: HEAD };

  it('keeps waiting until a read shows it done or changed, or it’s given up on', () => {
    expect(stillAwaiting(pending, checks())).toBe(true);
    expect(stillAwaiting(pending, null)).toBe(true);
    expect(stillAwaiting({ ...pending, expired: true }, checks())).toBe(false);
    expect(stillAwaiting(pending, checks({ state: 'MERGED' }))).toBe(false);
    expect(stillAwaiting(pending, checks({ headRefOid: 'c'.repeat(40) }))).toBe(false);
    expect(stillAwaiting({ ...pending, outcome: 'merged' }, checks())).toBe(false);
    expect(stillAwaiting(null, checks())).toBe(false);
  });

  it('shows as merging only while the pull request can be read', () => {
    expect(status({ awaitingMerge: true })).toMatchObject({ kind: 'merging', merge: null, refreshMs: 5000 });
    // Stopped: what's known, rather than a merge that seems to go on for ever.
    expect(status({ awaitingMerge: true, known: known(), workspace: { status: 'stopped', createdAt: CREATED } }))
      .toMatchObject({ kind: 'open', label: 'Open', stale: { why: 'stopped' } });
    expect(status({ awaitingMerge: true, checks: checks({ state: 'MERGED' }) })).toMatchObject({ kind: 'merged', archive: true });
  });
});

describe('how often it’s read', () => {
  it('reads every 5 seconds while GitHub settles something, every 15 while checks run, and every 30 otherwise', () => {
    expect(refreshInterval(checks(), false)).toBe(30000);
    expect(refreshInterval(null, false)).toBe(30000);
    expect(refreshInterval(checks({ state: 'MERGED', mergeStateStatus: 'UNKNOWN' }), false)).toBe(30000);
    expect(refreshInterval(checks(), true)).toBe(5000);
    expect(refreshInterval(checks({ mergeable: 'UNKNOWN' }), false)).toBe(5000);
    expect(refreshInterval(checks({ mergeStateStatus: 'UNKNOWN' }), false)).toBe(5000);
    expect(refreshInterval(checks({ mergeStateStatus: null }), false)).toBe(5000);
    expect(refreshInterval(checks({}, { checks: [run('pending')] }), false)).toBe(15000);
  });
});

describe('the merge dialog’s warnings', () => {
  const snapshot = (overrides: Partial<MergeSnapshot> = {}, prOverrides: Partial<PullRequest> = {}): MergeSnapshot => ({
    pr: { ...checks().pr!, ...prOverrides },
    checks: [run('success')],
    repo,
    local: { head: HEAD, unpushed: 0, uncommitted: 0 },
    working: null,
    ...overrides,
  });

  it('has nothing to add when it’s ready', () => {
    expect(mergeWarnings(snapshot())).toEqual([]);
  });

  it('repeats every reason the header gives while it still offers Merge', () => {
    expect(mergeWarnings(snapshot({ working: 'lead' }))).toEqual(['The Lead is still working. Anything it pushes after this won’t be in main.']);
    expect(mergeWarnings(snapshot({ working: 'agent' }))).toEqual(['An agent is still working. Anything it pushes after this won’t be in main.']);
    expect(mergeWarnings(snapshot({ local: { head: 'b'.repeat(40), unpushed: 2, uncommitted: 0 } })))
      .toEqual(['2 commits here aren’t in the pull request, so they won’t be merged.']);
    expect(mergeWarnings(snapshot({ local: { head: 'b'.repeat(40), unpushed: null, uncommitted: 0 } })))
      .toEqual(['This workspace’s branch doesn’t match the pull request.']);
    expect(mergeWarnings(snapshot({ local: { head: HEAD, unpushed: 0, uncommitted: 1 } }))).toEqual(['1 uncommitted change isn’t in the pull request.']);
    expect(mergeWarnings(snapshot({ checks: [run('failure'), run('success')] }))).toEqual(['1 check is failing.']);
  });

  it('says when checks are still running', () => {
    expect(mergeWarnings(snapshot({ checks: [run('pending'), run('pending', 'b'), run('success')] }))).toEqual(['2 checks are still running.']);
    expect(mergeWarnings(snapshot({ checks: [run('pending')] }))).toEqual(['1 check is still running.']);
    // The header would say the same, and still offer Merge.
    expect(status({ checks: checks({ mergeStateStatus: 'UNSTABLE' }, { checks: [run('pending'), run('pending', 'b')] }) }))
      .toMatchObject({ kind: 'checks-running', merge: 'plain' });
  });

  it('says when changes were requested and no rule stops the merge', () => {
    expect(mergeWarnings(snapshot({}, { reviewDecision: 'CHANGES_REQUESTED' }))).toEqual(['Changes were requested on #7.']);
    expect(status({ checks: checks({ reviewDecision: 'CHANGES_REQUESTED' }) })).toMatchObject({ kind: 'changes-requested', merge: 'plain' });
  });

  it('says when the workspace couldn’t be read', () => {
    expect(mergeWarnings(snapshot({ local: null }))).toEqual(['Lonca couldn’t check whether everything here is in the pull request.']);
  });

  it('puts them in order, most likely to lose work first', () => {
    expect(mergeWarnings(snapshot(
      { working: 'lead', local: { head: 'b'.repeat(40), unpushed: 1, uncommitted: 2 }, checks: [run('failure'), run('pending')] },
      { reviewDecision: 'CHANGES_REQUESTED' },
    ))).toEqual([
      'The Lead is still working. Anything it pushes after this won’t be in main.',
      '1 commit here isn’t in the pull request, so it won’t be merged.',
      '2 uncommitted changes aren’t in the pull request.',
      '1 check is failing.',
      '1 check is still running.',
      'Changes were requested on #7.',
    ]);
  });
});

describe('merge settings', () => {
  it('offers the allowed methods, starting from the user’s usual one', () => {
    expect(allowedMethods(null)).toEqual(['squash', 'merge', 'rebase']);
    expect(allowedMethods({ ...repo, squashMergeAllowed: false })).toEqual(['merge', 'rebase']);
    expect(defaultMethod(null)).toBe('squash');
    expect(defaultMethod({ ...repo, viewerDefaultMergeMethod: 'REBASE' })).toBe('rebase');
    expect(defaultMethod({ ...repo, viewerDefaultMergeMethod: 'SQUASH', squashMergeAllowed: false })).toBe('merge');
  });

  it('says why GitHub wouldn’t merge it', () => {
    expect(mergeBlocker(checks())).toBeNull();
    expect(mergeBlocker(checks({ mergeStateStatus: 'UNSTABLE' }))).toBeNull();
    expect(mergeBlocker(checks({ isDraft: true }))).toMatch(/draft/);
    expect(mergeBlocker(checks({ state: 'MERGED' }))).toMatch(/already merged/);
  });
});

describe('what’s known when it can’t be read', () => {
  it('takes the newer of the page’s own read and the workspace’s record', () => {
    const read = checks();
    expect(latestKnown(read, known({ checkedAt: read.checkedAt - 1, state: 'CLOSED' }))).toMatchObject({ state: 'OPEN', checkedAt: read.checkedAt });
    expect(latestKnown(read, known({ checkedAt: read.checkedAt + 1, state: 'MERGED' }))).toMatchObject({ state: 'MERGED' });
    expect(latestKnown({ ...read, pr: null }, known({ checkedAt: read.checkedAt - 1 }))).toBeNull();
    expect(latestKnown({ ...read, github: 'error' }, known())).toMatchObject({ state: 'OPEN' });
    expect(latestKnown(null, undefined)).toBeNull();
  });

  it('knows who’s working from the sessions', () => {
    const session = (overrides: Partial<Session>) => ({ workspaceId: 'w', status: 'idle', ...overrides }) as Session;
    expect(whoIsWorking([session({ role: 'lead', status: 'running' }), session({ role: 'agent', status: 'running' })], 'w')).toBe('lead');
    expect(whoIsWorking([session({ role: 'agent', status: 'running' })], 'w')).toBe('agent');
    expect(whoIsWorking([session({ status: 'running' })], 'w')).toBe('agent');
    expect(whoIsWorking([session({ role: 'lead', status: 'running', closedAt: 1 })], 'w')).toBeNull();
    expect(whoIsWorking([session({ role: 'lead', status: 'running', workspaceId: 'x' })], 'w')).toBeNull();
  });
});
