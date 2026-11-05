import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle2, ChevronRight, CircleDashed, ExternalLink, File, FileCode, FileImage, FileText, Folder, FolderOpen, GitPullRequest,
  ListTree, MinusCircle, RefreshCw, Search, TriangleAlert, X, XCircle,
} from 'lucide-react';
import type { ChangeSet, CheckRun, Checks, FileEntry, Project, SearchHit, Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { basename, dirname, runtimeName, safeUrl } from '../format.ts';
import { usePolled, useResizable } from '../hooks.ts';
import { attempt, useStore } from '../store.ts';
import { BottomPanel } from './BottomPanel.tsx';
import { IconButton, Spinner } from './ui.tsx';

type PanelTab = 'files' | 'changes' | 'checks';

function iconForFile(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(extension)) return <FileImage size={14} className="file-icon image" />;
  if (['md', 'txt', 'rst', 'license'].includes(extension) || /^(license|readme|notice)/i.test(name)) return <FileText size={14} className="file-icon doc" />;
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'rb', 'java', 'c', 'h', 'cpp', 'css', 'html', 'sh', 'json', 'yaml', 'yml', 'toml'].includes(extension)) {
    return <FileCode size={14} className="file-icon code" />;
  }
  return <File size={14} className="file-icon" />;
}

function FileTree({ workspace, onOpen }: { workspace: Workspace; onOpen: (path: string) => void }) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const loading = useRef(new Set<string>());

  const loadDirectory = async (path: string) => {
    if (loading.current.has(path)) return;
    loading.current.add(path);
    try {
      const entries = await api.listFiles(workspace.id, path);
      setChildren((current) => ({ ...current, [path]: entries }));
      setFailed(null);
    } catch (error) {
      setFailed((error as Error).message);
    } finally {
      loading.current.delete(path);
    }
  };

  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
  }, [workspace.id]);

  // Agents change files all the time, so what's on screen keeps refreshing.
  useEffect(() => {
    if (workspace.status !== 'ready') return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void loadDirectory('.');
      for (const path of expanded) void loadDirectory(path);
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, workspace.status, expanded]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderEntries = (path: string, depth: number) =>
    (children[path] ?? []).map((entry) => (
      <div key={entry.path}>
        <button
          type="button"
          className={`tree-row ${entry.ignored ? 'ignored' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          aria-expanded={entry.type === 'dir' ? expanded.has(entry.path) : undefined}
          onClick={() => (entry.type === 'dir' ? toggle(entry.path) : onOpen(entry.path))}
        >
          {entry.type === 'dir'
            ? (expanded.has(entry.path) ? <FolderOpen size={14} className="file-icon folder" /> : <Folder size={14} className="file-icon folder" />)
            : iconForFile(entry.name)}
          <span className="tree-name">{entry.name}</span>
        </button>
        {entry.type === 'dir' && expanded.has(entry.path) && renderEntries(entry.path, depth + 1)}
      </div>
    ));

  if (failed && !children['.']) return <div className="panel-empty">{failed}</div>;
  if (!children['.']) return <div className="panel-empty"><Spinner /></div>;
  if (children['.'].length === 0) return <div className="panel-empty">This workspace has no files yet.</div>;
  return <div className="file-tree">{renderEntries('.', 0)}</div>;
}

function SearchResults({ workspace, query, onOpen }: { workspace: Workspace; query: string; onOpen: (path: string, line?: number) => void }) {
  const [names, setNames] = useState<SearchHit[]>([]);
  const [content, setContent] = useState<SearchHit[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setNames([]);
      setContent([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const [fileHits, textHits] = await Promise.all([
        api.search(workspace.id, text, 'names').catch(() => []),
        api.search(workspace.id, text, 'content').catch(() => []),
      ]);
      if (!cancelled) {
        setNames(fileHits);
        setContent(textHits);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, workspace.id]);

  if (!query.trim()) return <div className="panel-empty">Search file names and contents.</div>;
  if (names.length === 0 && content.length === 0) return <div className="panel-empty">No matches for “{query}”.</div>;
  return (
    <div className="search-results">
      {names.map((hit) => (
        <button key={hit.path} type="button" className="tree-row" onClick={() => onOpen(hit.path)}>
          {iconForFile(basename(hit.path))}
          <span className="tree-name">{basename(hit.path)}</span>
          <span className="tree-dir">{dirname(hit.path)}</span>
        </button>
      ))}
      {content.length > 0 && <div className="panel-subheading">In file contents</div>}
      {content.map((hit) => (
        <button key={`${hit.path}:${hit.line}`} type="button" className="content-hit" onClick={() => onOpen(hit.path, hit.line)}>
          <span className="content-hit-path">{hit.path}:{hit.line}</span>
          <span className="content-hit-text">{hit.text}</span>
        </button>
      ))}
    </div>
  );
}

const STATUS_NAMES = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', '?': 'New' } as const;

function ChangesList({ changes, error, onOpen }: {
  changes: ChangeSet | null;
  error: string | null;
  onOpen: (path: string, untracked: boolean, oldPath?: string) => void;
}) {
  if (!changes) return <div className="panel-empty">{error ?? <Spinner />}</div>;
  if (changes.files.length === 0) return <div className="panel-empty">No changes yet. This branch matches {changes.base}.</div>;
  return (
    <div className="changes-list">
      <div className="changes-summary">
        <span>
          {changes.added > 0 && <span className="added">+{changes.added} </span>}
          {changes.removed > 0 && <span className="removed">-{changes.removed} </span>}
          compared with {changes.base}
        </span>
      </div>
      {changes.files.map((file) => (
        <button key={file.path} type="button" className="change-row" onClick={() => onOpen(file.path, file.status === '?', file.oldPath)}>
          <span className={`change-status status-${file.status === '?' ? 'new' : file.status.toLowerCase()}`} title={STATUS_NAMES[file.status]}>
            {file.status === '?' ? 'N' : file.status}
          </span>
          <span className="change-name">
            {basename(file.path)}
            {dirname(file.path) && <span className="tree-dir">{dirname(file.path)}</span>}
          </span>
          {!file.binary && (
            <span className="change-counts">
              {file.added > 0 && <span className="added">+{file.added}</span>}
              {file.removed > 0 && <span className="removed">-{file.removed}</span>}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function CheckIcon({ status }: { status: CheckRun['status'] }) {
  switch (status) {
    case 'success': return <CheckCircle2 size={14} className="check-success" />;
    case 'failure': return <XCircle size={14} className="check-failure" />;
    case 'skipped': return <MinusCircle size={14} className="icon-dim" />;
    default: return <CircleDashed size={14} className="check-pending" />;
  }
}

function ChecksPanel({ checks, error, onCreatePr, hasWork }: {
  checks: Checks | null;
  error: string | null;
  onCreatePr: () => void;
  hasWork: boolean;
}) {
  if (!checks) return <div className="panel-empty">{error ?? <Spinner />}</div>;
  if (checks.github === 'not-github') return <div className="panel-empty">Checks appear for repositories hosted on GitHub.</div>;
  if (checks.github === 'missing-token') {
    return (
      <div className="panel-empty">
        Connect GitHub to see pull requests and checks, and to let agents push.
        <Link to="/settings" className="link-button">Connect GitHub</Link>
      </div>
    );
  }
  if (checks.github === 'error') return <div className="panel-empty"><TriangleAlert size={15} />{checks.error}</div>;
  if (!checks.pr) {
    return (
      <div className="panel-empty">
        No pull request for this branch yet.
        {hasWork && <button type="button" className="button button-small" onClick={onCreatePr}>Create a pull request</button>}
      </div>
    );
  }
  return (
    <div className="checks">
      <a className="pr-card" href={safeUrl(checks.pr.url)} target="_blank" rel="noreferrer">
        <GitPullRequest size={15} />
        <span className="pr-title">{checks.pr.title}</span>
        <span className="pr-number">#{checks.pr.number}<ExternalLink size={12} /></span>
      </a>
      <div className="pr-state">
        {checks.pr.isDraft ? 'Draft' : checks.pr.state.toLowerCase().replace(/^./, (char) => char.toUpperCase())}
        {checks.pr.reviewDecision === 'APPROVED' && ', approved'}
        {checks.pr.reviewDecision === 'CHANGES_REQUESTED' && ', changes requested'}
        {checks.pr.mergeable === 'CONFLICTING' && ', has conflicts'}
      </div>
      {checks.checks.length === 0 && <div className="panel-empty">No checks have reported on this pull request.</div>}
      {checks.checks.map((check) => (
        <a key={check.name} className="check-row" href={safeUrl(check.url)} target="_blank" rel="noreferrer">
          <CheckIcon status={check.status} />
          <span>{check.name}</span>
        </a>
      ))}
    </div>
  );
}

export function RightPanel({ workspace, project, onOpenFile, onOpenDiff, onCreatePr }: {
  workspace: Workspace;
  project: Project;
  onOpenFile: (path: string, line?: number) => void;
  onOpenDiff: (path: string, untracked: boolean, oldPath?: string) => void;
  onCreatePr: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>('files');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [bottomOpen, setBottomOpen] = useState(true);
  const secrets = useStore((store) => store.secrets);
  const navigate = useNavigate();
  const width = useResizable('right', 340, 240, 760, 'x', true);
  const height = useResizable('bottom', 300, 120, 820, 'y', true);
  const ready = workspace.status === 'ready';
  const changes = usePolled(ready ? () => api.changes(workspace.id) : null, 5000, [workspace.id, ready]);
  const checks = usePolled(ready ? () => api.checks(workspace.id) : null, 30000, [workspace.id, ready, secrets.githubToken]);
  // The server updates the workspace's totals when a turn ends; the list follows them.
  useEffect(() => {
    if (ready) changes.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.diff?.added, workspace.diff?.removed, workspace.diff?.files]);
  const hasWork = useMemo(() => (changes.data?.files.length ?? 0) > 0 || (changes.data?.ahead ?? 0) > 0, [changes.data]);
  const pr = checks.data?.pr;

  const createPr = () => {
    if (!secrets.githubToken) {
      useStore.getState().toast('Connect GitHub first so the agent can push this branch.');
      navigate('/settings');
      return;
    }
    onCreatePr();
  };

  return (
    <aside className="right-panel" style={{ width: width.size }} aria-label="Workspace details">
      <div className="resize-handle resize-x right-handle" onPointerDown={width.onPointerDown} />
      <div className="right-header">
        {pr ? (
          <a className="button button-small" href={safeUrl(pr.url)} target="_blank" rel="noreferrer">
            <GitPullRequest size={13} /> #{pr.number}
          </a>
        ) : (
          hasWork && project.githubOwner && (
            <button type="button" className="button button-small" onClick={createPr}>
              <GitPullRequest size={13} /> Create PR
            </button>
          )
        )}
      </div>
      <div className="right-top">
        <div className="panel-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>All files</button>
          <button type="button" role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
            Changes <span className="count">{workspace.diff?.files ?? changes.data?.files.length ?? 0}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'checks'} className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}>Checks</button>
          <span className="spacer" />
          {tab === 'files' && (
            <IconButton label={searching ? 'Show the file tree' : 'Search files'} onClick={() => setSearching((value) => !value)}>
              {searching ? <ListTree size={15} /> : <Search size={15} />}
            </IconButton>
          )}
          {tab === 'changes' && <IconButton label="Refresh changes" onClick={changes.refresh}><RefreshCw size={14} /></IconButton>}
          {tab === 'checks' && <IconButton label="Refresh checks" onClick={checks.refresh}><RefreshCw size={14} /></IconButton>}
        </div>
        {tab === 'files' && searching && (
          <div className="panel-search">
            <Search size={14} />
            <input autoFocus aria-label="Search files" value={query} placeholder="Search this workspace" onChange={(event) => setQuery(event.target.value)} />
            {query && <IconButton label="Clear search" onClick={() => setQuery('')}><X size={13} /></IconButton>}
          </div>
        )}
        <div className="panel-body">
          {!ready && <div className="panel-empty">{statusNote(workspace)}</div>}
          {ready && tab === 'files' && !searching && <FileTree workspace={workspace} onOpen={onOpenFile} />}
          {ready && tab === 'files' && searching && <SearchResults workspace={workspace} query={query} onOpen={onOpenFile} />}
          {ready && tab === 'changes' && <ChangesList changes={changes.data} error={changes.error} onOpen={onOpenDiff} />}
          {ready && tab === 'checks' && <ChecksPanel checks={checks.data} error={checks.error} onCreatePr={createPr} hasWork={hasWork} />}
        </div>
      </div>
      {bottomOpen ? (
        <div className="right-bottom" style={{ height: height.size }}>
          <div className="resize-handle resize-y" onPointerDown={height.onPointerDown} />
          <BottomPanel workspace={workspace} project={project} onCollapse={() => setBottomOpen(false)} />
        </div>
      ) : (
        <button type="button" className="bottom-reopen" onClick={() => setBottomOpen(true)}>
          <ChevronRight size={14} className="rotated-up" /> Terminals
        </button>
      )}
    </aside>
  );
}

function statusNote(workspace: Workspace): string {
  switch (workspace.status) {
    case 'creating': return 'Files appear here once the workspace is ready.';
    case 'restoring': return 'Restoring this workspace…';
    case 'rebuilding': return 'Rebuilding this workspace…';
    case 'stopping': return 'Stopping…';
    case 'starting': return 'Starting…';
    case 'deleting': return 'Deleting…';
    case 'stopped': return `This workspace’s ${runtimeName(workspace)} is stopped.`;
    case 'archived': return 'This workspace is archived. Restore it to see its files.';
    case 'archiving': return 'Archiving…';
    default: return workspace.error ?? 'This workspace isn’t available.';
  }
}
