import { BOOKS, END, format } from '../../shared/scripture.js';
import { VERSES } from '../../shared/verses.js';
import { addDays, toUTC } from './time.js';

/**
 * Courses (5.12): curriculum planning from Richards and Bredfeldt's Creative Bible Teaching. A course teaches a book
 * or a topic over a quarter (13 weeks) or two, with aims for the whole course, and each week's lesson is checked
 * against the levels of learning. This file holds the plain logic: splitting a book into weekly passages, class
 * dates, the levels of learning and the teaching methods library.
 */

export const QUARTER = 13;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekday = (d) => toUTC(d).getUTCDay();

/** The first `n` class dates on `day` from `start` (inclusive), passing over `skips`. Matches the server's. */
export function classDates(start, day, n, skips = []) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '')) return out;
  let d = start;
  for (let guard = 0; guard < 7 && weekday(d) !== day; guard += 1) d = addDays(d, 1);
  for (let guard = 0; out.length < n && guard < 400; guard += 1, d = addDays(d, 7)) if (!skips.includes(d)) out.push(d);
  return out;
}

const chapterRef = (b, from, to) => format({ book: b, ch_start: from, v_start: 0, ch_end: to, v_end: END });
const verseRef = (b, ch, a, z) => format({ book: b, ch_start: ch, v_start: a, ch_end: ch, v_end: z });

/**
 * A book (chapters from–to) as `n` weekly passages of about the same length. With at least as many chapters as weeks,
 * whole chapters are grouped (balanced by verse count); with fewer, each chapter gets weeks in proportion to its
 * length and is cut into even verse ranges. Returns [{ ref }] (a starting point: edit the passages to fit the text).
 */
export function splitBook(bookOrder, from, to, n) {
  const b = BOOKS.find((x) => x.order === Number(bookOrder));
  if (!b || n < 1) return [];
  const first = Math.max(1, Math.min(b.chapters, Number(from) || 1));
  const last = Math.max(first, Math.min(b.chapters, Number(to) || b.chapters));
  const chapters = [];
  for (let c = first; c <= last; c += 1) chapters.push({ c, v: VERSES[b.order - 1][c - 1] });
  if (chapters.length >= n) {
    // Partition into n runs, keeping each run's verses near the average (least squares, by dynamic programming).
    const C = chapters.length;
    const pre = [0];
    for (const ch of chapters) pre.push(pre[pre.length - 1] + ch.v);
    const target = pre[C] / n;
    const cost = Array.from({ length: n + 1 }, () => new Array(C + 1).fill(Infinity));
    const cut = Array.from({ length: n + 1 }, () => new Array(C + 1).fill(0));
    cost[0][0] = 0;
    for (let k = 1; k <= n; k += 1) {
      for (let i = k; i <= C - (n - k); i += 1) {
        for (let j = k - 1; j < i; j += 1) {
          const c = cost[k - 1][j] + (pre[i] - pre[j] - target) ** 2;
          if (c < cost[k][i]) { cost[k][i] = c; cut[k][i] = j; }
        }
      }
    }
    const runs = [];
    for (let k = n, i = C; k > 0; k -= 1) { const j = cut[k][i]; runs.unshift([j, i]); i = j; }
    return runs.map(([j, i]) => ({ ref: chapterRef(b.order, chapters[j].c, chapters[i - 1].c) }));
  }
  // Fewer chapters than weeks: weeks per chapter by length (at least one each), largest remainders first.
  const total = chapters.reduce((s, ch) => s + ch.v, 0);
  const spare = n - chapters.length;
  const shares = chapters.map((ch) => (ch.v / total) * spare);
  const give = shares.map(Math.floor);
  let left = spare - give.reduce((s, x) => s + x, 0);
  shares.map((x, i) => [x - Math.floor(x), i]).sort((a, z) => z[0] - a[0]).forEach(([, i]) => { if (left > 0) { give[i] += 1; left -= 1; } });
  const out = [];
  chapters.forEach((ch, i) => {
    const parts = give[i] + 1;
    if (parts === 1) { out.push({ ref: chapterRef(b.order, ch.c, ch.c) }); return; }
    let start = 1;
    for (let p = 0; p < parts; p += 1) {
      const end = p === parts - 1 ? ch.v : Math.round(((p + 1) * ch.v) / parts);
      out.push({ ref: verseRef(b.order, ch.c, start, end) });
      start = end + 1;
    }
  });
  return out;
}

/** The weekly plan a new course starts with: passages for a book (with a review week at the quarter), or blank topic weeks. */
export function planWeeks({ type, book, from, to, weeks, recap }) {
  const n = Math.max(1, Math.min(60, Number(weeks) || QUARTER));
  const withRecap = recap && n > QUARTER;
  const teach = withRecap ? n - 1 : n;
  const list = type === 'book' ? splitBook(book, from, to, teach).map((p) => ({ title: p.ref, ref: p.ref }))
    : Array.from({ length: teach }, () => ({ title: '', ref: '' }));
  if (withRecap) list.splice(QUARTER - 1, 0, { title: 'Review and Preview', ref: '', recap: true });
  return list;
}

// ---------- the levels of learning ----------

/** Richards's levels of learning, lowest to highest: the aim is realization, the truth lived out. */
export const LEVELS = [
  {
    key: 'rote', label: 'Rote', short: 'Rote', what: 'Repeating words without needing to understand them',
    explain: 'The class says the words back, even before they understand them. Good for a memory verse or a key phrase, but it’s only a start.',
    starts: ['Read aloud…', 'Say together…', 'Fill in the blank…'], example: 'Let’s read verse 2 aloud together.',
  },
  {
    key: 'recognition', label: 'Recognition', short: 'Recog.', what: 'Picking out what the text says',
    explain: 'They find what the passage says. The answer is right there on the page, so anyone who read it can answer.',
    starts: ['According to verse…', 'Who…', 'Which…', 'List…'], example: 'According to verse 1, what should we do when we go to the house of God?',
  },
  {
    key: 'restatement', label: 'Restatement', short: 'Restate', what: 'Putting the truth in their own words',
    explain: 'They put the truth in their own words. Saying it differently shows they understand it, not just remember it.',
    starts: ['In your own words…', 'Why…', 'What does … mean?', 'Summarize…'], example: 'In your own words, what does it mean to guard your steps?',
  },
  {
    key: 'relation', label: 'Relation', short: 'Relate', what: 'Connecting the truth to their own life',
    explain: 'They connect the truth to their own life: where it shows up, when they’ve seen it, what it looks like today.',
    starts: ['When have you…', 'Have you ever…', 'Where do you see this in your life?'], example: 'When have you made a promise to God that you didn’t keep?',
  },
  {
    key: 'realization', label: 'Realization', short: 'Realize', what: 'Acting on it: the truth lived out',
    explain: 'They decide to act on it. The truth moves from the page into how they live this week. This is the aim of the lesson.',
    starts: ['This week…', 'What one step will you…', 'What will you…'], example: 'What one thing will you do this week to keep your word to God?',
  },
];
export const levelOf = (key) => LEVELS.find((l) => l.key === key) ?? LEVELS[1];
const KIND_LEVEL = { observe: 'recognition', interpret: 'restatement', apply: 'relation' };

/** A guess at the level a question works at, from its wording and its kind (observe, interpret, apply). */
export function guessLevel(q, kind) {
  const t = String(q ?? '').toLowerCase();
  if (/\b(this week|will you|commit|what (one )?(step|thing)s? will|decide to|plan to|going to|start doing|stop doing)\b/.test(t)) return 'realization';
  if (/\b(recite|repeat|memori[sz]e|fill in the blank|say (it )?together|read (it )?aloud)\b/.test(t)) return 'rote';
  if (/\b(in your own words|summari[sz]e|paraphrase|restate|explain|describe|put (it|this) in|why)\b/.test(t) || /\bwhat does .+ mean\b/.test(t)) return 'restatement';
  if (/\b(your life|our lives|when have you|have you ever|an example|experience|today|our (world|culture|church)|relate|connect|where do you see)\b/.test(t)) return 'relation';
  if (/^(is|are|was|were|did|does|do|can|could|should|has|have)\b/.test(t) || /\b(which|according to|list|true or false|who (is|was|were|did))\b/.test(t)) return 'recognition';
  return KIND_LEVEL[kind] ?? 'recognition';
}

/** A took asks for realization when it names a specific response; otherwise it relates the truth to life. */
export const tookLevel = (text) => (/\b(this week|today|tomorrow|each (day|morning|night)|every day|will|commit|write|call|text|memori[sz]e|start|stop|choose|plan|pray)\b/i.test(text ?? '') ? 'realization' : 'relation');

/** How many questions, methods and responses work at each level: { rote: n, …, reached: highest key or null }. */
export function levelCounts(items) {
  const counts = Object.fromEntries(LEVELS.map((l) => [l.key, 0]));
  for (const k of items) if (k in counts) counts[k] += 1;
  const reached = [...LEVELS].reverse().find((l) => counts[l.key] > 0)?.key ?? null;
  return { ...counts, reached };
}

/** A nudge toward realization, or null when the lesson gets there. */
export function levelAdvice(counts) {
  if (!counts.reached) return null;
  const at = LEVELS.findIndex((l) => l.key === counts.reached);
  if (at >= 4) return null;
  if (at <= 1) return 'Everything so far asks what the text says. Add a question that has them restate it in their own words, and one that relates it to life.';
  if (at === 2) return 'The class can explain the passage, but nothing yet connects it to their lives. Add a question about where this shows up for them.';
  return 'It relates the truth to life but stops short of a response. Give the Took one specific step for this week.';
}

// ---------- the teaching methods library ----------

/**
 * Methods for adult classes, by the step of the lesson they serve, with the level of learning each works at. Adding
 * one writes "Name (N min): how" into that step, so the lesson note shows what you planned.
 */
export const METHODS = [
  { key: 'open-question', step: 'hook', name: 'Open question', minutes: 3, level: 'relation', what: 'A question everyone can answer from experience, which the passage speaks to.', how: 'Ask, “…?” Take a few answers, then turn to the passage.' },
  { key: 'story', step: 'hook', name: 'Story', minutes: 5, level: 'relation', what: 'A short true story, or a case with a dilemma, that raises the need.', how: 'Tell … End with the question it raises: …' },
  { key: 'agree', step: 'hook', name: 'Agree or disagree', minutes: 5, level: 'restatement', what: 'Two or three statements; the class says whether they agree, and why.', how: 'Read each statement and ask who agrees and why.\n1. …\n2. …\n3. …' },
  { key: 'quote', step: 'hook', name: 'Quote reaction', minutes: 4, level: 'restatement', what: 'A provocative quote to react to before you open the Bible.', how: 'Read “…” and ask, “Is that true? Why or why not?”' },
  { key: 'news', step: 'hook', name: 'In the news', minutes: 4, level: 'relation', what: 'A headline or everyday situation that raises the passage’s question.', how: 'Share … and ask how a Christian should think about it.' },
  { key: 'recall', step: 'hook', name: 'Where we left off', minutes: 3, level: 'recognition', what: 'The class recalls last week’s big idea and how their Took went.', how: 'Ask what they remember from last week, and how this week’s step went.' },

  { key: 'observe', step: 'book', name: 'Read and observe', minutes: 8, level: 'recognition', what: 'Read the passage aloud; the class finds who, what, where, when, and repeated words.', how: 'Read the passage aloud. Ask: Who is speaking? To whom? What words repeat?' },
  { key: 'paraphrase', step: 'book', name: 'Paraphrase', minutes: 6, level: 'restatement', what: 'In pairs, rewrite a key verse in everyday words, then share a few.', how: 'In pairs, rewrite verse … in your own words. Share two or three.' },
  { key: 'translations', step: 'book', name: 'Compare translations', minutes: 5, level: 'recognition', what: 'Read a key verse in two or three translations and note the differences.', how: 'Read verse … in the ESV, NIV and NASB. What do the differences bring out?' },
  { key: 'key-word', step: 'book', name: 'Key word', minutes: 5, level: 'restatement', what: 'Explain one word the passage turns on, and what it meant to the first readers.', how: 'The key word is “…”, which means … Ask how that changes the verse.' },
  { key: 'listening-guide', step: 'book', name: 'Listening guide', minutes: 15, level: 'recognition', what: 'Teach the outline while the class fills in blanks on the handout (highlight the blanks in the note).', how: 'Hand out the outline with blanks; highlight the words they fill in.' },
  { key: 'neighbor', step: 'book', name: 'Neighbor nudge', minutes: 3, level: 'restatement', what: 'A pause to tell a neighbor, in one sentence, what a point means.', how: 'After point …, turn to a neighbor and say in one sentence what it means.' },
  { key: 'cross-references', step: 'book', name: 'Cross-references', minutes: 6, level: 'restatement', what: 'Two or three other passages that shed light on this one.', how: 'Read … and … How do they help us understand this passage?' },

  { key: 'groups', step: 'look', name: 'Small groups', minutes: 10, level: 'relation', what: 'Groups of three or four each take one question and report back.', how: 'In groups of three or four, take one question each. Report back in one sentence.' },
  { key: 'case-study', step: 'look', name: 'Case study', minutes: 8, level: 'relation', what: 'A realistic situation: how should this passage shape what someone does?', how: 'Read the situation: … How would this passage shape what they do?' },
  { key: 'principle', step: 'look', name: 'State the principle', minutes: 5, level: 'restatement', what: 'The class writes the passage’s timeless principle in one sentence.', how: 'In one sentence, what is true for God’s people in every time and place here?' },
  { key: 'then-now', step: 'look', name: 'Then and now', minutes: 6, level: 'relation', what: 'Two columns: what it meant to them, and what it means for us.', how: 'Two columns on the board: Then (the first readers) and Now (us).' },
  { key: 'brainstorm', step: 'look', name: 'Brainstorm', minutes: 5, level: 'relation', what: 'List every way this truth could show up in an ordinary week.', how: 'List every place this could show up in an ordinary week: home, work, church.' },
  { key: 'question-box', step: 'look', name: 'Question box', minutes: 5, level: 'restatement', what: 'Cards for the class’s own questions; answer some now and the rest next week.', how: 'Hand out cards for questions. Answer a few now and the rest next week.' },

  { key: 'one-step', step: 'took', name: 'One specific step', minutes: 3, level: 'realization', what: 'Each person writes one thing they will do this week.', how: 'Write down one thing you will do this week because of this passage.' },
  { key: 'partners', step: 'took', name: 'Prayer partners', minutes: 4, level: 'realization', what: 'Pairs pray for each other’s step and check in during the week.', how: 'Pair up, share your step, pray for each other, and check in midweek.' },
  { key: 'memory-verse', step: 'took', name: 'Memory verse', minutes: 2, level: 'rote', what: 'A verse to learn this week; say it together.', how: 'This week’s verse is … Say it together.' },
  { key: 'journal', step: 'took', name: 'Journal prompt', minutes: 2, level: 'relation', what: 'A question to write on at home.', how: 'At home, write on this: …' },
  { key: 'follow-up', step: 'took', name: 'Follow-up next week', minutes: 1, level: 'realization', what: 'Tell them you’ll ask how it went next week (then do, in next week’s hook).', how: 'Next week I’ll ask how your step went.' },
];
export const methodText = (m) => `${m.name} (${m.minutes} min): ${m.how}`;
/** The methods a step's text already uses (each was added as "Name (N min): …"). */
export const methodsIn = (text) => METHODS.filter((m) => new RegExp(`(^|\\n)${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ min\\):`, 'i').test(text ?? ''));

// ---------- aims ----------

export const AIMS = [
  { key: 'know', label: 'Know', hint: 'What should they understand by the end? The truth the whole course teaches.', placeholder: 'That in Christ we have a joy no circumstance can take away' },
  { key: 'feel', label: 'Feel', hint: 'What should they come to value, or how should their attitude change?', placeholder: 'To treasure knowing Christ above comfort and success' },
  { key: 'do', label: 'Do', hint: 'What should they do differently? The response the weeks build toward.', placeholder: 'To rejoice and give thanks in hard things, and to serve others gladly' },
];

/** Where a week stands: its next step, and each step's state. */
export function weekSteps(w, today) {
  const study = w.recap ? 'skip' : w.study ? 'done' : 'todo';
  const lesson = w.lesson ? (w.lesson.complete ? 'done' : 'started') : 'todo';
  const teach = w.done ? 'done' : 'todo';
  const notes = w.reflection ? 'done' : 'todo';
  let next = 'done';
  if (!w.done) {
    if (study === 'todo' && !w.lesson) next = w.ref ? 'study' : 'passage';
    else if (!w.lesson) next = 'lesson';
    else if (w.date && w.date <= today) next = 'taught';
    else next = 'open';
  } else if (!w.reflection) next = 'notes';
  return { study, lesson, teach, notes, next };
}
