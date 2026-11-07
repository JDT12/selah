import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, setSetting } from '../db.js';
import { config } from '../config.js';
import { myNotesId } from '../mynotes.js';
import { logosUrl, parse } from '../../shared/scripture.js';

/**
 * The demo tenant's sample data (Admin 3.2), added by Reset in the admin console (server/admin/demo.js) on an empty
 * database. Everything is made up: Cedar Hollow Bible Church, its people and its pastor's work are fictional. The
 * content is conservative evangelical, written for the demo, and dated around the day of the reset, so each video
 * starts from the same place:
 *
 *   1. A finished study-to-sermon set on Ephesians 2:1–10: a Bible study, a Sunday school lesson and a sermon, each
 *      marked complete, the sermon preached last Sunday, with its slide deck (and a word study on "grace").
 *   2. A half-built set on Psalm 23: a study started two days ago, Step 1 partly filled in, no lesson or sermon (active
 *      on Home's Study tab, left on Step 1).
 *   3. Attendance (11.0) on Plan: the Adult Sunday School class and the Tuesday home group with their rosters
 *      (DEMO_GROUPS), and Sunday worship as a headcount, eight weeks of each from their weekly calendar events. Hal
 *      Pruitt has missed the last three Sundays (the follow-up nudge); Jordan Ames visited the home group last Tuesday.
 *   4. Everyday things: tagged notes, tasks, prayer requests (one answered), a Bible in a Year plan a few days behind,
 *      a memory verse, sermon bank items and a few other events.
 *
 * It goes in through Selah's own API (app.inject, signed in for the moment), so it's stored exactly as the builders
 * and pages store it. Later releases add to it as their features arrive (done marks, attendance, slide themes).
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const DAY = 86_400_000;

export const DEMO_CHURCH = 'Cedar Hollow Bible Church';

/** The people in the demo's groups, for attendance (Phase 3). All made up. */
export const DEMO_GROUPS = {
  class: {
    name: 'Adult Sunday School',
    people: ['Walt Brenner', 'Margaret Brenner', 'Dale Okafor', 'Grace Okafor', 'Hal Pruitt', 'Lorraine Pruitt', 'Sam Whitlock', 'June Castellano', 'Theo Marsh', 'Ruth Delacroix'],
    // Missed the last three Sundays: the nudge to follow up.
    absent: 'Hal Pruitt',
  },
  group: {
    name: 'Tuesday Home Group',
    people: ['Ben Hargrove', 'Lydia Hargrove', 'Marcus Bell', 'Tessa Bell', 'Nate Ferreira', 'Carla Ferreira', 'Elena Voss'],
    // First came last Tuesday.
    visitor: 'Jordan Ames',
  },
};

// ---------- dates ----------

/** Today where the demo is (its time zone), as YYYY-MM-DD. */
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
/** The latest `dow` (0 = Sunday) on or before `iso`, or strictly before with `before`. */
const lastOn = (iso, dow, before = false) => {
  let d = (weekday(iso) - dow + 7) % 7;
  if (before && d === 0) d = 7;
  return addDays(iso, -d);
};
/** Midday on a day, as a timestamp (for backdating). */
const at = (iso, hour = 12) => Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00Z`);

// ---------- HTML ----------

const passageLine = (p) => {
  const r = parse(p).refs[0];
  return r ? `<p><a target="_blank" rel="noopener noreferrer" href="${esc(logosUrl(r))}">${esc(p)}</a></p>` : `<p>${esc(p)}</p>`;
};
const passageLink = (p) => {
  const r = parse(p).refs[0];
  return r ? `<a target="_blank" rel="noreferrer" href="${esc(logosUrl(r, 'esv'))}">${esc(p)}</a>` : esc(p);
};
const paras = (...ps) => ps.filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
const list = (items, tag = 'ul') => `<${tag}>${items.map((i) => (Array.isArray(i)
  ? `<li><p>${esc(i[0])}</p>${list(i[1], tag)}</li>`
  : `<li><p>${esc(i)}</p></li>`)).join('')}</${tag}>`;

// ---------- the content ----------

const EPH = 'Ephesians 2:1–10';

const ephStudyHtml = () => [
  passageLine(EPH),
  '<p>Times read: 4 · Translations: ESV, NASB, CSB</p>',
  '<h1>Step 1: The Text in Their Town</h1>',
  '<h2>People, Places, Things</h2>',
  list([
    'Paul, writing from prison in Rome (3:1; 4:1)',
    'The believers in Ephesus and the churches around it: mostly Gentiles who had come to Christ',
    '"You" (Gentile believers, v. 1) and "we all" (Jewish believers, v. 3): both alike were dead in sin',
    'The prince of the power of the air (v. 2): Satan, at work in the disobedient',
  ]),
  '<h2>Important Words</h2>',
  list([
    'Dead (v. 1): not sick or weak but spiritually lifeless, unable to respond to God',
    'Trespasses and sins (v. 1): stepping over God’s line and missing his mark',
    'Children of wrath (v. 3): rightly under God’s judgment by nature',
    'But God (v. 4): the turning point of the passage',
    'Grace (vv. 5, 8): God’s undeserved favor (see the word study on grace)',
    'Workmanship (v. 10): poiēma, something made, a work of art',
  ]),
  '<h2>Questions</h2>',
  list([
    'Why does Paul describe the readers’ old life before he describes their salvation?',
    'What three things were we following before Christ (vv. 2–3)?',
    'What does God do for us in vv. 5–6, and in what order?',
    'If salvation is not from works (v. 9), why are good works mentioned in v. 10?',
  ]),
  '<h2>Text Summary</h2>',
  paras('Paul reminded the Ephesian believers that they had been spiritually dead, following the world, the devil and their own desires, and rightly under God’s wrath. But God, rich in mercy, made them alive with Christ, raised them and seated them with him, so that in the ages to come he would show the riches of his grace. They were saved by grace through faith, not by works, so no one could boast, and they were created in Christ Jesus for the good works God had prepared for them.'),
  '<h1>Step 2: Measuring the River to Cross</h1>',
  '<h2>Cultural Differences</h2>',
  list([
    'They lived in a city devoted to Artemis and to magic (Acts 19); we live among quieter idols: success, comfort, self.',
    'They were Gentiles once far from Israel’s covenants (2:11–12); most of us have never thought of ourselves as outsiders to God’s promises.',
    'Same: we are sinners saved by the same grace, members of the same church, waiting for the same coming ages.',
  ]),
  '<h1>Step 3: Cross the Principlizing Bridge</h1>',
  '<h2>Theological Principles</h2>',
  list([
    'Apart from Christ every person is spiritually dead and cannot save himself.',
    'Salvation is entirely God’s work, given by grace and received through faith.',
    'God saves sinners to display his kindness and glory, not their merit.',
    'Good works do not earn salvation; they are the purpose and fruit of it.',
  ]),
  '<h1>Step 4: Consult the Biblical Map</h1>',
  '<h2>Biblical Consistency</h2>',
  list([
    'Romans 3:23–24 and 6:23: all have sinned; the gift of God is eternal life.',
    'Titus 3:4–7: he saved us, not because of works done by us, but according to his own mercy.',
    'Colossians 2:13: you, who were dead, God made alive together with him.',
    'James 2:14–26: faith that saves is never alone; it works.',
  ]),
  '<h1>Step 5: The Text in My Town</h1>',
  '<h2>Modern Application</h2>',
  list([
    'Stop trying to earn God’s favor; rest in what Christ has done.',
    'Speak of the gospel to the "good" people you know as plainly as to the "bad": both need to be made alive.',
    'Look for the good works God has prepared for you this week: at home, at work, in the church.',
  ]),
  '<h1>Keeper</h1>',
  paras('We contribute nothing to our salvation but the sin that made it necessary; God contributes everything, and then gives us good works to walk in.'),
].join('');

const psalmStudyHtml = () => [
  passageLine('Psalm 23'),
  '<p>Times read: 2 · Translations: ESV</p>',
  '<h1>Step 1: The Text in Their Town</h1>',
  '<h2>People, Places, Things</h2>',
  list([
    'David: a shepherd before he was king (1 Samuel 16–17)',
    'The LORD as shepherd; the psalmist as one of his sheep',
    'Green pastures, still waters, the valley of the shadow of death, a table, the house of the LORD',
  ]),
  '<h2>Important Words</h2>',
  list([
    'Shepherd (v. 1): one who feeds, leads and protects; also a picture of Israel’s kings',
    'Restores (v. 3): brings back, turns again',
    'Rod and staff (v. 4): ',
  ]),
  '<h2>Questions</h2>',
  list([
    'Why does the psalm change from "he" (vv. 1–3) to "you" (vv. 4–5)?',
    'What enemies did David have when he wrote this?',
  ]),
  '<h2>Text Summary</h2>',
  '<p></p>',
  '<h1>Step 2: Measuring the River to Cross</h1>',
  '<h2>Cultural Differences</h2>',
  '<p></p>',
  '<h1>Step 3: Cross the Principlizing Bridge</h1>',
  '<h2>Theological Principles</h2>',
  '<p></p>',
  '<h1>Step 4: Consult the Biblical Map</h1>',
  '<h2>Biblical Consistency</h2>',
  '<p></p>',
  '<h1>Step 5: The Text in My Town</h1>',
  '<h2>Modern Application</h2>',
  '<p></p>',
  '<h1>Keeper</h1>',
  '<p></p>',
].join('');

const graceWordHtml = () => [
  passageLine('Ephesians 2:8'),
  '<h1>The Word</h1>',
  '<h2>English Word</h2>', paras('grace'),
  '<h2>Why It Matters</h2>', paras('Paul says twice in Ephesians 2:1–10 that we are saved by grace (vv. 5, 8). The whole passage turns on what grace means.'),
  '<h1>Original Language</h1>',
  '<h2>Notes</h2>', paras('χάρις (charis), G5485: favor, kindness freely given; also thanks, and a gift.'),
  '<h1>Translations</h1>',
  '<h2>Notes</h2>', paras('ESV, NASB, CSB and KJV all have "grace" in 2:5 and 2:8.'),
  '<h1>Range of Meaning</h1>',
  '<h2>Notes</h2>', list(['Favor or goodwill shown to someone (Luke 1:30)', 'A gift or act of kindness (2 Corinthians 8:6–7)', 'Thanks (1 Corinthians 15:57)', 'God’s undeserved favor in saving sinners (Romans 3:24)']),
  '<h1>Usage</h1>',
  '<h2>Notes</h2>', paras('About 155 times in the New Testament, most of them in Paul. Ephesians uses it twelve times, often with "riches" (1:7; 2:7).'),
  '<h1>In This Context</h1>',
  '<h2>Meaning Here</h2>', paras('God’s undeserved favor that saves sinners: a gift, not a wage.'),
  '<h2>Why This Sense</h2>', paras('Verse 8 sets grace against works and calls salvation "the gift of God"; verse 9 rules out boasting. Grace here is the opposite of something earned.'),
  '<h1>Keeper</h1>',
  paras('Grace is God giving what we could never earn to people who deserved the opposite.'),
].join('');

const LESSON_TITLE = 'Saved by Grace, Made for Good Works';
const lessonHtml = () => [
  `<p><strong>Title: ${esc(LESSON_TITLE)}</strong></p>`,
  `<p><strong>Verses: </strong>${passageLink(EPH)}</p>`,
  '<h1>Introduction (Hook)</h1>',
  paras('Ask the class: If you were asked "Why should God let you into heaven?", what do most people you know say? Write the answers on the board. Most of them will be about being a good person.'),
  `<p>${passageLink(EPH)}</p>`,
  '<h1>Exposition (Book)</h1>',
  '<p><strong>Big idea:</strong> God saves dead sinners by grace alone, and then gives them good works to do.</p>',
  list([
    ['What we were: dead in sin (vv. 1–3)', ['Following the world, the devil and our own desires', 'By nature children of wrath, like everyone else']],
    ['What God did: made us alive (vv. 4–7)', ['"But God": rich in mercy, because of his great love', 'Made alive, raised up and seated with Christ']],
    ['How it happens: by grace through faith (vv. 8–9)', ['Grace is the source; faith is the hand that receives', 'Not our own doing, so no one may boast']],
    ['Why: for good works (v. 10)', ['We are his workmanship', 'The works were prepared beforehand for us to walk in']],
  ], 'ol'),
  '<h1>Inquisition (Look)</h1>',
  list([
    ['How does Paul describe life before Christ, and why start there?', ['Dead, enslaved, under wrath: you have to know the bad news to treasure the good news']],
    ['What do the words "But God" in verse 4 change?', ['Everything: the rescue starts with God, not with us']],
    ['If works can’t save us, why does Paul bring up good works in verse 10?', ['They are the purpose of salvation, not the price of it']],
    'Where might God have prepared good works for you this week?',
  ], 'ol'),
  '<h1>Application (Took)</h1>',
  paras('This week, thank God each morning that you are saved by grace, and look for one good work he has prepared for you. Come ready to tell the class about it next Sunday.'),
].join('');

const SERMON_TITLE = 'Dead, Made Alive, Created for Good Works';
const DIVISIONS = [
  { statement: 'We were dead in our sins', verses: 'vv. 1–3',
    explanation: 'Paul does not say we were sick or struggling. We were dead: unable to respond to God, following the world, the devil and our own desires, and by nature children of wrath.',
    illustration: 'A lifeguard can coach a struggling swimmer to the side of the pool. He cannot coach a drowned man. He has to go in and bring him out.',
    argumentation: 'Romans 3:10–12 says no one seeks God. Colossians 2:13 says the same: you were dead in your trespasses.',
    application: 'Stop thinking of the gospel as advice for good people. It is life for dead people, you and me included.',
    transition: 'If that were the end of the story, there would be no hope. But it is not the end.' },
  { statement: 'God made us alive in Christ', verses: 'vv. 4–7',
    explanation: '"But God." Rich in mercy, because of his great love, God made us alive together with Christ, raised us up and seated us with him, to show the riches of his grace in the ages to come.',
    illustration: 'Lazarus did not help Jesus raise him. He heard a voice that gives life, and he came out (John 11:43–44).',
    argumentation: 'The verbs all have God as their subject. Salvation is something God does, not something we finish.',
    application: 'If you are in Christ, your standing with God is as secure as Christ’s seat at his right hand.',
    transition: 'How does that new life become ours?' },
  { statement: 'We are saved by grace through faith', verses: 'vv. 8–9',
    explanation: 'Grace is the source, faith is the means, and Christ is the object. It is the gift of God, not a result of works, so that no one may boast.',
    illustration: 'A gift you pay for is not a gift. If you hand over money for your birthday present, it has become a purchase.',
    argumentation: 'Titus 3:5: he saved us, not because of works done by us in righteousness, but according to his own mercy.',
    application: 'Trust Christ today. Stop adding your record to his; rest in his record alone.',
    transition: 'Does that mean good works do not matter? Paul answers in the next verse.' },
  { statement: 'We are created for good works', verses: 'v. 10',
    explanation: 'We are God’s workmanship, created in Christ Jesus for good works that God prepared beforehand. Works are not the root of salvation; they are its fruit.',
    illustration: 'A master craftsman does not build a violin to sit in its case. He makes it to be played.',
    argumentation: 'James 2:17: faith by itself, if it does not have works, is dead. Real faith always walks.',
    application: 'Ask God this week to show you the good works he has already prepared for you, and walk in them.' },
];
const divisionTitle = (d) => `${d.statement} (${d.verses})`;
const sermonHtml = () => [
  passageLine(EPH),
  '<h1>Introduction</h1>',
  '<h2>Attention</h2>', paras('Most people believe that if their good deeds outweigh their bad, God will accept them. The Bible says something far more humbling, and far more hopeful.'),
  '<h2>Need</h2>', paras('If we are trying to earn God’s favor, we will either despair because we fall short or grow proud because we think we have made it. Both keep us from Christ.'),
  '<h2>Bible Text</h2>', paras('Turn with me to Ephesians 2:1–10.'),
  '<h2>Bridging Sentences</h2>',
  '<p>Subject / Modifier: How sinners are saved / by grace through faith, for good works</p>',
  '<p>Text Idea: God made dead sinners alive in Christ by grace through faith, so that they would walk in good works he prepared.</p>',
  '<p>Sermon Idea: God saves dead sinners by grace alone, and then gives them good works to do.</p>',
  '<p>Interrogative: What does God do for sinners, and why?</p>',
  '<p>Transition: Paul shows us four things in these ten verses.</p>',
  ...DIVISIONS.map((d) => [
    `<h1>${esc(divisionTitle(d))}</h1>`,
    '<h2>Explanation</h2>', paras(d.explanation),
    '<h2>Illustration</h2>', paras(d.illustration),
    '<h2>Argumentation</h2>', paras(d.argumentation),
    '<h2>Application</h2>', paras(d.application),
    d.transition ? `<p><strong>Transition: ${esc(d.transition)}</strong></p>` : '',
  ].join('')),
  '<h1>Conclusion</h1>',
  '<h2>Visualization</h2>', paras('Picture yourself in the valley of dry bones (Ezekiel 37), and then hear God’s voice: "I will cause breath to enter you, and you shall live."'),
  '<h2>Reiteration</h2>', list(DIVISIONS.map((d) => divisionTitle(d)), 'ol'),
  '<h2>Action</h2>', paras('If you have never trusted Christ, come to him today with empty hands. If you have, give thanks, and walk in the good works he has prepared for you this week.'),
].join('');

// ---------- 11.0: the church brand and the slide media library ----------
// Pictures drawn here (SVG), so the demo needs no photos: the church logo and two pictures for slides.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 120"><circle cx="60" cy="60" r="50" fill="#6e1f2a"/>
<path d="M60 22v76M40 44h40" stroke="#f4ead5" stroke-width="7" stroke-linecap="round"/><path d="M30 92c10-14 50-14 60 0" stroke="#d9a441" stroke-width="5" fill="none" stroke-linecap="round"/>
<text x="128" y="56" font-family="Georgia, serif" font-size="34" font-weight="700" fill="#6e1f2a">Cedar Hollow</text>
<text x="130" y="90" font-family="Georgia, serif" font-size="22" letter-spacing="3" fill="#8a6a3a">BIBLE CHURCH</text></svg>`;
const HILLS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6d6a8"/><stop offset="0.55" stop-color="#f3b98a"/><stop offset="1" stop-color="#c98a6a"/></linearGradient></defs>
<rect width="1600" height="900" fill="url(#s)"/><circle cx="1150" cy="430" r="120" fill="#fff3d6" opacity="0.9"/>
<path d="M0 560C260 470 520 520 760 580S1260 520 1600 470V900H0Z" fill="#9c6b5a"/><path d="M0 680C300 600 640 660 900 700S1340 640 1600 620V900H0Z" fill="#6f4a45"/>
<path d="M0 790C360 740 760 780 1080 810S1460 780 1600 770V900H0Z" fill="#45302f"/></svg>`;
const WINDOW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#1d1a24"/>
<path d="M560 860V330a240 240 0 0 1 480 0v530Z" fill="#2c3a5a" stroke="#c9a45c" stroke-width="14"/>
<path d="M800 120v740M560 470h480M560 640h480M640 860V300M960 860V300" stroke="#c9a45c" stroke-width="9"/>
<path d="M800 160 690 300h220Z" fill="#9b2f3c" opacity="0.85"/><path d="M640 470h160v170H640Z" fill="#2f6b8a" opacity="0.8"/><path d="M800 470h160v170H800Z" fill="#c98a2f" opacity="0.8"/>
<path d="M640 640h160v220H640Z" fill="#3f7a52" opacity="0.8"/><path d="M800 640h160v220H800Z" fill="#7a3f8a" opacity="0.7"/><circle cx="800" cy="380" r="60" fill="#e8c46a" opacity="0.85"/></svg>`;

/** A file kept with no note (like the brand logo and the media library's pictures). Returns its attachment id. */
function noteless(name, mime, text) {
  const storage = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(config.filesDir, storage), text);
  return Number(db.prepare('INSERT INTO attachments (note_id, filename, mime, size, storage, created_at) VALUES (NULL, ?, ?, ?, ?, ?)')
    .run(name, mime, Buffer.byteLength(text), storage, Date.now()).lastInsertRowid);
}
/** The church brand and two pictures in the media library: { hills, window }. */
function seedMedia() {
  const logo = noteless('Cedar Hollow logo.svg', 'image/svg+xml', LOGO_SVG);
  setSetting('slide_brand', JSON.stringify({ name: DEMO_CHURCH, primary: '#6e1f2a', secondary: '#b08a4a', accent: '#d9a441', base: 'light', fonts: 'elegant', art: 'wheat', logo, logoPos: 'tr' }));
  const pics = {};
  for (const [k, name, svg] of [['hills', 'Hillside at dawn.svg', HILLS_SVG], ['window', 'Sanctuary window.svg', WINDOW_SVG]]) {
    pics[k] = noteless(name, 'image/svg+xml', svg);
    db.prepare('INSERT INTO slide_media (attachment_id, created_at) VALUES (?, ?)').run(pics[k], Date.now());
  }
  return pics;
}

/**
 * The sermon's deck as the slide editor would make it from the outline, plus slides of its own. 11.0: in the church
 * brand theme, the title over a picture from the media library, and the window picture on its own slide.
 */
function sermonDeck(media = {}) {
  let n = 0;
  const id = () => `sdemo${(n++).toString(36)}`;
  const gen = (s) => ({ title: s.title ?? '', text: s.text ?? '', ref: s.ref ?? '', answer: s.answer ?? '', points: (s.points ?? []).map((p) => [p.level, p.text]) });
  const make = (src, s) => ({ id: id(), ...s, src, gen: gen(s) });
  const idea = 'God saves dead sinners by grace alone, and then gives them good works to do.';
  return {
    theme: 'brand',
    kind: 'sermon',
    translation: '',
    logo: true,
    slides: [
      make('title', { type: 'title', title: SERMON_TITLE, text: EPH, anchor: '^', notes: `${DEMO_CHURCH} · Sunday morning`, ...(media.hills ? { bg: media.hills } : {}) }),
      ...(media.window ? [{ id: id(), type: 'image', title: 'Welcome to Cedar Hollow', text: '', anchor: '', image: media.window, fit: 'cover' }] : []),
      make('passage', { type: 'passage', title: '', ref: EPH, anchor: EPH }),
      make('big', { type: 'point', title: '', text: idea, anchor: idea.slice(0, 80) }),
      ...DIVISIONS.flatMap((d, i) => [
        make('division', { type: 'point', title: `${i + 1}. ${d.statement}`, text: d.verses, anchor: divisionTitle(d).slice(0, 120) }),
        ...(i === 2 ? [{ id: id(), type: 'passage', title: '', ref: 'Ephesians 2:8–9', anchor: 'Grace is the source, faith is the means' }] : []),
      ]),
      make('summary', { type: 'point', title: 'Summary', points: DIVISIONS.map((d) => ({ text: d.statement, level: 0, anchor: '' })), anchor: 'Conclusion' }),
      { id: id(), type: 'question', title: 'Where has God prepared good works for you this week?', answer: '', anchor: 'Action' },
    ],
    dismissed: [],
  };
}

const NOTES = [
  { title: 'Elders’ meeting agenda', tags: ['Church', 'Meetings'], html: () => [
    paras(`${DEMO_CHURCH} · elders’ meeting, Thursday 7:00 pm`),
    list(['Opening prayer and Scripture (1 Peter 5:1–4)', 'Membership: two new families to interview', 'Spring Bible conference: speaker and dates', 'Deacon nominations', 'Shepherding: who needs a visit this month?', 'Closing prayer'], 'ol'),
  ].join('') },
  { title: 'Hospital and shut-in visits', tags: ['Pastoral care'], html: () => [
    paras('Visit list for this month. Bring the Lord’s Supper for shut-ins on the first Sunday.'),
    list(['Ida Moreland: home from surgery, call before visiting', 'Earl Lindqvist: assisted living, Room 114', 'The Garza family: new baby, take a meal', 'Frank Dobbins: grieving, wife went home to be with the Lord in September']),
  ].join('') },
  { title: 'Sermon series ideas', tags: ['Preaching', 'Ideas'], html: () => [
    paras('Possible series for next year:'),
    list(['Ephesians: Saved for the glory of his grace (finish chapters 3–6)', 'Psalms of the Shepherd: Psalm 23, 80, 95, 100', 'The "I am" sayings of Jesus in John', 'Ruth: redemption in an ordinary town']),
  ].join('') },
  { title: 'Book notes: The Attributes of God', tags: ['Reading', 'Theology'], html: () => [
    paras('Notes from my reading this fall.'),
    '<h2>Holiness</h2>', paras('God is set apart from all sin and from all creation. Isaiah 6 is the place to start.'),
    '<h2>Mercy and grace</h2>', paras('Mercy withholds the punishment we deserve; grace gives the favor we do not deserve. Ephesians 2:4–5 has both.'),
    '<h2>Immutability</h2>', paras('God does not change (Malachi 3:6; James 1:17), so his promises do not change either.'),
  ].join('') },
  { title: 'Vacation Bible School planning', tags: ['Church', 'Children'], html: () => [
    paras('Theme: "The Good Shepherd". Week of June 15, 9:00–noon.'),
    list(['Order curriculum by March 1', 'Recruit 12 volunteers and 4 teen helpers', 'Background checks for every volunteer', 'Snack and craft supplies', 'Closing program Friday night for parents']),
  ].join('') },
];

const PRAYERS = [
  { title: 'Healing after surgery', person: 'Ida Moreland', category: 'Church family', details: 'Hip replacement; recovering at home. Pray for strength and patience.' },
  { title: 'Salvation for her husband', person: 'Lorraine Pruitt', category: 'Church family', details: 'Lorraine has prayed for Hal for years. Pray that he would hear the gospel and believe.' },
  { title: 'Wisdom for the elders', person: '', category: 'Church', details: 'Decisions about the spring conference and deacon nominations.' },
  { title: 'Missionaries in Peru', person: 'The Castillo family', category: 'Missions', details: 'Bible translation work and their children’s schooling.' },
  { title: 'A job for Marcus', person: 'Marcus Bell', category: 'Home group', details: 'Laid off in August.', answered: 'Marcus started a new job last week, and he and Tessa thanked the group for praying.' },
];

const TASKS = (today) => [
  { title: 'Finish the Psalm 23 study', due_date: addDays(today, 4), priority: 2, description: 'Step 1 summary, then Steps 2–5.' },
  { title: 'Write next Sunday’s lesson', due_date: addDays(lastOn(today, 6), 7), priority: 2 },
  { title: 'Call Hal Pruitt', due_date: addDays(today, 1), priority: 3, description: 'He has missed Sunday school for three weeks.' },
  { title: 'Follow up with Jordan Ames (visitor)', due_date: addDays(today, 2), priority: 1, description: 'Came to the Tuesday home group for the first time.' },
  { title: 'Order VBS curriculum', due_date: addDays(today, 21), priority: 1 },
  { title: 'Send the elders’ meeting agenda', due_date: addDays(today, -2), priority: 2, done: true },
];

const BANK = [
  { kind: 'illustration', title: 'The lifeguard and the drowned man', topics: ['grace', 'salvation'], passage: 'Ephesians 2:1–5',
    html: paras('A lifeguard can shout advice to a struggling swimmer. A drowned man needs to be pulled out and given breath. The gospel is not advice for swimmers; it is rescue for the dead.') },
  { kind: 'illustration', title: 'A gift you pay for', topics: ['grace', 'faith'], passage: 'Ephesians 2:8–9',
    html: paras('If you insist on paying for your birthday present, it is no longer a gift. It has become a purchase. Grace that we pay for is no longer grace (Romans 11:6).') },
  { kind: 'application', title: 'Good works prepared beforehand', topics: ['good works', 'sanctification'], passage: 'Ephesians 2:10',
    html: paras('Before you get up on Monday, God has already prepared good works for you to walk in: at the kitchen table, at work, with your neighbor. Ask him to open your eyes to them.') },
];

// ---------- putting it in ----------

/** The seeded sign-in and devices go back, so the person who reset the demo is still signed in. */
function restoreAccount({ settings = {}, sessions = [] }) {
  for (const [k, v] of Object.entries(settings)) if (typeof v === 'string') setSetting(k, v);
  const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const keys = Object.keys(s ?? {}).filter((k) => cols.has(k));
    if (!keys.includes('token_hash')) continue;
    db.prepare(`INSERT OR IGNORE INTO sessions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => s[k]));
  }
}

/**
 * Adds the sample data. `body` is what the console kept from before: { settings, sessions }. Refused when the
 * database has notes of its own already (only an empty demo is seeded).
 */
export async function seedDemo(app, body = {}) {
  const own = db.prepare('SELECT count(*) AS n FROM notes WHERE is_template = 0').get().n;
  if (own > 0) throw httpError(409, 'The demo already has notes. Reset it from the admin console, which empties it first.');
  restoreAccount(body);

  // Signed in for the moment, as the app itself.
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash, created_at, expires_at, ip, user_agent, app, last_seen_at, two_factor, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hash, now, now + 3_600_000, '127.0.0.1', 'Selah demo seed', null, now, 1, now);
  const cookie = `__Host-selah_session=${token}`;
  const api = async (method, url, payload) => {
    const r = await app.inject({
      method, url, payload, remoteAddress: '127.0.0.1',
      // Selah Desktop's demo (desktopdemo.js) goes through the desktop key instead of a session.
      headers: { cookie, host: 'demo.localhost', 'sec-fetch-site': 'same-origin', 'user-agent': 'Selah demo seed', ...(config.desktopKey ? { 'x-selah-desktop': config.desktopKey } : {}) },
    });
    const data = r.body ? (() => { try { return JSON.parse(r.body); } catch { return r.body; } })() : null;
    if (r.statusCode >= 400) throw httpError(500, `Seeding ${method} ${url}: ${data?.error ?? r.statusCode}`);
    return data;
  };
  const counts = { notes: 0, studies: 0, events: 0, tasks: 0, prayers: 0 };
  const backdate = (noteId, created, updated = created) => db.prepare('UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?').run(created, updated, noteId);
  const complete = (noteId, when) => {
    db.prepare('INSERT INTO note_complete (note_id, completed_at) VALUES (?, ?) ON CONFLICT(note_id) DO UPDATE SET completed_at = excluded.completed_at').run(noteId, when);
    db.prepare("UPDATE sermons SET status = 'ready' WHERE note_id = ?").run(noteId);
  };

  try {
    const today = todayIso();
    const sunday = lastOn(today, 0, true); // last Sunday (a week ago when today is Sunday)

    // 1. The finished set on Ephesians 2:1–10.
    const study = await api('POST', '/api/bible-studies', { passage: EPH, title: `${EPH} Study` });
    await api('PUT', `/api/notes/${study.note_id}/bible-study`, { html: ephStudyHtml() });
    counts.studies++;

    const word = await api('POST', '/api/bible-studies', {
      method: 'word', passage: 'Ephesians 2:8', title: 'Grace (charis)',
      data: { word: { english: 'grace', strongs: 'G5485', code: 'G5485', lemma: 'χάρις', translit: 'charis', lang: 'greek', gloss: 'grace, favor, gift', pos: 'noun' } },
    });
    await api('PUT', `/api/notes/${word.note_id}/bible-study`, { html: graceWordHtml() });
    counts.studies++;

    const teaching = await api('POST', '/api/studies', { title: 'Adult Sunday School: Ephesians', kind: 'teaching', description: `${DEMO_CHURCH}, Sundays 9:30 am` });
    const lesson = await api('POST', `/api/bible-studies/${study.id}/lesson`, {
      study_id: teaching.id, title: LESSON_TITLE,
      material: { principle: 'God saves dead sinners by grace alone, and then gives them good works to do.' },
    });
    const lessonNote = lesson.note_id ?? lesson.id;
    await api('PUT', `/api/notes/${lessonNote}/lesson`, { html: lessonHtml(), title: LESSON_TITLE });

    const sermon = await api('POST', '/api/sermons', { passage: EPH, title: SERMON_TITLE, html: sermonHtml() });
    await api('PUT', `/api/notes/${sermon.note_id}/slides`, { deck: sermonDeck(seedMedia()) });
    await api('POST', `/api/notes/${sermon.note_id}/preached`, { date: sunday, place: DEMO_CHURCH, occasion: 'Sunday morning worship', minutes: 36 });
    for (const b of BANK) await api('POST', '/api/sermon-bank', b);

    // Studied three weeks ago, taught and preached last Sunday, all marked complete.
    backdate(study.note_id, at(addDays(sunday, -18), 14), at(addDays(sunday, -12), 15));
    backdate(word.note_id, at(addDays(sunday, -16), 14), at(addDays(sunday, -15), 16));
    backdate(lessonNote, at(addDays(sunday, -10), 14), at(addDays(sunday, -2), 20));
    backdate(sermon.note_id, at(addDays(sunday, -9), 14), at(addDays(sunday, -1), 21));
    complete(study.note_id, at(addDays(sunday, -12), 15));
    complete(word.note_id, at(addDays(sunday, -15), 16));
    complete(lessonNote, at(sunday, 17));
    complete(sermon.note_id, at(sunday, 18));

    // 2. The half-built set: a Psalm 23 study started two days ago.
    const psalm = await api('POST', '/api/bible-studies', { passage: 'Psalm 23', title: 'Psalm 23 Study' });
    await api('PUT', `/api/notes/${psalm.note_id}/bible-study`, { html: psalmStudyHtml() });
    // 11.0: left on Step 1 (The Text in Their Town), so Home shows it as active at Step 1 of 6.
    await api('PATCH', `/api/bible-studies/${psalm.id}`, { data: { step: 1 } });
    backdate(psalm.note_id, at(addDays(today, -2), 15), at(addDays(today, -1), 16));
    counts.studies++;

    // 3. Everyday notes, tagged.
    const nb = myNotesId();
    for (const [i, n] of NOTES.entries()) {
      const { id } = await api('POST', '/api/notes', { notebook_id: nb, title: n.title, html: n.html() });
      await api('PATCH', `/api/notes/${id}`, { tags: n.tags });
      backdate(id, at(addDays(today, -(3 + i * 4)), 15));
      counts.notes++;
    }
    await api('POST', '/api/memory-verses', { ref: 'Ephesians 2:8–9' });

    // 4. The calendar: the weekly meetings attendance comes from (eight weeks of them so far), and a few more.
    const firstSunday = addDays(sunday, -7 * 7);
    const firstTuesday = addDays(lastOn(today, 2, true), -7 * 7);
    const firstWeek = addDays(sunday, -7 * 7);
    const events = [
      { title: `${DEMO_GROUPS.class.name}: Ephesians`, location: 'Room 4, Fellowship Hall', start: `${firstSunday}T09:30`, end: `${firstSunday}T10:30`, rrule: 'FREQ=WEEKLY;BYDAY=SU' },
      { title: 'Sunday morning worship', location: DEMO_CHURCH, start: `${firstWeek}T10:45`, end: `${firstWeek}T12:00`, rrule: 'FREQ=WEEKLY;BYDAY=SU' },
      { title: DEMO_GROUPS.group.name, location: 'The Hargroves’ home', start: `${firstTuesday}T19:00`, end: `${firstTuesday}T20:30`, rrule: 'FREQ=WEEKLY;BYDAY=TU' },
      { title: 'Wednesday prayer meeting', location: DEMO_CHURCH, start: `${addDays(firstTuesday, 1)}T19:00`, end: `${addDays(firstTuesday, 1)}T20:00`, rrule: 'FREQ=WEEKLY;BYDAY=WE' },
      { title: 'Elders’ meeting', location: 'Church office', start: `${addDays(lastOn(today, 4), 7)}T19:00`, end: `${addDays(lastOn(today, 4), 7)}T20:30` },
      { title: 'Men’s breakfast', location: 'Fellowship Hall', start: `${addDays(lastOn(today, 6), 7)}T07:30`, end: `${addDays(lastOn(today, 6), 7)}T09:00` },
    ];
    const eventIds = [];
    for (const e of events) { eventIds.push((await api('POST', '/api/events', { ...e, all_day: false })).id); counts.events++; }

    // 4b. Attendance: eight weeks of each group, the same every reset (no randomness).
    const weeks = (first) => Array.from({ length: 8 }, (_, i) => addDays(first, 7 * i));
    const takeRoster = async (spec, eventId, kind, first, misses) => {
      const { id } = await api('POST', '/api/attendance/groups', { name: spec.name, kind, mode: 'roster', event_id: eventId, people: spec.people });
      const roster = (await api('GET', `/api/attendance/groups/${id}`)).roster;
      const dates = weeks(first);
      for (const [w, date] of dates.entries()) {
        const present = roster.filter((p) => !misses(p.name, w, dates.length)).map((p) => p.id);
        await api('PUT', `/api/attendance/groups/${id}/meetings/${date}`, { present });
      }
      counts.attendance = (counts.attendance ?? 0) + 1;
      return { id, dates };
    };
    // Everyone misses now and then (one week in eight or so, never two in a row); Hal Pruitt the last three Sundays.
    const now_and_then = (name, w) => [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 9 === w;
    await takeRoster(DEMO_GROUPS.class, eventIds[0], 'class', firstSunday,
      (name, w, n) => (name === DEMO_GROUPS.class.absent ? w >= n - 3 : now_and_then(name, w)));
    const home = await takeRoster(DEMO_GROUPS.group, eventIds[2], 'group', firstTuesday, now_and_then);
    await api('POST', `/api/attendance/groups/${home.id}/people`, { name: DEMO_GROUPS.group.visitor, visitor: true, date: home.dates.at(-1) });
    const worship = await api('POST', '/api/attendance/groups', { name: 'Sunday morning worship', kind: 'service', mode: 'headcount', event_id: eventIds[1] });
    for (const [w, date] of weeks(firstWeek).entries()) {
      await api('PUT', `/api/attendance/groups/${worship.id}/meetings/${date}`, { headcount: [142, 138, 151, 147, 139, 156, 149, 144][w], notes: w === 5 ? 'Baptism Sunday' : '' });
    }
    counts.attendance += 1;

    // 5. Tasks, prayer, a reading plan a few days behind.
    for (const t of TASKS(today)) {
      const { id } = await api('POST', '/api/tasks', { title: t.title, due_date: t.due_date, priority: t.priority, description: t.description ?? '' });
      if (t.done) await api('POST', `/api/tasks/${id}/complete`);
      counts.tasks++;
    }
    for (const p of PRAYERS) {
      const r = await api('POST', '/api/prayer', { title: p.title, person: p.person, category: p.category, details: p.details, schedule: 'daily', today: addDays(today, -30) });
      if (p.answered) await api('PATCH', `/api/prayer/${r.id}`, { status: 'answered', answer: p.answered, closed_day: addDays(today, -5) });
      counts.prayers++;
    }
    const plan = await api('POST', '/api/plans', { source: 'bibleyear', start_date: addDays(today, -40), today });
    for (let d = 0; d < 37; d++) await api('PUT', `/api/plans/${plan.id}/read`, { day: d, read: true, today });

    return { ok: true, counts };
  } finally {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
  }
}
