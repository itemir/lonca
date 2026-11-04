import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { File, FolderGit2, GitBranch, Search } from 'lucide-react';
import type { SearchHit } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { Modal } from './ui.tsx';

interface Result {
  key: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
  go: () => void;
}

export function SearchPalette() {
  const open = useStore((store) => store.searchOpen);
  const setOpen = useStore((store) => store.setSearchOpen);
  const workspaces = useStore((store) => store.workspaces);
  const projects = useStore((store) => store.projects);
  const openTab = useStore((store) => store.openTab);
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<SearchHit[]>([]);
  const currentId = /^\/w\/([^/]+)/.exec(location.pathname)?.[1];
  const current = workspaces.find((workspace) => workspace.id === currentId && workspace.status === 'ready');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
      setFiles([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !current || !query.trim()) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.search(current.id, query, 'names').then((hits) => {
        if (!cancelled) setFiles(hits.slice(0, 8));
      }, () => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, current?.id]);

  const results = useMemo<Result[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (...parts: (string | null)[]) => !needle || parts.some((part) => part?.toLowerCase().includes(needle));
    const close = () => setOpen(false);
    const workspaceResults: Result[] = workspaces
      .filter((workspace) => matches(workspace.title, workspace.name, workspace.branch))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10)
      .map((workspace) => ({
        key: `w:${workspace.id}`,
        icon: <GitBranch size={15} />,
        title: workspace.title ?? workspace.name,
        detail: `${projects.find((project) => project.id === workspace.projectId)?.name ?? ''} / ${workspace.name}`,
        go: () => {
          close();
          navigate(`/w/${workspace.id}`);
        },
      }));
    const projectResults: Result[] = projects
      .filter((project) => needle && matches(project.name))
      .map((project) => ({
        key: `p:${project.id}`,
        icon: <FolderGit2 size={15} />,
        title: project.name,
        detail: 'Project settings',
        go: () => {
          close();
          navigate(`/projects/${project.id}`);
        },
      }));
    const fileResults: Result[] = files.map((hit) => ({
      key: `f:${hit.path}`,
      icon: <File size={15} />,
      title: hit.path.split('/').at(-1) ?? hit.path,
      detail: hit.path,
      go: () => {
        close();
        if (current) openTab(current.id, { kind: 'file', path: hit.path });
      },
    }));
    return [...workspaceResults, ...projectResults, ...fileResults];
  }, [query, workspaces, projects, files, current, navigate, openTab, setOpen]);

  if (!open) return null;

  return (
    <Modal title="Search" onClose={() => setOpen(false)}>
      <div className="palette-input">
        <Search size={15} />
        <input
          autoFocus
          aria-label="Search workspaces, projects and files"
          placeholder="Workspaces, projects and files"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelected((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              results[selected]?.go();
            }
          }}
        />
      </div>
      <div className="palette-results">
        {results.length === 0 && <div className="panel-empty">{query ? `Nothing matches “${query}”.` : 'No workspaces yet.'}</div>}
        {results.map((result, index) => (
          <button
            key={result.key}
            type="button"
            className={`palette-row ${index === selected ? 'selected' : ''}`}
            onMouseEnter={() => setSelected(index)}
            onClick={result.go}
          >
            {result.icon}
            <span className="palette-title">{result.title}</span>
            <span className="palette-detail">{result.detail}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
