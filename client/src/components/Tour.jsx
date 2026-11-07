import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';
import { showDeskTab } from '../pages/DeskPage.jsx';

/**
 * The guided tour (11.0): a spotlight on one part of Selah at a time, with Next, Back and Skip, moving from page to
 * page: the rail, Home and Desk, how a study leads to a lesson and a sermon, tabs, the passage page, and preaching
 * with slides. It's offered once to everyone (new and existing), and Settings → About plays it again. Along the way
 * you can make a sample word study to look around in, deleted again with one click.
 */
export const startTour = () => window.dispatchEvent(new Event('noteapp:tour'));

const SAMPLE_PREF = 'tourSample';
const OFFER_PREF = 'tourOffered';
const show = (section) => window.dispatchEvent(new CustomEvent('noteapp:show-section', { detail: section }));
const scripture = (q) => window.dispatchEvent(new CustomEvent('noteapp:open-scripture', { detail: q }));

const para = (t) => `<p>${t}</p>`;
/** The sample word study: "love" (agapē) in John 3:16, filled in so the builder has something to show. */
const SAMPLE_HTML = [
  '<h1>The Word</h1>', '<h2>English Word</h2>', para('love'),
  '<h2>Why It Matters</h2>', para('John 3:16 grounds the whole gospel in God’s love: the giving of the Son starts there.'),
  '<h1>Original Language</h1>', '<h2>Notes</h2>', para('ἀγαπάω (agapaō), G0025: to love, to cherish, to be devoted to.'),
  '<h1>Translations</h1>', '<h2>Notes</h2>', para('ESV, NASB, CSB and KJV all have “loved.”'),
  '<h1>Range of Meaning</h1>', '<h2>Notes</h2>', '<ul><li><p>Love shown in action toward another (John 13:34)</p></li><li><p>Devotion to something (John 3:19, “loved the darkness”)</p></li></ul>',
  '<h1>Usage</h1>', '<h2>Notes</h2>', para('About 143 times in the New Testament, 37 of them in John’s Gospel.'),
  '<h1>In This Context</h1>', '<h2>Meaning Here</h2>', para('God’s self-giving love for a world in rebellion against him.'),
  '<h2>Why This Sense</h2>', para('“So loved … that he gave”: the love is measured by the gift.'),
  '<h1>Keeper</h1>', para('God’s love is known by what it gives.'),
].join('');

async function makeSample() {
  const s = await api.createBibleStudy({
    method: 'word', passage: 'John 3:16', title: 'Sample word study: love (agapaō)',
    data: { word: { english: 'love', strongs: 'G0025', code: 'G0025', lemma: 'ἀγαπάω', translit: 'agapaō', lang: 'greek', gloss: 'to love', pos: 'verb' } },
  });
  await api.writeBibleStudy(s.note_id, { html: SAMPLE_HTML }).catch(() => {});
  await api.setPref(SAMPLE_PREF, s.note_id);
  window.dispatchEvent(new Event('noteapp:notes-changed'));
  return s.note_id;
}
export async function deleteSample() {
  const id = await api.getPref(SAMPLE_PREF).catch(() => null);
  if (id) await api.deleteNoteForever(id).catch(() => {});
  await api.setPref(SAMPLE_PREF, null);
  window.dispatchEvent(new Event('noteapp:notes-changed'));
}

/** The steps. `go` takes you to the step's page; `at` is what's lit up (the first match that's on screen). */
const STEPS = [
  { title: 'Welcome to Selah 11', text: 'A two-minute look at what’s where. Next and Back move through it; Skip ends it any time. You can play it again from Settings → About.' },
  { at: '.app-rail, .ar-tabbar', go: () => show('dashboard'), side: 'right', title: 'The rail',
    text: 'Your day first (Home, Plan, Inbox), then your study and devotion: Walk, Bible, Desk and Preach. My notes and Utility sit below; Settings is at the foot.' },
  { at: '.home-page .home-tabs', go: () => show('dashboard'), title: 'Home: what’s active',
    text: 'Home’s Study, Teach, Write and Learn tabs list only work that’s still active, each with the step it’s on (Step 3 of 7) and Mark done. Done work leaves Home and stays on Desk.' },
  { at: '.desk-page .home-tabs, .desk-page .work-list', go: () => { showDeskTab('study'); show('desk'); }, title: 'Desk: all of it',
    text: 'Desk lists everything you study, teach, write and learn, active and done. The chips pick a type (Bible study, word study, lesson, sermon…), and Active or Done shows one or the other. Each row has its passage and date.' },
  { at: '.desk-page .page-actions .btn-primary', go: () => { showDeskTab('study'); show('desk'); }, sample: true, title: 'Study, then teach and preach',
    text: 'Work starts with a study of the passage. When it’s done, Take it further turns it into a lesson or a sermon, so the lesson and sermon start from what you found. Want something to look around in? Make a sample word study.' },
  { at: '.top-tabs', title: 'Tabs, like a browser’s',
    text: 'The first tab follows you around Selah. A builder always opens in its own tab, and closing the builder closes its tab. To keep a note, study or course open beside it, Ctrl-click it, middle-click it, or right-click → Open in new tab. Clicking the rail from a builder takes you back to the main tab and leaves the builder open.' },
  { at: '.pv-work', go: () => scripture('Ephesians 2:1-10'), side: 'left', title: 'Your work on a passage',
    text: 'Every passage page lists your studies, lessons and sermons on those verses, with how far along each is, so you can pick up where you were or see what you’ve already preached.' },
  { at: '.studies-tabs', go: () => show('sermons'), title: 'Preaching and slides',
    text: 'Preach holds your sermons, the log of when and where you preached them, series, and the sermon bank. Open a sermon and Preach puts it on screen with a timer. Its Slides tab builds the deck from your outline: pick a theme or your church’s brand, background art and a translation, type through it all in Outline, and download it for PowerPoint. The slides window goes on a second screen, and your phone can be the remote.' },
  { final: true, title: 'That’s the tour', text: 'Play it again any time from Settings → About.' },
];

/** The lit-up element's box, or null (no target, or it isn't on screen yet). */
function useTarget(selector, step) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    if (!selector) { setRect(null); return undefined; }
    let live = true;
    let tries = 0;
    const find = () => {
      const el = [...document.querySelectorAll(selector)].find((x) => x.getClientRects().length);
      if (el) {
        el.scrollIntoView?.({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        if (live) setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      } else if (live) setRect(null);
      return !!el;
    };
    const timer = setInterval(() => { tries += 1; if (find() && tries > 3) clearInterval(timer); if (tries > 30) clearInterval(timer); }, 100);
    find();
    const onResize = () => find();
    window.addEventListener('resize', onResize);
    return () => { live = false; clearInterval(timer); window.removeEventListener('resize', onResize); };
  }, [selector, step]);
  return rect;
}

export default function Tour() {
  const dialog = useDialog();
  const [at, setAt] = useState(null); // the step, or null when the tour isn't running
  const [offer, setOffer] = useState(false);
  const [sample, setSample] = useState(null);
  const step = at == null ? null : STEPS[at];
  const rect = useTarget(step?.at, at);
  const card = useRef(null);

  useEffect(() => {
    api.getPref(OFFER_PREF).then((v) => { if (!v) setOffer(true); }).catch(() => {});
    api.getPref(SAMPLE_PREF).then((v) => setSample(v ?? null)).catch(() => {});
    const onStart = () => { setOffer(false); setAt(0); api.setPref(OFFER_PREF, true).catch(() => {}); };
    window.addEventListener('noteapp:tour', onStart);
    return () => window.removeEventListener('noteapp:tour', onStart);
  }, []);
  useEffect(() => { step?.go?.(); }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = useCallback(() => setAt(null), []);
  const [blocked, setBlocked] = useState(true);
  useEffect(() => {
    if (!offer) return undefined;
    const check = () => setBlocked(!!document.querySelector('.whatsnew-card, .modal-backdrop'));
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [offer]);
  useEffect(() => {
    if (at == null) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') end();
      else if (e.key === 'ArrowRight' && at < STEPS.length - 1) setAt(at + 1);
      else if (e.key === 'ArrowLeft' && at > 0) setAt(at - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, end]);

  const dismissOffer = () => { setOffer(false); api.setPref(OFFER_PREF, true).catch(() => {}); };
  const make = async () => {
    try {
      const id = await makeSample();
      setSample(id);
      dialog.toast('Made a sample word study: it’s on Desk → Study. Delete it from here, or from Settings → About.');
    } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const remove = async () => { await deleteSample(); setSample(null); dialog.toast('Sample word study deleted'); };

  // The offer waits while What's New or a dialog is up, so they don't pile up in the corner.
  if (offer && at == null && !blocked) {
    return (
      <div className="tour-offer" role="dialog" aria-label="Take the tour">
        <Icon name="flag" size={18} />
        <div className="tour-offer-text"><strong>New: Desk, tabs like a browser’s, and more</strong><span className="muted">A two-minute tour shows what’s where.</span></div>
        <button type="button" className="btn btn-primary btn-small" onClick={startTour}>Take the tour</button>
        <button type="button" className="btn btn-small" onClick={dismissOffer}>Not now</button>
      </div>
    );
  }
  if (!step) return null;

  // The card sits beside the lit-up part (below it, or to its side), or in the middle without one.
  const W = 360;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let pos = { left: Math.max(16, (vw - W) / 2), top: Math.max(16, vh / 2 - 120) };
  if (rect) {
    if (step.side === 'right' && rect.left + rect.width + W + 24 < vw) pos = { left: rect.left + rect.width + 16, top: Math.min(Math.max(16, rect.top + 40), vh - 280) };
    else if (step.side === 'left' && rect.left - W - 16 > 0) pos = { left: rect.left - W - 16, top: Math.min(Math.max(16, rect.top), vh - 280) };
    else {
      const below = rect.top + rect.height + 12;
      pos = { left: Math.min(Math.max(16, rect.left), vw - W - 16), top: below + 260 < vh ? below : Math.max(16, rect.top - 272) };
    }
  }
  const pad = 6;
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Tour">
      {rect
        ? <div className="tour-spot" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
        : <div className="tour-shade" />}
      <div className="tour-card" ref={card} style={{ ...pos, width: Math.min(W, vw - 32) }}>
        <p className="tour-count muted">{at + 1} of {STEPS.length}</p>
        <h2>{step.title}</h2>
        <p>{step.text}</p>
        {step.sample && (sample
          ? <p className="tour-sample"><Icon name="checkCircle" size={14} /> Sample made. <button type="button" className="link-btn" onClick={remove}>Delete it</button></p>
          : <button type="button" className="btn btn-small tour-sample-btn" onClick={make}><Icon name="plus" size={13} /> Make a sample word study</button>)}
        {step.final && sample && <p className="tour-sample">You made a sample word study. <button type="button" className="link-btn" onClick={remove}>Delete it</button> or keep it to look around in.</p>}
        <div className="tour-foot">
          {!step.final && <button type="button" className="link-btn" onClick={end}>Skip</button>}
          <span className="tour-grow" />
          {at > 0 && <button type="button" className="btn btn-small" onClick={() => setAt(at - 1)}>Back</button>}
          {step.final
            ? <button type="button" className="btn btn-primary btn-small" onClick={end}>Done</button>
            : <button type="button" className="btn btn-primary btn-small" onClick={() => setAt(at + 1)}>Next</button>}
        </div>
      </div>
    </div>
  );
}
