import { memo, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [copied, setCopied] = useState(false);
  const known = language && hljs.getLanguage(language);
  const html = known ? hljs.highlight(code, { language: language!, ignoreIllegals: true }).value : null;
  return (
    <div className="code-block">
      <button
        type="button"
        className="code-copy"
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {/* highlight.js escapes the code, and nothing else reaches this HTML. */}
      {html !== null
        ? <pre><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
        : <pre><code>{code}</code></pre>}
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code({ className, children }) {
    const code = String(children ?? '');
    const language = /language-([\w-]+)/.exec(className ?? '')?.[1] ?? null;
    if (language || code.includes('\n')) return <CodeBlock language={language} code={code.replace(/\n$/, '')} />;
    return <code className="inline-code">{children}</code>;
  },
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
  // Loading a remote image would let text written by an agent send data off the machine.
  img: ({ src, alt }) => <a href={String(src ?? '')} target="_blank" rel="noreferrer noopener">{alt || 'Image'}</a>,
  table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
