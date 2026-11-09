import path from 'node:path';
import { mergeState, predates, summarize } from '../shared/pr.ts';
import type {
  ChangeSet, ChangedFile, CheckRun, Checks, DiffStat, FileContent, FileEntry, LocalState, MergeSettings, PrSummary, PullRequest, SearchHit, Workspace,
} from '../shared/types.ts';
import { exec, execText } from './sandbox.ts';
import { execEnv } from './env.ts';
import { parseGithubRepo } from './projects.ts';
import { getProject, getSecrets, getWorkspace } from './store.ts';
import { HttpError, errorMessage } from './util.ts';
import { publishWorkspace, runningSandbox } from './workspaces.ts';

// Every read of a checkout happens through the sandbox. The host never follows a path
// inside it, so a symlink an agent planted can't point the server at the host's files.

const READ_LIMIT = 2 * 1024 * 1024;
const DIFF_LIMIT = 4 * 1024 * 1024;

/** Keeps a client-supplied path inside the workspace. */
export function safeRelativePath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/^\/+/, '') || '.');
  if (normalized === '..' || normalized.startsWith('../')) throw new HttpError(400, 'That path is outside the workspace');
  return normalized;
}

export async function listDirectory(workspace: Workspace, directory: string): Promise<FileEntry[]> {
  const sandbox = await runningSandbox(workspace);
  const relative = safeRelativePath(directory);
  const listing = await exec(
    sandbox,
    // The `./` keeps a directory named `-delete` from being read as an instruction to find.
    ['find', `./${relative}`, '-mindepth', '1', '-maxdepth', '1', '!', '-name', '.git', '-printf', '%y\t%s\t%f\\0'],
    { workdir: workspace.path },
  );
  if (listing.code !== 0) throw new HttpError(404, `Could not list ${relative}`);
  const entries: FileEntry[] = listing.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const [kind, size, name] = row.split('\t');
      return {
        name,
        path: relative === '.' ? name : `${relative}/${name}`,
        type: kind === 'd' ? 'dir' : kind === 'l' ? 'symlink' : 'file',
        size: Number(size),
        ignored: false,
      } satisfies FileEntry;
    });
  if (entries.length > 0) {
    const check = await exec(sandbox, ['git', 'check-ignore', '-z', '--stdin'], {
      workdir: workspace.path,
      stdin: entries.map((entry) => entry.path).join('\0') + '\0',
    });
    const ignored = new Set(check.stdout.toString('utf8').split('\0'));
    for (const entry of entries) entry.ignored = ignored.has(entry.path);
  }
  return entries.sort((a, b) => {
    const dirFirst = Number(b.type === 'dir') - Number(a.type === 'dir');
    return dirFirst || a.name.localeCompare(b.name);
  });
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

export async function readWorkspaceFile(workspace: Workspace, file: string): Promise<FileContent> {
  const sandbox = await runningSandbox(workspace);
  const relative = safeRelativePath(file);
  const stat = await exec(sandbox, ['stat', '-Lc', '%F\t%s', '--', relative], { workdir: workspace.path });
  if (stat.code !== 0) throw new HttpError(404, `${relative} doesn’t exist`);
  const [kind, size] = stat.stdout.toString('utf8').trim().split('\t');
  if (!kind.startsWith('regular')) throw new HttpError(400, `${relative} isn’t a file`);
  const content = await exec(sandbox, ['head', '-c', String(READ_LIMIT), '--', relative], { workdir: workspace.path, maxBytes: READ_LIMIT + 1 });
  const mime = MIME[path.posix.extname(relative).toLowerCase()];
  const isBinary = content.stdout.subarray(0, 8000).includes(0);
  const asBase64 = isBinary || (mime !== undefined && mime !== 'image/svg+xml');
  return {
    path: relative,
    size: Number(size),
    truncated: Number(size) > READ_LIMIT,
    encoding: asBase64 ? 'base64' : 'utf8',
    content: content.stdout.toString(asBase64 ? 'base64' : 'utf8'),
    mime: mime ?? (isBinary ? 'application/octet-stream' : 'text/plain'),
  };
}

function rankFileMatch(filePath: string, query: string): number {
  const lower = filePath.toLowerCase();
  const base = path.posix.basename(lower);
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (base.includes(query)) return 2;
  if (lower.includes(query)) return 3;
  let position = 0;
  for (const char of query) {
    position = lower.indexOf(char, position);
    if (position < 0) return -1;
    position++;
  }
  return 4;
}

export async function searchFiles(workspace: Workspace, query: string, mode: 'names' | 'content'): Promise<SearchHit[]> {
  const needle = query.trim();
  if (!needle) return [];
  const sandbox = await runningSandbox(workspace);
  if (mode === 'content') {
    const result = await exec(sandbox, [
      'rg', '--line-number', '--no-heading', '--color', 'never', '--smart-case', '--fixed-strings',
      '--max-columns', '200', '--max-count', '5', '--max-filesize', '1M', '--', needle,
    ], { workdir: workspace.path, maxBytes: 512 * 1024, timeoutMs: 15000 });
    return result.stdout
      .toString('utf8')
      .split('\n')
      .slice(0, 200)
      .flatMap((row) => {
        const match = /^(.+?):(\d+):(.*)$/.exec(row);
        return match ? [{ path: match[1], line: Number(match[2]), text: match[3].trim() }] : [];
      });
  }
  const listed = await exec(sandbox, ['git', 'ls-files', '-co', '--exclude-standard', '-z'], { workdir: workspace.path, maxBytes: 8 * 1024 * 1024 });
  const lowered = needle.toLowerCase();
  return listed.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((file) => ({ path: file, rank: rankFileMatch(file, lowered) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
    .slice(0, 100)
    .map(({ path: file }) => ({ path: file }));
}

/** Parses `git diff --numstat -z`, where a rename is `a\tb\t\0old\0new\0`. */
export function parseNumstat(output: string): Map<string, { added: number; removed: number; binary: boolean; oldPath?: string }> {
  const parts = output.split('\0');
  const stats = new Map<string, { added: number; removed: number; binary: boolean; oldPath?: string }>();
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [added, removed, file] = parts[i].split('\t');
    const binary = added === '-';
    const entry = { added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary };
    if (file) {
      stats.set(file, entry);
    } else {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      stats.set(newPath, { ...entry, oldPath });
    }
  }
  return stats;
}

/** Parses `git diff --name-status -z`, where a rename is `R100\0old\0new\0`. */
export function parseNameStatus(output: string): Map<string, ChangedFile['status']> {
  const parts = output.split('\0');
  const statuses = new Map<string, ChangedFile['status']>();
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      i++;
      statuses.set(parts[++i], 'R');
    } else {
      const kind = code[0];
      statuses.set(parts[++i], kind === 'A' || kind === 'D' ? kind : 'M');
    }
  }
  return statuses;
}

// Polled in the background, so these must never take locks an agent's git commands need.
const CHANGES_SCRIPT = String.raw`
export GIT_OPTIONAL_LOCKS=0
base="$1"
target="origin/$base"
git rev-parse --verify --quiet "$target" >/dev/null || target=HEAD
mb=$(git merge-base HEAD "$target" 2>/dev/null || echo HEAD)
sep() { printf '\n--LONCA-SECTION--\n'; }
git diff --numstat -z -M "$mb"; sep
git diff --name-status -z -M "$mb"; sep
git ls-files --others --exclude-standard -z | head -c 262144 | while IFS= read -r -d '' file; do
  lines=0
  if [ -f "$file" ] && [ "$(stat -c %s -- "$file")" -lt 1048576 ]; then lines=$(wc -l < "$file"); fi
  printf '%s\t%s\0' "$lines" "$file"
done; sep
status=$(git status --porcelain --untracked-files=normal --ignore-submodules=none) && printf '%s' "$status" | grep -c .; sep
git rev-list --count "$mb..HEAD"
`;

export async function getChanges(workspace: Workspace): Promise<ChangeSet> {
  const sandbox = await runningSandbox(workspace);
  const output = await execText(sandbox, ['bash', '-c', CHANGES_SCRIPT, 'lonca-changes', workspace.baseBranch], {
    workdir: workspace.path,
    timeoutMs: 30000,
    maxBytes: 16 * 1024 * 1024,
  });
  const [numstat, nameStatus, untracked, uncommitted, ahead] = output.split('\n--LONCA-SECTION--\n');
  const stats = parseNumstat(numstat);
  const statuses = parseNameStatus(nameStatus);
  const files: ChangedFile[] = [...stats.entries()].map(([file, stat]) => ({
    path: file,
    oldPath: stat.oldPath,
    status: statuses.get(file) ?? 'M',
    added: stat.added,
    removed: stat.removed,
    binary: stat.binary,
  }));
  for (const row of (untracked ?? '').split('\0')) {
    if (!row) continue;
    const tab = row.indexOf('\t');
    files.push({ path: row.slice(tab + 1), status: '?', added: Number(row.slice(0, tab)), removed: 0, binary: false });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  updateDiffStat(workspace, { added, removed, files: files.length });
  // Missing when git status failed, which mustn't read as nothing to lose.
  const uncommittedCount = Number.parseInt(uncommitted ?? '', 10);
  return {
    base: `origin/${workspace.baseBranch}`,
    files,
    added,
    removed,
    uncommitted: Number.isNaN(uncommittedCount) ? null : uncommittedCount,
    ahead: Number(ahead ?? 0) || 0,
  };
}

function updateDiffStat(workspace: Workspace, diff: DiffStat): void {
  const current = workspace.diff;
  if (current && current.added === diff.added && current.removed === diff.removed && current.files === diff.files) return;
  workspace.diff = diff;
  publishWorkspace(workspace);
}

export async function refreshDiffStat(workspace: Workspace): Promise<void> {
  await getChanges(workspace);
}

const DIFF_SCRIPT = String.raw`
export GIT_OPTIONAL_LOCKS=0
base="$1"; file="$2"; untracked="$3"; old_file="$4"
if [ "$untracked" = 1 ]; then
  git diff --no-index --no-color -- /dev/null "$file"
  exit 0
fi
target="origin/$base"
git rev-parse --verify --quiet "$target" >/dev/null || target=HEAD
mb=$(git merge-base HEAD "$target" 2>/dev/null || echo HEAD)
set -- "$file"
[ -z "$old_file" ] || set -- "$@" "$old_file"
git --literal-pathspecs diff --no-color -M "$mb" -- "$@"
`;

export async function getFileDiff(workspace: Workspace, file: string, untracked: boolean, oldFile?: string): Promise<string> {
  const sandbox = await runningSandbox(workspace);
  const relative = safeRelativePath(file);
  const oldRelative = oldFile ? safeRelativePath(oldFile) : '';
  const result = await exec(
    sandbox,
    ['bash', '-c', DIFF_SCRIPT, 'lonca-diff', workspace.baseBranch, relative, untracked ? '1' : '0', oldRelative],
    { workdir: workspace.path, maxBytes: DIFF_LIMIT, timeoutMs: 30000 },
  );
  return result.stdout.toString('utf8');
}

export function normalizeCheck(raw: any): CheckRun {
  const name: string = raw.name ?? raw.context ?? 'Check';
  const url: string | undefined = raw.detailsUrl ?? raw.targetUrl ?? undefined;
  const conclusion = String(raw.conclusion ?? raw.state ?? '').toUpperCase();
  const running = raw.status && String(raw.status).toUpperCase() !== 'COMPLETED';
  if (running || conclusion === 'PENDING' || conclusion === 'EXPECTED' || conclusion === '') return { name, status: 'pending', url };
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return { name, status: 'success', url };
  if (conclusion === 'SKIPPED') return { name, status: 'skipped', url };
  return { name, status: 'failure', url };
}

const PR_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'reviewDecision', 'mergeable', 'mergeStateStatus', 'statusCheckRollup',
  'headRefOid', 'baseRefName', 'createdAt', 'mergedAt', 'closedAt', 'autoMergeRequest',
].join(',');

// Every gh call names github.com, so neither the checkout nor a project's GH_HOST can send it elsewhere.
export const GITHUB_HOST = 'github.com';

/** The repository as gh takes it, host included. */
export function repoArg(repo: { owner: string; name: string }): string {
  return `${GITHUB_HOST}/${repo.owner}/${repo.name}`;
}

/** The view command, which names the repository so that nothing an agent set in the checkout can redirect it. */
export function prViewArgs(branch: string, repo: { owner: string; name: string }): string[] {
  return ['gh', 'pr', 'view', branch, '--repo', repoArg(repo), '--json', PR_FIELDS];
}

// A query, never a mutation. `gh pr view` doesn't say whether the base branch has a merge queue.
const MERGE_SETTINGS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod viewerPermission
    pullRequest(number: $number) { isInMergeQueue isMergeQueueEnabled }
  }
}`;

export function mergeSettingsArgs(owner: string, name: string, number: number): string[] {
  // -f sends the names as strings even when they look like numbers, which -F wouldn't.
  return [
    'gh', 'api', 'graphql', '--hostname', GITHUB_HOST,
    '-f', `query=${MERGE_SETTINGS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
  ];
}

// Polled in the background too, so it must never take locks an agent's git commands need.
const LOCAL_STATE_SCRIPT = String.raw`
set -o pipefail
export GIT_OPTIONAL_LOCKS=0
pr_head="$1"
head=$(git rev-parse --verify --quiet HEAD) || exit 1
uncommitted=$(git status --porcelain | wc -l) || exit 1
if [ "$head" = "$pr_head" ]; then
  unpushed=0
elif [ -n "$pr_head" ] && git cat-file -e "$pr_head^{commit}" 2>/dev/null; then
  unpushed=$(git rev-list --count "$pr_head..HEAD") || exit 1
else
  unpushed=null
fi
printf '%s %s %s\n' "$head" "$unpushed" "$uncommitted"
`;

const SHA = /^[0-9a-f]{40}$/;

/** Reads what GitHub said about a pull request, trusting none of it to have the expected shape. */
export function parsePullRequest(raw: any): { pr: PullRequest; checks: CheckRun[] } | null {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.number) || raw.number <= 0) return null;
  const state = String(raw.state ?? '').toUpperCase();
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const optional = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const pr: PullRequest = {
    number: raw.number,
    title: text(raw.title),
    url: text(raw.url),
    state,
    isDraft: raw.isDraft === true,
    reviewDecision: optional(raw.reviewDecision),
    mergeable: optional(raw.mergeable),
    mergeStateStatus: mergeState(raw.mergeStateStatus),
    headRefOid: SHA.test(text(raw.headRefOid)) ? raw.headRefOid : '',
    baseRefName: text(raw.baseRefName),
    createdAt: text(raw.createdAt),
    mergedAt: optional(raw.mergedAt),
    closedAt: optional(raw.closedAt),
    autoMergeRequest: Boolean(raw.autoMergeRequest),
  };
  const rollup: unknown[] = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [];
  return { pr, checks: rollup.map(normalizeCheck) };
}

export function parseMergeSettings(output: string): { repo: MergeSettings; queue: { enabled: boolean; queued: boolean } } | null {
  try {
    const repository = JSON.parse(output)?.data?.repository;
    if (!repository || typeof repository !== 'object') return null;
    const method = String(repository.viewerDefaultMergeMethod ?? '').toUpperCase();
    return {
      repo: {
        mergeCommitAllowed: repository.mergeCommitAllowed === true,
        squashMergeAllowed: repository.squashMergeAllowed === true,
        rebaseMergeAllowed: repository.rebaseMergeAllowed === true,
        viewerDefaultMergeMethod: method === 'MERGE' || method === 'SQUASH' || method === 'REBASE' ? method : null,
        viewerPermission: typeof repository.viewerPermission === 'string' ? repository.viewerPermission.toUpperCase() : null,
      },
      queue: {
        enabled: repository.pullRequest?.isMergeQueueEnabled === true,
        queued: repository.pullRequest?.isInMergeQueue === true,
      },
    };
  } catch {
    return null;
  }
}

export function parseLocalState(output: string): LocalState | null {
  const [head, unpushed, uncommitted] = output.trim().split(/\s+/);
  if (!SHA.test(head ?? '') || !/^\d+$/.test(uncommitted ?? '') || !/^(\d+|null)$/.test(unpushed ?? '')) return null;
  return { head, unpushed: unpushed === 'null' ? null : Number(unpushed), uncommitted: Number(uncommitted) };
}

function emptyChecks(github: Checks['github'], checkedAt: number, error?: string): Checks {
  return { github, ...(error ? { error } : {}), pr: null, checks: [], repo: null, queue: null, local: null, checkedAt };
}

// Reads are numbered as they begin, before any of them waits on anything. Two that begin in the
// same millisecond still have an order, so a slow read that began first, such as a poll that
// overlapped a merge, can't put back what it saw over a newer one. Times are only for showing.
let reads = 0;
const latestRead = new Map<string, number>();

function sameSummary(a: PrSummary | null, b: PrSummary | null): boolean {
  if (!a || !b) return a === b;
  return a.number === b.number && a.title === b.title && a.url === b.url && a.state === b.state
    && a.isDraft === b.isDraft && a.baseRefName === b.baseRefName && a.headRefOid === b.headRefOid;
}

/** Keeps the latest read on the workspace, for when GitHub or its virtual machine can't be asked. */
function rememberPr(workspace: Workspace, pr: PullRequest | null, read: number, startedAt: number): void {
  // Publishing a workspace that's since been deleted would bring it back on every page.
  if (getWorkspace(workspace.id) !== workspace || (latestRead.get(workspace.id) ?? 0) > read) return;
  latestRead.set(workspace.id, read);
  const next = pr ? summarize(pr, startedAt) : null;
  const current = workspace.pr ?? null;
  if (sameSummary(current, next)) {
    // Nobody needs telling that nothing changed, but a page loaded later should know how recent it is.
    if (current) current.checkedAt = startedAt;
    else workspace.pr = null;
    return;
  }
  workspace.pr = next;
  publishWorkspace(workspace);
}

export async function getChecks(workspace: Workspace): Promise<Checks> {
  const read = ++reads;
  const startedAt = Date.now();
  const project = getProject(workspace.projectId);
  const repo = parseGithubRepo(project?.remoteUrl ?? null);
  if (!project?.githubOwner || !repo) return emptyChecks('not-github', startedAt);
  if (!project.settings.env.GH_TOKEN && !getSecrets().githubToken) return emptyChecks('missing-token', startedAt);
  const sandbox = await runningSandbox(workspace);
  const env = execEnv(project);
  try {
    const result = await exec(sandbox, prViewArgs(workspace.branch, repo), { workdir: workspace.path, env, timeoutMs: 30000 });
    if (result.code !== 0) {
      const message = result.stderr.toString('utf8').trim();
      if (/no pull requests found/i.test(message)) {
        rememberPr(workspace, null, read, startedAt);
        return emptyChecks('connected', startedAt);
      }
      // Not the same as having no pull request, which would offer to open another.
      return emptyChecks('error', startedAt, message || 'GitHub couldn’t be reached.');
    }
    let parsed: ReturnType<typeof parsePullRequest>;
    try {
      parsed = parsePullRequest(JSON.parse(result.stdout.toString('utf8')));
    } catch {
      parsed = null;
    }
    if (!parsed) return emptyChecks('error', startedAt, 'GitHub’s reply about this pull request couldn’t be read.');
    const { pr, checks } = parsed;
    // A branch name can come back after its workspace is deleted, and with it that workspace's pull request.
    if (predates(pr, workspace.createdAt)) {
      rememberPr(workspace, null, read, startedAt);
      return emptyChecks('connected', startedAt);
    }
    const [settings, local] = await Promise.all([
      pr.state === 'OPEN'
        ? exec(sandbox, mergeSettingsArgs(repo.owner, repo.name, pr.number), { workdir: workspace.path, env, timeoutMs: 30000 })
          .then((answer) => (answer.code === 0 ? parseMergeSettings(answer.stdout.toString('utf8')) : null), () => null)
        : null,
      exec(sandbox, ['bash', '-c', LOCAL_STATE_SCRIPT, 'lonca-pr-local', pr.headRefOid], { workdir: workspace.path, timeoutMs: 30000 })
        .then((answer) => (answer.code === 0 ? parseLocalState(answer.stdout.toString('utf8')) : null), () => null),
    ]);
    rememberPr(workspace, pr, read, startedAt);
    return {
      github: 'connected',
      pr,
      checks,
      repo: settings?.repo ?? null,
      queue: settings?.queue ?? null,
      local,
      checkedAt: startedAt,
    };
  } catch (error) {
    return emptyChecks('error', startedAt, errorMessage(error));
  }
}

const SAFE_NAME = /[^\w.\- ()]+/g;

export function safeAttachmentName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, '/')).replace(SAFE_NAME, '_').replace(/^\.+/, '');
  return base.slice(-120) || 'attachment';
}
