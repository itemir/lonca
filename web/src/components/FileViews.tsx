import { useEffect, useMemo, useRef } from 'react';
import hljs from 'highlight.js/lib/common';
import type { FileContent, Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { usePolled } from '../hooks.ts';
import { Spinner } from './ui.tsx';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown',
  html: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', sql: 'sql', swift: 'swift', kt: 'kotlin', lua: 'lua',
};

const MAX_HIGHLIGHT_BYTES = 256 * 1024;

function highlightLines(file: FileContent): string[] | null {
  const extension = file.path.split('.').at(-1)?.toLowerCase() ?? '';
  const language = LANGUAGE_BY_EXTENSION[extension];
  if (!language || file.content.length > MAX_HIGHLIGHT_BYTES || !hljs.getLanguage(language)) return null;
  // A token can span lines, so each line reopens the spans the previous one left open.
  const html = hljs.highlight(file.content, { language, ignoreIllegals: true }).value;
  const open: string[] = [];
  return html.split('\n').map((line) => {
    const prefix = open.join('');
    for (const match of line.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (match[0] === '</span>') open.pop();
      else open.push(match[0]);
    }
    return `${prefix}${line}${'</span>'.repeat(open.length)}`;
  });
}

export function FileTab({ workspace, path, line }: { workspace: Workspace; path: string; line?: number }) {
  const { data: file, error } = usePolled(() => api.readFile(workspace.id, path), 5000, [workspace.id, path]);
  const target = useRef<HTMLDivElement>(null);
  const highlighted = useMemo(() => (file && file.encoding === 'utf8' ? highlightLines(file) : null), [file]);

  useEffect(() => {
    if (line && file) target.current?.scrollIntoView({ block: 'center' });
  }, [line, file?.path]);

  if (error && !file) return <div className="tab-message">{error}</div>;
  if (!file) return <div className="tab-message"><Spinner /></div>;
  if (file.encoding === 'base64') {
    if (file.mime.startsWith('image/')) {
      return <div className="image-preview"><img src={`data:${file.mime};base64,${file.content}`} alt={path} /></div>;
    }
    return <div className="tab-message">{path} is a binary file, so it isn’t shown here.</div>;
  }
  const lines = file.content.split('\n');
  return (
    <div className="file-view">
      {file.truncated && <div className="file-note">Showing the first 2 MB of this file.</div>}
      <div className="code-lines">
        {lines.map((text, index) => (
          <div key={index} className={`code-line ${line === index + 1 ? 'target' : ''}`} ref={line === index + 1 ? target : undefined}>
            <span className="line-number">{index + 1}</span>
            {highlighted
              ? <code dangerouslySetInnerHTML={{ __html: highlighted[index] ?? '' }} />
              : <code>{text}</code>}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'context' | 'note';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
    } else if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: raw });
    } else if (!inHunk) {
      if (raw.startsWith('rename from ') || raw.startsWith('rename to ')) rows.push({ kind: 'note', text: raw });
      if (raw.startsWith('Binary files')) rows.push({ kind: 'note', text: 'This is a binary file, so its changes aren’t shown.' });
    } else if (raw.startsWith('+')) {
      rows.push({ kind: 'add', text: raw.slice(1), newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      rows.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++ });
    } else if (raw.startsWith(' ')) {
      rows.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (raw.startsWith('\\')) {
      rows.push({ kind: 'note', text: raw.slice(2) });
    }
  }
  return rows;
}

export function DiffTab({ workspace, path, untracked, oldPath }: { workspace: Workspace; path: string; untracked: boolean; oldPath?: string }) {
  const { data: diff, error } = usePolled(() => api.diff(workspace.id, path, untracked, oldPath), 5000, [workspace.id, path, untracked, oldPath]);
  const rows = useMemo(() => (diff !== null ? parseUnifiedDiff(diff) : []), [diff]);
  if (error && diff === null) return <div className="tab-message">{error}</div>;
  if (diff === null) return <div className="tab-message"><Spinner /></div>;
  if (rows.length === 0) return <div className="tab-message">{path} has no changes compared with origin/{workspace.baseBranch}.</div>;
  return (
    <div className="file-view">
      <div className="diff-view">
        {rows.map((row, index) => (
          <div key={index} className={`diff-row diff-${row.kind}`}>
            <span className="line-number">{row.oldLine ?? ''}</span>
            <span className="line-number">{row.newLine ?? ''}</span>
            <span className="diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''}</span>
            <code>{row.text}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
