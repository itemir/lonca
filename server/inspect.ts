import path from 'node:path';
import type {
  ChangeSet, ChangedFile, CheckRun, Checks, DiffStat, FileContent, FileEntry, PullRequest, SearchHit, Workspace,
} from '../shared/types.ts';
import { exec, execText } from './sandbox.ts';
import { execEnv } from './env.ts';
import { getProject, getSecrets } from './store.ts';
import { HttpError } from './util.ts';
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

export async function getChecks(workspace: Workspace): Promise<Checks> {
  const project = getProject(workspace.projectId);
  if (!project?.githubOwner) return { github: 'not-github', pr: null, checks: [] };
  if (!project.settings.env.GH_TOKEN && !getSecrets().githubToken) return { github: 'missing-token', pr: null, checks: [] };
  const sandbox = await runningSandbox(workspace);
  const result = await exec(sandbox, [
    'gh', 'pr', 'view', workspace.branch,
    '--json', 'number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup',
  ], { workdir: workspace.path, env: execEnv(project), timeoutMs: 30000 });
  if (result.code !== 0) {
    const message = result.stderr.toString('utf8').trim();
    if (/no pull requests found/i.test(message)) return { github: 'connected', pr: null, checks: [] };
    return { github: 'error', error: message || 'GitHub could not be reached', pr: null, checks: [] };
  }
  const data = JSON.parse(result.stdout.toString('utf8')) as PullRequest & { statusCheckRollup?: unknown[] };
  const { statusCheckRollup, ...pr } = data;
  return { github: 'connected', pr, checks: (statusCheckRollup ?? []).map(normalizeCheck) };
}

const SAFE_NAME = /[^\w.\- ()]+/g;

export function safeAttachmentName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, '/')).replace(SAFE_NAME, '_').replace(/^\.+/, '');
  return base.slice(-120) || 'attachment';
}
