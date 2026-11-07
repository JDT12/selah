import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Pasting a quote copied from Logos. Logos adds the citation after a blank line:
 *
 *   These verses are often wrongly interpreted as an interlude in Solomon's argument.
 *
 *   Donald R. Glenn, "Ecclesiastes," in The Bible Knowledge Commentary…, vol. 1 (Wheaton, IL: Victor Books, 1985), 988.
 *
 * The quote is pasted as plain paragraphs (bold/italic kept, Logos's fonts and colors dropped) and the citation
 * becomes a footnote at the end of the quote. Anything else pastes as usual.
 */

// The last paragraph is a citation if it has a publication year in parentheses ("(…, 1985)" or "(1983)") and ends with
// a location: "…), 988." / "…): 12–15." / "…, 1985), 1:23."
const CITATION = /\([^()]*\b(1[5-9]|20)\d{2}[a-z]?\)\s*[,:]\s*[\divxlc][\w.:–-]*\.?\s*$/i;

const INLINE = new Set(['I', 'EM', 'B', 'STRONG', 'SUP', 'SUB']);
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Simple inline HTML: text plus italic/bold (Logos sets these with tags or with styles). */
function inlineHtml(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { out += escapeHtml(n.textContent); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const style = n.getAttribute('style') ?? '';
    let inner = inlineHtml(n);
    if (INLINE.has(n.tagName)) inner = `<${n.tagName.toLowerCase()}>${inner}</${n.tagName.toLowerCase()}>`;
    else {
      if (/font-style:\s*italic/i.test(style)) inner = `<em>${inner}</em>`;
      if (/font-weight:\s*(bold|[6-9]00)/i.test(style)) inner = `<strong>${inner}</strong>`;
    }
    out += n.tagName === 'BR' ? '\n' : inner;
  }
  return out;
}

/** The pasted paragraphs as [{ html, text }], from the HTML if there is any, else from the plain text. */
function paragraphs(html, text) {
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocks = [...doc.body.querySelectorAll('p, div, li, h1, h2, h3, h4, blockquote')]
      .filter((el) => !el.querySelector('p, div, li, h1, h2, h3, h4, blockquote'));
    const list = (blocks.length ? blocks : [doc.body])
      .map((el) => ({ html: inlineHtml(el).trim(), text: el.textContent.replace(/\s+/g, ' ').trim() }))
      .filter((p) => p.text);
    if (list.length >= 2) return list;
  }
  return text.split(/\n\s*\n/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .map((t) => ({ html: escapeHtml(t), text: t }));
}

export function splitLogosQuote(html, text) {
  const paras = paragraphs(html, text);
  if (paras.length < 2) return null;
  const citation = paras[paras.length - 1];
  if (!CITATION.test(citation.text) || citation.text.length > 600) return null;
  return { quote: paras.slice(0, -1), citation };
}

export const LogosPaste = Extension.create({
  name: 'logosPaste',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey('logosPaste'),
      props: {
        handlePaste(view, event) {
          const data = event.clipboardData;
          if (!data || data.files?.length) return false;
          const split = splitLogosQuote(data.getData('text/html'), data.getData('text/plain'));
          if (!split) return false;
          const footnote = `<sup class="citation" data-note="${escapeHtml(split.citation.text)}" data-note-html="${escapeHtml(split.citation.html)}">*</sup>`;
          const html = split.quote.map((p, i) => `<p>${p.html.replace(/\n/g, '<br>')}${i === split.quote.length - 1 ? footnote : ''}</p>`).join('');
          editor.chain().insertContent(html).run();
          editor.storage.noteApp?.notify?.('Pasted from Logos: the citation is now a footnote (Ctrl+Z to undo)');
          return true;
        },
      },
    })];
  },
});
