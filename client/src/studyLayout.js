import { editField, field, fieldOut, passageLine } from './sermon.js';
import { parse } from '../../shared/scripture.js';

/**
 * A study note laid out in steps (8.5's background and word studies; the Interpretive Journey keeps its own
 * bibleStudy.js): each step a heading 1, each of its fields a heading 2 under it, and the keeper the Keeper step's own
 * text. A step can also have a part the builder writes from what it keeps (a table of scholars' views, a word's uses):
 * `generated` steps open with it, and it's written fresh on each save. A field is rewritten only when the builder
 * changed its text, so anything else in the note stays as it was.
 *
 * steps: [{ key, title, match, parts: [[key, label, match]], generated? }]
 */
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
const outer = (nodes) => nodes.map((n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent) : '')).join('');

function cut(nodes, tag) {
  const lead = [];
  const parts = [];
  for (const n of nodes) {
    if (n.nodeType === 1 && n.tagName === tag) parts.push({ title: n.textContent.trim(), titleHtml: n.innerHTML, nodes: [] });
    else (parts.length ? parts[parts.length - 1].nodes : lead).push(n);
  }
  return { lead, parts };
}

/** The note as the builder's model: { preamble, sections: [{ key|null, title, titleHtml, lead, subs }] }. */
export function parseLayout(html, steps) {
  const { lead, parts } = cut([...doc(html).childNodes], 'H1');
  const seen = new Set();
  const sections = parts.map((p) => {
    const step = steps.find((s) => !seen.has(s.key) && s.match.test(p.title));
    if (step) seen.add(step.key);
    const { lead: slead, parts: subs } = cut(p.nodes, 'H2');
    // A step the builder writes keeps only its fields (its own part is written again).
    const own = step?.generated ? [] : slead;
    return {
      key: step?.key ?? null, title: p.title, titleHtml: p.titleHtml, lead: field(outer(own)),
      subs: subs
        .map((x) => ({ key: step?.parts.find(([, , re]) => re.test(x.title))?.[0] ?? null, title: x.title, titleHtml: x.titleHtml, field: field(outer(x.nodes)) }))
        // Headings the builder wrote inside its own part (a word's uses, grouped) aren't fields.
        .filter((x) => !(step?.generated && !x.key)),
    };
  });
  return { preamble: outer(lead), sections };
}

/** A new note's layout: every step and field, empty. */
export const emptyLayout = (steps, passage = '') => parseLayout(
  `${passageLine(passage)}${steps.map((s) => `<h1>${esc(s.title)}</h1>${s.parts.map(([, l]) => `<h2>${esc(l)}</h2>`).join('')}`).join('')}`, steps,
);

/** Adds the steps a note doesn't have yet (a blank note, or one made in another method), after what it has. */
export function completeLayout(model, steps) {
  if (model.sections.some((x) => x.key)) return model;
  return { ...model, sections: [...model.sections, ...emptyLayout(steps).sections] };
}

const stepOfPart = (steps, key) => steps.find((s) => s.parts.some(([k]) => k === key)) ?? null;
const section = (model, key) => model.sections.find((s) => s.key === key) ?? null;

/** A field's value: a step's part, or the keeper (the Keeper step's own text). */
export function getField(model, steps, key) {
  if (key === 'keeper') return section(model, 'keeper')?.lead ?? field('');
  const s = section(model, stepOfPart(steps, key)?.key);
  return s?.subs.find((x) => x.key === key)?.field ?? field('');
}

/** Sets a field's text, adding its step and heading where they belong when the note doesn't have them yet. */
export function setField(model, steps, key, text) {
  const step = key === 'keeper' ? steps.find((s) => s.key === 'keeper') : stepOfPart(steps, key);
  let sections = ensureStep(model, steps, step.key).sections;
  sections = sections.map((s) => {
    if (s.key !== step.key) return s;
    if (key === 'keeper') return { ...s, lead: editField(s.lead, text) };
    const found = s.subs.find((x) => x.key === key);
    if (found) return { ...s, subs: s.subs.map((x) => (x === found ? { ...x, field: editField(x.field, text) } : x)) };
    const parts = step.parts.map(([k]) => k);
    const label = step.parts.find(([k]) => k === key)[1];
    const subs = [...s.subs];
    const at = subs.findIndex((x) => x.key && parts.indexOf(x.key) > parts.indexOf(key));
    subs.splice(at < 0 ? subs.length : at, 0, { key, title: label, titleHtml: esc(label), field: editField(field(''), text) });
    return { ...s, subs };
  });
  return { ...model, sections };
}

/** The model with a step in it (before the next step the note has, else at the end). */
function ensureStep(model, steps, key) {
  if (section(model, key)) return model;
  const step = steps.find((s) => s.key === key);
  const order = steps.map((s) => s.key);
  const sections = [...model.sections];
  const at = sections.findIndex((s) => s.key && order.indexOf(s.key) > order.indexOf(key));
  sections.splice(at < 0 ? sections.length : at, 0, { key, title: step.title, titleHtml: esc(step.title), lead: field(''), subs: [] });
  return { ...model, sections };
}

/**
 * The model as note HTML. The passage line at the top follows the builder's passage; `generated` is the html of each
 * generated step's own part ({ stepKey: html }), written at the top of its step.
 */
export function layoutHtml(model, steps, { passage, generated = {} } = {}) {
  let m = model;
  for (const key of Object.keys(generated)) if (generated[key]) m = ensureStep(m, steps, key);
  let preamble = m.preamble ?? '';
  if (passage !== undefined) {
    const nodes = [...doc(preamble).childNodes];
    const first = nodes.find((x) => x.nodeType === 1) ?? null;
    const t = first?.textContent.trim() ?? '';
    const isLine = first && first.tagName === 'P' && first.children.length <= 1 && (!first.children.length || first.firstElementChild.tagName === 'A')
      && parse(t).refs.length > 0 && !parse(t).errors.length;
    preamble = passageLine(passage) + (isLine ? outer(nodes.slice(nodes.indexOf(first) + 1)) : preamble);
  }
  const out = [preamble];
  for (const s of m.sections) {
    const own = s.key && generated[s.key] != null ? generated[s.key] : fieldOut(s.lead);
    out.push(`<h1>${s.titleHtml}</h1>${own}${s.subs.map((x) => `<h2>${x.titleHtml}</h2>${fieldOut(x.field)}`).join('')}`);
  }
  return out.join('');
}

/** The first line of a field (a background's facts, shown beside studies of the book). */
export const firstLine = (text, n = 160) => {
  const line = String(text ?? '').trim().split('\n')[0].trim();
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line;
};
