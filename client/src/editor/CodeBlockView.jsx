import { useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';

const LABELS = {
  bash: 'Bash', c: 'C', cpp: 'C++', csharp: 'C#', css: 'CSS', diff: 'Diff', go: 'Go', graphql: 'GraphQL',
  ini: 'INI / TOML', java: 'Java', javascript: 'JavaScript', json: 'JSON', kotlin: 'Kotlin', less: 'Less',
  lua: 'Lua', makefile: 'Makefile', markdown: 'Markdown', objectivec: 'Objective-C', perl: 'Perl',
  php: 'PHP', 'php-template': 'PHP template', plaintext: 'Plain text', powershell: 'PowerShell', python: 'Python',
  'python-repl': 'Python REPL', r: 'R', ruby: 'Ruby', rust: 'Rust', scss: 'SCSS', shell: 'Shell session',
  sql: 'SQL', swift: 'Swift', typescript: 'TypeScript', vbnet: 'VB.NET', wasm: 'WebAssembly', xml: 'HTML / XML',
  yaml: 'YAML',
};

export default function CodeBlockView({ node, updateAttributes, extension, editor }) {
  const [copied, setCopied] = useState(false);
  const languages = extension.options.lowlight.listLanguages()
    .map((l) => ({ value: l, label: LABELS[l] ?? l }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <NodeViewWrapper className="code-block">
      <div className="code-toolbar" contentEditable={false}>
        <select value={node.attrs.language ?? ''} disabled={!editor.isEditable}
          onChange={(e) => updateAttributes({ language: e.target.value || null })}>
          <option value="">Auto-detect</option>
          {languages.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <button type="button" className="btn btn-small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre spellCheck={false}>
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
