import { editField, field, fieldOut, passageLine } from './sermon.js';
import { parse } from '../../shared/scripture.js';

/**
 * A Bible study note, read as the study builder sees it and written back without losing anything else in it. The
 * steps are J. Scott Duvall and J. Daniel Hays's Interpretive Journey (Grasping God's Word), with the fields of the
 * user's own Scripture Study Template:
 *
 *   [passage link]   Times read: 3 · Translations: ESV, NASB
 *   # Step 1: The Text in Their Town      ## People, Places, Things  ## Important Words  ## Questions  ## Text Summary
 *   # Step 2: Measuring the River to Cross     ## Cultural Differences
 *   # Step 3: Cross the Principlizing Bridge   ## Theological Principles
 *   # Step 4: Consult the Biblical Map         ## Biblical Consistency
 *   # Step 5: The Text in My Town              ## Modern Application
 *   # Keeper                                   (one sentence worth finding again)
 *
 * Notes made from that template read the same. A field is rewritten only when the builder changed its text.
 */
export const JOURNEY = [
  { key: 'their', n: 1, title: 'Step 1: The Text in Their Town', label: 'The Text in Their Town', match: /their\s+town|^step\s*1\b/i,
    parts: [['people', 'People, Places, Things', /^people/i], ['words', 'Important Words', /words/i], ['questions', 'Questions', /question/i], ['summary', 'Text Summary', /summary|meaning/i]] },
  { key: 'river', n: 2, title: 'Step 2: Measuring the River to Cross', label: 'Measuring the River', match: /river|^step\s*2\b/i,
    parts: [['differences', 'Cultural Differences', /differen/i]] },
  { key: 'bridge', n: 3, title: 'Step 3: Cross the Principlizing Bridge', label: 'The Principlizing Bridge', match: /bridge|^step\s*3\b/i,
    parts: [['principles', 'Theological Principles', /principle/i]] },
  { key: 'map', n: 4, title: 'Step 4: Consult the Biblical Map', label: 'The Biblical Map', match: /biblical\s+map|^step\s*4\b/i,
    parts: [['consistency', 'Biblical Consistency', /consisten|comparison/i]] },
  { key: 'town', n: 5, title: 'Step 5: The Text in My Town', label: 'The Text in Our Town', match: /(my|our)\s+town|^step\s*5\b/i,
    parts: [['application', 'Modern Application', /application/i]] },
  { key: 'keeper', title: 'Keeper', label: 'Keeper', match: /^keeper/i, parts: [] },
];
const PART_KEYS = Object.fromEntries(JOURNEY.flatMap((s) => s.parts.map(([k]) => [k, s.key])));

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
const outer = (nodes) => nodes.map((n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? esc(n.textContent) : '')).join('');
const READING = /^\s*times read\s*:/i;

function cut(nodes, tag) {
  const lead = [];
  const parts = [];
  for (const n of nodes) {
    if (n.nodeType === 1 && n.tagName === tag) parts.push({ title: n.textContent.trim(), titleHtml: n.innerHTML, nodes: [] });
    else (parts.length ? parts[parts.length - 1].nodes : lead).push(n);
  }
  return { lead, parts };
}

/** "Times read: 3 · Translations: ESV, NASB" → { timesRead, translations }. */
function readReading(text) {
  const times = /times read\s*:\s*(\d+)/i.exec(text);
  const tr = /translations?\s*:\s*([^·]*)/i.exec(text);
  return { timesRead: times ? Number(times[1]) : 0, translations: tr ? tr[1].split(/[,;]/).map((t) => t.trim()).filter(Boolean) : [] };
}
export const readingLine = ({ timesRead = 0, translations = [] }) => (timesRead || translations.length
  ? `<p>Times read: ${timesRead}${translations.length ? ` · Translations: ${esc(translations.join(', '))}` : ''}</p>` : '');

/** The study note as the builder's model: { preamble, reading, sections: [{ key|null, title, titleHtml, lead, subs }] }. */
export function parseStudy(html) {
  const { lead, parts } = cut([...doc(html).childNodes], 'H1');
  // Above the steps: the passage line, the reading line, anything else.
  let reading = { timesRead: 0, translations: [] };
  const preamble = lead.filter((n) => {
    if (n.nodeType === 1 && n.tagName === 'P' && READING.test(n.textContent)) { reading = readReading(n.textContent); return false; }
    return true;
  });
  const seen = new Set();
  const sections = parts.map((p) => {
    const step = JOURNEY.find((s) => !seen.has(s.key) && s.match.test(p.title));
    if (step) seen.add(step.key);
    const { lead: slead, parts: subs } = cut(p.nodes, 'H2');
    return {
      key: step?.key ?? null, title: p.title, titleHtml: p.titleHtml, lead: field(outer(slead)),
      subs: subs.map((x) => ({ key: step?.parts.find(([, , re]) => re.test(x.title))?.[0] ?? null, title: x.title, titleHtml: x.titleHtml, field: field(outer(x.nodes)) })),
    };
  });
  return { preamble: outer(preamble), reading, sections };
}

export const emptyStudy = (passage = '') => parseStudy(`${passageLine(passage)}${JOURNEY.map((s) => `<h1>${esc(s.title)}</h1>${s.parts.map(([, l]) => `<h2>${esc(l)}</h2>`).join('')}`).join('')}`);

const section = (model, key) => model.sections.find((s) => s.key === key) ?? null;
/** A field's value: a step's part, or the keeper (the Keeper section's own text). */
export function getField(model, key) {
  if (key === 'keeper') return section(model, 'keeper')?.lead ?? field('');
  const s = section(model, PART_KEYS[key]);
  return s?.subs.find((x) => x.key === key)?.field ?? field('');
}

/** Sets a field's text, adding its step and heading where they belong when the note doesn't have them yet. */
export function setField(model, key, text) {
  const stepKey = key === 'keeper' ? 'keeper' : PART_KEYS[key];
  const step = JOURNEY.find((s) => s.key === stepKey);
  let sections = model.sections;
  if (!section(model, stepKey)) {
    // Before the next step the note has, else after the last one.
    const order = JOURNEY.map((s) => s.key);
    const at = sections.findIndex((s) => s.key && order.indexOf(s.key) > order.indexOf(stepKey));
    const made = { key: stepKey, title: step.title, titleHtml: esc(step.title), lead: field(''), subs: [] };
    sections = [...sections];
    sections.splice(at < 0 ? sections.length : at, 0, made);
  }
  sections = sections.map((s) => {
    if (s.key !== stepKey) return s;
    if (key === 'keeper') return { ...s, lead: editField(s.lead, text) };
    const found = s.subs.find((x) => x.key === key);
    if (found) return { ...s, subs: s.subs.map((x) => (x === found ? { ...x, field: editField(x.field, text) } : x)) };
    const order = step.parts.map(([k]) => k);
    const label = step.parts.find(([k]) => k === key)[1];
    const subs = [...s.subs];
    const at = subs.findIndex((x) => x.key && order.indexOf(x.key) > order.indexOf(key));
    subs.splice(at < 0 ? subs.length : at, 0, { key, title: label, titleHtml: esc(label), field: editField(field(''), text) });
    return { ...s, subs };
  });
  return { ...model, sections };
}

/** The model as note HTML. The passage line at the top follows the builder's passage. */
export function studyHtml(model, { passage, reading } = {}) {
  let preamble = model.preamble ?? '';
  if (passage !== undefined) {
    const nodes = [...doc(preamble).childNodes];
    const first = nodes.find((x) => x.nodeType === 1) ?? null;
    // A paragraph that is only a passage (a Logos link or plain text).
    const t = first?.textContent.trim() ?? '';
    const isLine = first && first.tagName === 'P' && first.children.length <= 1 && (!first.children.length || first.firstElementChild.tagName === 'A')
      && parse(t).refs.length > 0 && !parse(t).errors.length;
    preamble = passageLine(passage) + (isLine ? outer(nodes.slice(nodes.indexOf(first) + 1)) : preamble);
  }
  const out = [preamble, readingLine(reading ?? model.reading)];
  for (const s of model.sections) {
    out.push(`<h1>${s.titleHtml}</h1>${fieldOut(s.lead)}${s.subs.map((x) => `<h2>${x.titleHtml}</h2>${fieldOut(x.field)}`).join('')}`);
  }
  return out.join('');
}

/**
 * Quick checks the method asks for. Soft: each warns only when the text clearly reads the wrong way (present-tense
 * verbs and no past ones in a summary, past ones and no present ones in a principle).
 */
const PAST = /\b(was|were|had|did|said|told|taught|spoke|wrote|knew|came|went|gave|made|meant|saw|took|brought|found|thought|began|became|left|\w{3,}ed)\b/i;
const PRESENT = /\b(is|are|does|do|has|have|says|means|calls|will|shall|must|should|can|may|need|needs|cannot)\b/i;
export const summaryTenseWrong = (text) => PRESENT.test(text) && !PAST.test(text);
export const principleTenseWrong = (text) => PAST.test(text) && !PRESENT.test(text);

/** The principle tests from Grasping God's Word (step 3). */
export const PRINCIPLE_TESTS = [
  ['text', 'It’s reflected in the biblical text'],
  ['timeless', 'It’s timeless, not tied to one situation'],
  ['culture', 'It isn’t culturally bound'],
  ['scripture', 'It fits the teaching of the rest of Scripture'],
  ['both', 'It’s relevant to the biblical and the contemporary audience'],
];

/** The method's own coaching for each step (from the user's Grasping God's Word Study Template). */
export const GUIDANCE = {
  their: {
    question: 'What did the text mean to the biblical audience?',
    paras: [
      'Read the text carefully and observe it. Try to see as much as possible in the text. Look, look, and look again, observing all you can. Scrutinize the grammar and analyze all significant words. Likewise, study the historical and literary contexts. How does your passage relate to those passages that precede it and those that follow it?',
      'After completing all this study, synthesize the meaning of the passage for the biblical audience into one or two sentences. That is, write out what the passage meant for the biblical audience. Use past-tense verbs and refer to the biblical audience.',
    ],
  },
  river: {
    question: 'What are the differences between the biblical audience and us?',
    paras: [
      'Take a good, hard look at the river and determine just how wide it is for the passage you are studying. Look for significant differences between our situation today and the situation of the biblical audience.',
      'Write a paragraph describing the differences that define the width of the river you need to cross.',
    ],
  },
  bridge: {
    question: 'What is the theological principle in this text?',
    paras: [
      'The principle should be reflected in the biblical text. It should be timeless and not tied to a specific situation, and not culturally bound. It should be consistent with the teaching of the rest of Scripture, and relevant to both the biblical and the contemporary audience.',
      'Write out the theological principle (or principles) in one or two sentences. Use present- or future-tense verbs.',
    ],
  },
  map: {
    question: 'How does our theological principle fit with the rest of the Bible?',
    paras: [
      'Enter the parts-whole spiral: reflect back and forth between the text and the teachings of the rest of Scripture. Is your principle consistent with the rest of Scripture? Do other portions of Scripture add insight or qualification to the principle? If your principle is valid, it ought to “fit” or “correlate” with the rest of the Bible.',
      'At the end of this step, sometimes you will need to reword your theological principle slightly to ensure that it fits with the rest of Scripture. Don’t ignore the elements you initially drew on in step 3, but now fine-tune your principle if it needs it.',
    ],
  },
  town: {
    question: 'How should individual Christians today live out the theological principle?',
    paras: [
      'Observe how the theological principles in the biblical text address the original situation. Look closely at this intersection between the principle in the text and the historical situation.',
      'Search for a situation in our lives or our world that parallels the ancient situation.',
      'Make your applications specific by creating real-world scenarios that are both faithful to the meaning of the text and relevant to the contemporary audience. Remember, to truly grasp God’s Word, we need to obey what we learn.',
    ],
  },
};

/** Sermon material from a study: what the sermon builder's skeleton starts with. */
export function sermonFromStudy(model) {
  const get = (k) => getField(model, k).text.trim();
  return {
    textIdea: get('summary'),
    sermonIdea: get('principles').split(/\n{2,}/)[0] ?? '',
    details: [get('people'), get('words')].filter(Boolean).join('\n\n'),
    questions: get('questions').split('\n').map((q) => q.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((q) => ({ q, a: '' })),
    action: get('application'),
  };
}

/** Lesson material from a study (what a lesson started from it carries over): summary, principle, questions, application, keeper. */
export function lessonFromStudy(model) {
  const get = (k) => getField(model, k).text.trim();
  return {
    summary: get('summary'), principle: get('principles').split(/\n{2,}/)[0] ?? '', application: get('application'), keeper: get('keeper'),
    questions: get('questions').split('\n').map((q) => q.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()).filter(Boolean),
  };
}
