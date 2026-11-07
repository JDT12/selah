const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * Minimal Markdown for CHANGELOG.md (and DISASTER-RECOVERY.md and MAINTENANCE-PROCEDURE.md in the admin console):
 * headings, (nested) bullet and numbered lists, paragraphs, tables, fenced code blocks, inline code/bold/italic.
 */
export function renderMarkdown(md) {
  const out = [];
  let para = [];
  let table = null; // rows of cells
  let code = null; // lines inside ``` … ```
  const stack = []; // open lists: { indent, tag }
  const closeLists = (toIndent = -1) => {
    while (stack.length && stack.at(-1).indent > toIndent) { out.push(`</li></${stack.pop().tag}>`); }
  };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
    out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
      rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    table = null;
  };

  for (const line of md.split('\n')) {
    if (code) {
      if (/^\s*```/.test(line)) { out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = null; } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushPara(); flushTable(); closeLists(); code = []; continue; }
    if (/^\s*\|/.test(line)) { flushPara(); closeLists(); (table ??= []).push(cells(line)); continue; }
    flushTable();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^(\s*)(-|\d+\.)\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); closeLists();
      if (h[1].length === 1) continue; // document title is the dialog heading
      out.push(`<h${h[1].length + 1}>${inline(h[2].replace(/^\[([^\]]+)\]/, 'Version $1'))}</h${h[1].length + 1}>`);
    } else if (li) {
      flushPara();
      const indent = li[1].length;
      const tag = li[2] === '-' ? 'ul' : 'ol';
      if (!stack.length || indent > stack.at(-1).indent) { out.push(`<${tag}><li>`); stack.push({ indent, tag }); }
      else { closeLists(indent); out.push('</li><li>'); }
      out.push(inline(li[3]));
    } else if (!line.trim()) {
      flushPara();
    } else if (stack.length && /^\s+/.test(line)) {
      out.push(` ${inline(line.trim())}`); // wrapped list item
    } else {
      closeLists();
      para.push(line.trim());
    }
  }
  if (code) out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  flushPara(); flushTable(); closeLists();
  return out.join('');
}
