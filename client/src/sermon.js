import { logosUrl, parse } from '../../shared/scripture.js';

/**
 * A sermon note, read as the McDill builder sees it and written back without losing anything else in it.
 *
 *   [passage link]
 *   # Introduction      ## Attention  ## Need  ## Bible Text  ## Bridging Sentences (Text Idea: …, Sermon Idea: …)
 *   # <division> (v. 1–2)    ## Explanation  ## Illustration  ## Argumentation  ## Application   **Transition: …**
 *   # Conclusion        ## Visualization  ## Reiteration  ## Action
 *
 * This is also how Logos's Sermon Builder exports (and the user's own template), so imported sermons read the same.
 * Each section keeps its own HTML; a field is rewritten only when the builder changed its text, so formatting, lists
 * and links in parts the builder didn't touch stay exactly as they were.
 */

export const INTRO_PARTS = [['attention', 'Attention'], ['need', 'Need'], ['bibleText', 'Bible Text'], ['bridging', 'Bridging Sentences']];
export const DIVISION_PARTS = [['explanation', 'Explanation'], ['illustration', 'Illustration'], ['argumentation', 'Argumentation'], ['application', 'Application']];
export const CONCLUSION_PARTS = [['visualization', 'Visualization'], ['reiteration', 'Reiteration'], ['action', 'Action']];
/** The four elements' colors (the sermon bank's kind colors), light and dark, for color-coded manuscripts. */
export const ELEMENT_COLORS = {
  explanation: ['#2f5d86', '#9cc3ea'], illustration: ['#a0620a', '#e2a24b'], argumentation: ['#6b4fa0', '#b9a2e6'], application: ['#2e7d4f', '#7fcf9f'],
};
export const BRIDGE = [['subject', 'Subject'], ['modifier', 'Modifier'], ['textIdea', 'Text Idea'], ['sermonIdea', 'Sermon Idea'], ['interrogative', 'Interrogative'], ['transition', 'Transition']];

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
let seq = 0;
/** An id for a division or part while the builder is open (so the board can follow it as it moves). */
export const uid = () => `u${++seq}`;
const outer = (nodes) => nodes.map((n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent) : '')).join('');

/**
 * What a builder's rich box (RichBox.jsx, 10.0) can hold: paragraphs, bold, italic, underline, strike, code, links,
 * lists and quotes. A part with anything else (pictures, tables, headings, citations, links to other notes…) is
 * edited in the note, so nothing in it is lost.
 */
const BOX_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'CODE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);
const BOX_ATTRS = { A: ['href', 'target', 'rel'], OL: ['start'], P: ['data-order'], LI: ['data-order'] };
const boxCanHold = (html) => [...doc(html).querySelectorAll('*')].every((el) => BOX_TAGS.has(el.tagName)
  && [...el.attributes].every((a) => (BOX_ATTRS[el.tagName] ?? []).includes(a.name))
  // Logos links (https://ref.ly/…, 10.0.1) are ordinary links; a note link (#note/…) or a bare logosres: address isn't.
  && (el.tagName !== 'A' || !/^(#|logosres:)/i.test(el.getAttribute('href') ?? '')));

/** An element's text with its line breaks (innerText can't see them in a parsed, unrendered document). */
const lineText = (el) => {
  const copy = el.cloneNode(true);
  copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  return copy.textContent;
};
/** A field: its HTML, the text a textarea shows, and whether only the note can edit it (rich). */
export function field(html = '') {
  const body = doc(html);
  const text = [...body.children].length
    ? [...body.children].map(lineText).map((t) => t.replace(/ /g, ' ').trim()).filter(Boolean).join('\n\n')
    : body.textContent.trim();
  return { html, text, original: text, rich: !boxCanHold(html) };
}
/**
 * A field after an edit: text (a chip, a photo's words, a refreshed reiteration) or { html } from a rich box. The
 * text follows the HTML, so word counts and step checks keep working.
 */
export function editField(f, value) {
  if (value && typeof value === 'object') {
    const html = value.html ?? '';
    return { ...f, base: f.base ?? f.html, html, text: field(html).text, edited: true };
  }
  return { ...f, text: value, edited: false };
}
/** What a rich box shows for a field: what it last wrote, or the field's HTML as the note would get it. */
export const boxHtml = (f) => (f.edited ? f.html : fieldOut(f));
/** Words added to a field (a photo of handwritten notes, say) as new paragraphs after what's there. */
export const appendText = (f, text) => ({ html: `${fieldOut(f)}${textHtml(text)}` });
/** Plain text from a textarea as paragraphs. */
export const textHtml = (text) => String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
/** The field's HTML for writing: unchanged fields keep theirs. */
export const fieldOut = (f) => (!f ? '' : f.edited ? carryOrder(f.base ?? '', f.html)
  : f.rich || f.text === f.original ? f.html : carryOrder(f.html, textHtml(f.text)));
/**
 * Delivery numbers (data-order, set on the Arrange board) survive retyping a part in the steps: paragraph by paragraph
 * when the count is the same, else by matching text.
 */
function carryOrder(oldHtml, html) {
  if (!/data-order=/.test(oldHtml)) return html;
  const old = [...doc(oldHtml).children];
  const body = doc(html);
  const now = [...body.children];
  const byText = new Map(old.filter((e) => e.dataset.order).map((e) => [norm(lineText(e)), e.dataset.order]));
  now.forEach((el, i) => {
    const v = old.length === now.length ? old[i].dataset.order : byText.get(norm(lineText(el)));
    if (v) el.setAttribute('data-order', v);
  });
  return body.innerHTML;
}
const filled = (f) => !!f && (f.rich ? !!doc(f.html).textContent.trim() || /<img\b/i.test(f.html) : !!f.text.trim());

/** Splits nodes at headings of `tag`: { lead, parts: [{ title, titleHtml, nodes }] }. */
function cut(nodes, tag) {
  const lead = [];
  const parts = [];
  for (const n of nodes) {
    if (n.nodeType === 1 && n.tagName === tag) parts.push({ title: n.textContent.trim(), titleHtml: n.innerHTML, nodes: [] });
    else (parts.length ? parts[parts.length - 1].nodes : lead).push(n);
  }
  return { lead, parts };
}

const isTransition = (el) => el?.nodeType === 1 && el.tagName === 'P' && /^\s*transition\s*:/i.test(el.textContent);

/** "Humility and love avoid harsh judgement. (v. 1-2)" → { statement, verses: 'v. 1-2' }. */
export function splitStatement(title) {
  const m = /^(.*?)\s*\(((?:vv?\.?|verses?)\s*[^)]*)\)\s*$/i.exec(title);
  return m ? { statement: m[1].trim(), verses: m[2].trim() } : { statement: title.trim(), verses: '' };
}
export const joinStatement = (statement, verses) => (verses.trim() ? `${statement.trim()} (${verses.trim()})` : statement.trim());

/** Sub-sections under a top heading, matched to known parts by title. */
function subsOf(nodes, known) {
  const { lead, parts } = cut(nodes, 'H2');
  return {
    lead: outer(lead),
    subs: parts.map((p) => {
      const key = known.find(([, label]) => norm(label) === norm(p.title) || (label === 'Bridging Sentences' && /^bridg/i.test(p.title)))?.[0] ?? null;
      return { uid: uid(), key, title: p.title, titleHtml: p.titleHtml, field: field(outer(p.nodes)) };
    }),
  };
}

/** Reads "Text Idea: …" lines out of the Bridging Sentences section. */
function readBridge(html) {
  const out = Object.fromEntries(BRIDGE.map(([k]) => [k, '']));
  const other = [];
  for (const el of [...doc(html).children]) {
    const m = /^\s*(subject\s*\/\s*modifier|subject\s*\/\s*complement|subject|modifier|complement|text idea|sermon idea|interrogative|transition)\s*:\s*([\s\S]*)$/i.exec(el.textContent);
    if (el.tagName !== 'P' || !m) { other.push(el.outerHTML); continue; }
    const label = m[1].toLowerCase().replace(/\s+/g, ' ');
    const value = m[2].trim();
    if (label.includes('/')) {
      const [a, b] = value.split(/\s*\/\s*/);
      out.subject = a ?? '';
      out.modifier = b ?? '';
    } else {
      const key = { subject: 'subject', modifier: 'modifier', complement: 'modifier', 'text idea': 'textIdea', 'sermon idea': 'sermonIdea', interrogative: 'interrogative', transition: 'transition' }[label];
      out[key] = value;
    }
  }
  return { ...out, other: other.join(''), originalHtml: html, original: JSON.stringify(out) };
}
function bridgeHtml(b) {
  const vals = Object.fromEntries(BRIDGE.map(([k]) => [k, b[k] ?? '']));
  if (JSON.stringify(vals) === b.original) return b.originalHtml;
  const lines = [];
  if (vals.subject || vals.modifier) lines.push(`<p>Subject / Modifier: ${esc(vals.subject)}${vals.modifier ? ` / ${esc(vals.modifier)}` : ''}</p>`);
  for (const [k, label] of BRIDGE.slice(2)) if (vals[k].trim()) lines.push(`<p>${label}: ${esc(vals[k].trim())}</p>`);
  return lines.join('') + (b.other ?? '');
}

/** The sermon note as the builder's model. */
export function parseSermon(html) {
  const { lead, parts } = cut([...doc(html).childNodes], 'H1');
  const model = { preamble: outer(lead), intro: null, divisions: [], conclusion: null, after: [] };
  const conclusionAt = parts.findIndex((p) => /^conclusion/i.test(p.title));
  parts.forEach((p, i) => {
    if (!model.intro && /^introduction/i.test(p.title) && !model.divisions.length) {
      const s = subsOf(p.nodes, INTRO_PARTS);
      const bridge = s.subs.find((x) => x.key === 'bridging');
      model.intro = { title: p.title, ...s, bridge: readBridge(bridge?.field.html ?? '') };
    } else if (i === conclusionAt) {
      model.conclusion = { title: p.title, ...subsOf(p.nodes, CONCLUSION_PARTS) };
    } else if (conclusionAt >= 0 && i > conclusionAt) {
      model.after.push(`<h1>${p.titleHtml}</h1>${outer(p.nodes)}`);
    } else {
      // A division: its closing "Transition: …" line is its own field.
      const nodes = [...p.nodes];
      while (nodes.length && nodes[nodes.length - 1].nodeType === 1 && !nodes[nodes.length - 1].textContent.trim() && !nodes[nodes.length - 1].querySelector?.('img')) nodes.pop();
      let transition = '';
      let transitionHtml = '';
      let { lead: dlead, subs } = subsOf(nodes, DIVISION_PARTS);
      const lastSub = subs[subs.length - 1];
      const tail = lastSub ? [...doc(lastSub.field.html).childNodes] : nodes.filter((n) => !(n.nodeType === 3 && !n.textContent.trim()));
      const end = tail[tail.length - 1];
      if (isTransition(end)) {
        transition = end.textContent.replace(/^\s*transition\s*:\s*/i, '').trim();
        transitionHtml = end.outerHTML;
        if (lastSub) lastSub.field = field(outer(tail.slice(0, -1)));
        else ({ lead: dlead, subs } = subsOf(nodes.slice(0, nodes.indexOf(end)), DIVISION_PARTS));
      }
      const { statement, verses } = splitStatement(p.title);
      model.divisions.push({ uid: uid(), statement, verses, original: p.title, titleHtml: p.titleHtml, lead: field(dlead), subs, transition, originalTransition: transition, transitionHtml });
    }
  });
  // Each transition leads to the division after it; the board flags it when a move changes that.
  model.divisions.forEach((d, i) => { d.transTo = model.divisions[i + 1]?.uid ?? null; });
  return model;
}

/** An empty sermon for the builder, with the passage linked at the top. */
export function emptySermon(passage = '') {
  return parseSermon(`${passageLine(passage)}<h1>Introduction</h1><h1>Conclusion</h1>`);
}

/** The passage as a Logos link paragraph (what Logos puts at the top), or plain text when it isn't a reference. */
export function passageLine(passage) {
  const p = String(passage ?? '').trim();
  if (!p) return '';
  const r = parse(p).refs[0];
  return r ? `<p><a target="_blank" rel="noopener noreferrer" href="${esc(logosUrl(r))}">${esc(p)}</a></p>` : `<p>${esc(p)}</p>`;
}

// ---------- reading and setting fields ----------

const sub = (section, key) => section?.subs.find((s) => s.key === key) ?? null;
export const getPart = (section, key) => sub(section, key)?.field ?? field('');

/** Sets a known part's text, adding its heading where it belongs when the note doesn't have it yet. */
export function setPart(section, key, known, text) {
  const found = sub(section, key);
  if (found) return { ...section, subs: section.subs.map((s) => (s === found ? { ...s, field: editField(s.field, text) } : s)) };
  const order = known.map(([k]) => k);
  const label = known.find(([k]) => k === key)[1];
  const at = section.subs.findIndex((s) => s.key && order.indexOf(s.key) > order.indexOf(key));
  const made = { uid: uid(), key, title: label, titleHtml: esc(label), field: editField(field(''), text) };
  const subs = [...section.subs];
  subs.splice(at < 0 ? subs.length : at, 0, made);
  return { ...section, subs };
}

export function newDivision(statement = '', verses = '') {
  return { uid: uid(), statement, verses, original: null, titleHtml: null, lead: field(''), subs: [], transition: '', originalTransition: '', transTo: null };
}

// ---------- writing ----------

function sectionHtml(titleHtml, s) {
  return `<h1>${titleHtml}</h1>${s.lead ?? ''}${s.subs.filter((x) => x.key === 'bridging' || filled(x.field) || x.field.html)
    .map((x) => `<h2>${x.titleHtml}</h2>${x.key === 'bridging' ? x.bridgeHtml : fieldOut(x.field)}`).join('')}`;
}

/** The model as note HTML. */
export function sermonHtml(model, { passage } = {}) {
  let preamble = model.preamble ?? '';
  if (passage !== undefined) {
    // The passage line at the top follows the builder's passage (other things above Introduction stay).
    const nodes = [...doc(preamble).childNodes];
    const first = nodes.find((x) => x.nodeType === 1) ?? null;
    const t = first?.textContent.trim() ?? '';
    // A paragraph that is only a Logos passage link, or only a reference.
    const onlyLink = first?.children.length === 1 && first.firstElementChild.tagName === 'A' && first.firstElementChild.textContent.trim() === t && /ref\.ly\//.test(first.firstElementChild.getAttribute('href') ?? '');
    const isLine = first && first.tagName === 'P' && (onlyLink || (parse(t).refs.length > 0 && !parse(t).errors.length));
    const rest = isLine ? outer(nodes.slice(nodes.indexOf(first) + 1)) : preamble;
    preamble = passageLine(passage) + rest;
  }
  const out = [preamble];
  const intro = model.intro ?? { title: 'Introduction', lead: '', subs: [], bridge: readBridge('') };
  const bridgeOut = bridgeHtml(intro.bridge);
  let subs = intro.subs;
  if (!sub(intro, 'bridging') && bridgeOut) subs = setPart(intro, 'bridging', INTRO_PARTS, '').subs;
  out.push(sectionHtml(esc(intro.title || 'Introduction'), { lead: intro.lead, subs: subs.map((s) => (s.key === 'bridging' ? { ...s, bridgeHtml: bridgeOut } : s)).filter((s) => s.key !== 'bridging' || bridgeOut) }));
  for (const d of model.divisions) {
    const title = joinStatement(d.statement, d.verses);
    if (!title && !filled(d.lead) && !d.subs.some((s) => filled(s.field))) continue;
    const titleHtml = d.original != null && title === joinStatement(...Object.values(splitStatement(d.original))) ? d.titleHtml : esc(title || 'Division');
    const transition = d.transition.trim()
      ? (d.transition === d.originalTransition && d.transitionHtml) || `<p><strong>Transition: ${esc(d.transition.trim())}</strong></p>` : '';
    out.push(sectionHtml(titleHtml, { lead: fieldOut(d.lead), subs: d.subs }) + transition);
  }
  const concl = model.conclusion ?? { title: 'Conclusion', lead: '', subs: [] };
  out.push(sectionHtml(esc(concl.title || 'Conclusion'), concl));
  out.push(...model.after);
  return out.join('');
}

/** The reiteration a conclusion usually needs: the division statements as a numbered list. */
export const reiterationText = (model) => model.divisions.filter((d) => d.statement.trim()).map((d, i) => `${i + 1}. ${joinStatement(d.statement, d.verses)}`).join('\n');

/** Words in the model's fields and sections (for the length estimate and the balance of the four elements). */
export const words = (text) => String(text ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
