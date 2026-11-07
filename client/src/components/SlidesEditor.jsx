import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { Menu, useDialog } from './Dialogs.jsx';
import {
  SLIDE_TYPES, anchorChoices, blankSlide, deckKind, dismissKey, insertMade, keepSlide, newDeck, outlineSlides, passageKey, reconcile, slideId, typeLabel, updateSlide,
} from '../slides.js';
import { SlideView, deckSaved, openSlidesWindow, usePassages } from './SlideView.jsx';
import { deckSource, presentNote } from './PresentMode.jsx';
import { useBible } from './TranslationPicker.jsx';
import { ART, FONT_PAIRS, THEMES, namedPalette } from '../../../shared/slideThemes.js';
import { deckLook, useBrand } from '../slideLook.js';
import { ArtPicker, BrandDialog, MediaPicker, useMedia } from './SlideMedia.jsx';

/**
 * The Slides tab of the sermon and lesson builders (and Slides… on a note). 11.0: the slides down the left, the one
 * you're on large in the middle, and a panel on the right: Slide (its words, picture, passage and where it comes
 * up) and Design (theme, colors, fonts, background art or picture, translation, the church logo). Outline shows every
 * slide's words in one list to type through. A new deck starts from the note's outline; after that, when the outline
 * changes, the slides it touches are flagged with Update or Keep mine, and new points are offered as new slides.
 * Changes save by themselves.
 *
 * `source` is the note as the builder has it now ({ title, html, passage }), saved or not.
 */
const pointsText = (points) => (points ?? []).map((p) => `${'  '.repeat(p.level)}${p.text}`).join('\n');
function textPoints(text, old = []) {
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    const lead = /^(\s*)/.exec(l.replace(/\t/g, '  '))[1].length;
    const t = l.trim().replace(/^[-•]\s+/, '');
    return { text: t, level: Math.min(3, Math.floor(lead / 2)), anchor: old.find((p) => p.text === t)?.anchor ?? '' };
  });
}
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(`noteapp.slides.${k}`)) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`noteapp.slides.${k}`, JSON.stringify(v)); } catch { /* private window */ } };

export default function SlidesEditor({ noteId, kind, source, onPresent }) {
  const dialog = useDialog();
  const [deck, setDeck] = useState(null);
  const [sel, setSel] = useState(null);
  const [saving, setSaving] = useState('');
  const [images, setImages] = useState([]);
  const [drag, setDrag] = useState(null);
  const [view, setView] = useState(() => pref('view', 'canvas'));
  const [panel, setPanel] = useState(() => pref('panel', 'slide'));
  const pending = useRef(null);
  const timer = useRef(null);
  const passages = usePassages(deck?.slides, deck?.translation);
  const bible = useBible();
  const brand = useBrand();
  const media = useMedia();
  useEffect(() => setPref('view', view), [view]);
  useEffect(() => setPref('panel', panel), [panel]);

  // ---------- loading and saving ----------
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const d = pending.current;
    if (!d) return;
    pending.current = null;
    setSaving('Saving…');
    try {
      await api.saveSlides(noteId, d);
      deckSaved(noteId);
      setSaving('Saved');
    } catch (e) {
      setSaving('');
      dialog.toast(e.message, 'error');
    }
  }, [noteId, dialog]);
  const change = useCallback((fn) => {
    setDeck((d) => {
      const next = fn(d);
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 700);
      return next;
    });
  }, [flush]);
  useEffect(() => () => { flush(); }, [flush]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [r, note] = await Promise.all([api.slides(noteId), api.getNote(noteId)]);
        if (!live) return;
        setImages((note.attachments ?? []).filter((a) => a.mime.startsWith('image/')));
        let d = r.deck;
        if (!d) {
          d = newDeck(kind, source);
          await api.saveSlides(noteId, d);
          deckSaved(noteId);
        }
        setDeck(d);
        setSel(d.slides[0]?.id ?? null);
      } catch (e) {
        dialog.toast(e.message, 'error');
      }
    })();
    return () => { live = false; };
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const made = useMemo(() => outlineSlides(deck?.kind ?? kind, source), [deck?.kind, kind, source]);
  const rec = useMemo(() => (deck ? reconcile(deck, made) : { changed: {}, gone: [], fresh: [] }), [deck, made]);
  const choices = useMemo(() => anchorChoices(source.html), [source.html]);

  // Keys: ↑ ↓ (or PageUp/PageDown) move between slides in the canvas when you aren't typing.
  const selRef = useRef(null);
  selRef.current = { slides: deck?.slides ?? [], sel };
  useEffect(() => {
    const onKey = (e) => {
      if (view !== 'canvas' || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const { slides: all, sel: cur } = selRef.current;
      const at = all.findIndex((x) => x.id === cur);
      if (['ArrowDown', 'PageDown'].includes(e.key) && at < all.length - 1) { e.preventDefault(); setSel(all[at + 1].id); }
      if (['ArrowUp', 'PageUp'].includes(e.key) && at > 0) { e.preventDefault(); setSel(all[at - 1].id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  if (!deck) return <div className="se se-loading"><p className="muted">Opening the slides…</p></div>;
  const slides = deck.slides;
  const i = Math.max(0, slides.findIndex((s) => s.id === sel));
  const s = slides[i];
  const setSlide = (id, patch) => change((d) => ({ ...d, slides: d.slides.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const set = (patch) => setSlide(s.id, patch);
  const setD = (patch) => change((d) => {
    const next = { ...d, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    return next;
  });
  const setSlides = (fn) => change((d) => ({ ...d, slides: fn(d.slides) }));
  const add = (type, after = i) => {
    const n = blankSlide(type);
    setSlides((all) => [...all.slice(0, after + 1), n, ...all.slice(after + 1)]);
    setSel(n.id);
  };
  const remove = (id) => {
    const at = slides.findIndex((x) => x.id === id);
    const gone = slides[at];
    setSlides((all) => all.filter((x) => x.id !== id));
    setSel(slides[at + 1]?.id ?? slides[at - 1]?.id ?? null);
    dialog.toast('Slide deleted', 'info', 6000, { label: 'Undo', onClick: () => { setSlides((all) => [...all.slice(0, at), gone, ...all.slice(at)]); setSel(gone.id); } });
  };
  const move = (from, to) => {
    if (to < 0 || to >= slides.length || from === to) return;
    setSlides((all) => { const a = [...all]; const [x] = a.splice(from, 1); a.splice(to, 0, x); return a; });
  };
  const duplicate = (at = i) => {
    const copy = { ...structuredClone(slides[at]), id: slideId(), src: undefined, gen: undefined, kept: undefined };
    setSlides((all) => [...all.slice(0, at + 1), copy, ...all.slice(at + 1)]);
    setSel(copy.id);
  };
  const addFresh = (list) => change((d) => {
    let out = d.slides;
    for (const g of list) out = insertMade(out, g, made);
    return { ...d, slides: out };
  });
  const updateAll = () => setSlides((all) => all.map((x) => (rec.changed[x.id] ? updateSlide(x, rec.changed[x.id]) : x)));
  const flagged = Object.keys(rec.changed).length + rec.gone.length;

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const a = await api.upload(noteId, file);
      setImages((list) => [...list, a]);
      set({ image: a.id });
    } catch (err) {
      dialog.toast(err.message, 'error');
    }
  };

  const present = async () => { await flush(); onPresent?.(); };
  const projector = async () => { await flush(); openSlidesWindow(noteId); };
  const toPowerPoint = async () => {
    await flush();
    setSaving('Making the PowerPoint…');
    try {
      const { exportPptx } = await import('../slidesPptx.js');
      const name = await exportPptx({ deck, passages, title: source.title || 'Slides', brand });
      setSaving('');
      dialog.toast(`Saved “${name}” to your downloads`);
    } catch (e) {
      setSaving('');
      dialog.toast(`Couldn’t make the PowerPoint: ${e.message}`, 'error');
    }
  };

  const look = deckLook(deck, brand);
  const anchorKnown = !s?.anchor || s.anchor === '^' || choices.some((c) => c.text === s.anchor);
  const favorite = bible.translations.find((t) => t.id === bible.tr);
  const trLabel = (id) => bible.translations.find((t) => t.id === id)?.label ?? id;
  const retype = (x, type) => ({ ...blankSlide(type), id: x.id, title: x.title, text: x.text, anchor: x.anchor, notes: x.notes, points: x.points, src: x.src, gen: x.gen, art: x.art, bg: x.bg, logo: x.logo });

  const thumbs = (
    <ol className="se-list" aria-label="Slides">
      {slides.map((x, j) => (
        <li key={x.id} className={`se-item ${x.id === s?.id ? 'is-active' : ''} ${drag?.over === j ? `is-drop-${drag.pos}` : ''}`}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
            if (drag.over !== j || drag.pos !== pos) setDrag({ ...drag, over: j, pos });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (!drag) return;
            const to = drag.pos === 'before' ? j : j + 1;
            move(drag.from, to > drag.from ? to - 1 : to);
            setDrag(null);
          }}
          onDragEnd={() => setDrag(null)}
          onContextMenu={(e) => dialog.contextMenu(e, [
            j > 0 && { label: 'Move up', onClick: () => move(j, j - 1) },
            j < slides.length - 1 && { label: 'Move down', onClick: () => move(j, j + 1) },
            { label: 'Duplicate', onClick: () => duplicate(j) },
            'sep',
            { label: 'Delete', danger: true, onClick: () => remove(x.id) },
          ])}>
          <button type="button" className="se-thumb-btn" onClick={() => setSel(x.id)} aria-current={x.id === s?.id ? 'true' : undefined}
            draggable onDragStart={(e) => { setDrag({ from: j }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', x.id); }}>
            <span className="se-n">{j + 1}</span>
            <SlideView slide={x} deck={deck} passages={passages} all className="is-thumb" />
            <span className="se-item-label">
              <span className="se-type">{typeLabel[x.type]}</span>
              {rec.changed[x.id] && <span className="se-flag" title="The note changed">Note changed</span>}
              {rec.gone.includes(x.id) && <span className="se-flag is-gone" title="This part isn’t in the note anymore">Not in the note</span>}
              {x.anchor && <Icon name="bookmark" size={11} />}
            </span>
          </button>
        </li>
      ))}
      {!slides.length && <li className="muted se-empty">No slides. Add one above.</li>}
    </ol>
  );

  const flags = s && (
    <>
      {rec.changed[s.id] && (
        <div className="se-flagbox">
          <p><Icon name="alert" size={14} /> The note has changed here. It now makes: <strong>{rec.changed[s.id].title || rec.changed[s.id].text || rec.changed[s.id].ref}</strong>
            {rec.changed[s.id].points?.length ? ` (${rec.changed[s.id].points.length} sub-points)` : ''}</p>
          <span>
            <button type="button" className="btn btn-small btn-primary" onClick={() => set(updateSlide(s, rec.changed[s.id]))}>Update from the note</button>
            <button type="button" className="btn btn-small" onClick={() => set(keepSlide(s, rec.changed[s.id]))}>Keep mine</button>
          </span>
        </div>
      )}
      {rec.gone.includes(s.id) && (
        <div className="se-flagbox">
          <p><Icon name="alert" size={14} /> This part isn’t in the note anymore.</p>
          <span>
            <button type="button" className="btn btn-small" onClick={() => remove(s.id)}>Delete the slide</button>
            <button type="button" className="btn btn-small" onClick={() => set(keepSlide(s, null))}>Keep it</button>
          </span>
        </div>
      )}
    </>
  );

  const slidePanel = s ? (
    <div className="se-fields">
      <div className="se-row">
        <label className="se-field se-type-field">Type
          <select className="input" value={s.type} onChange={(e) => set(retype(s, e.target.value))}>
            {SLIDE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <span className="se-actions">
          <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move up"><Icon name="arrowUp" size={15} /></button>
          <button type="button" className="icon-btn" disabled={i === slides.length - 1} onClick={() => move(i, i + 1)} aria-label="Move down"><Icon name="arrowDown" size={15} /></button>
          <button type="button" className="icon-btn" onClick={() => duplicate()} aria-label="Duplicate" title="Duplicate"><Icon name="copy" size={15} /></button>
          <button type="button" className="icon-btn" onClick={() => remove(s.id)} aria-label="Delete the slide" title="Delete"><Icon name="trash" size={15} /></button>
        </span>
      </div>
      {s.type === 'passage' && (
        <div className="se-row se-passage">
          <label className="se-field">Passage
            <input className="input" value={s.ref ?? ''} onChange={(e) => set({ ref: e.target.value })} placeholder="John 3:16-21" />
          </label>
          {bible.translations.length > 1 && (
            <label className="se-field se-tr">Translation
              <select className="input" value={s.tr ?? ''} onChange={(e) => set({ tr: e.target.value || undefined })}>
                <option value="">The deck’s ({deck.translation ? trLabel(deck.translation) : favorite?.label ?? 'favorite'})</option>
                {bible.translations.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {s.type === 'passage' && s.ref?.trim() && !passages[passageKey(s, deck)] && (
        <span className="muted se-hint">The text shows when a Bible is connected (Settings → Connections → Bible); long passages run over several pages.</span>
      )}
      <label className="se-field">{s.type === 'question' ? 'Question' : s.type === 'image' ? 'Caption' : s.type === 'passage' ? 'Heading (optional)' : 'Title'}
        <input className="input" value={s.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
      </label>
      {s.type === 'image' && (
        <div className="se-field">Picture
          <MediaPicker value={s.image} onPick={(id) => set({ image: id })} media={media} extra={images} />
          <label className="se-image-note"><Icon name="paperclip" size={13} /> <span className="link-btn">Or attach one to the note</span><input type="file" accept="image/*" onChange={upload} hidden /></label>
          <span className="se-inline">
            <label><input type="radio" checked={s.fit !== 'cover'} onChange={() => set({ fit: 'contain' })} /> Whole picture</label>
            <label><input type="radio" checked={s.fit === 'cover'} onChange={() => set({ fit: 'cover' })} /> Fill the slide</label>
          </span>
        </div>
      )}
      {s.type !== 'image' && s.type !== 'passage' && (
        <label className="se-field">{s.type === 'title' ? 'Subtitle' : 'Text'}
          <textarea className="input" rows={s.type === 'custom' ? 6 : 3} value={s.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
          <span className="muted se-hint">**bold**, *italics*, and “- ” at the start of a line for a bullet.</span>
        </label>
      )}
      {s.type === 'point' && (
        <label className="se-field">Points, one at a time
          <textarea className="input" rows={4} value={pointsText(s.points)} onChange={(e) => set({ points: textPoints(e.target.value, s.points) })} placeholder={'First point\n  a sub-point (indent two spaces)\nSecond point'} />
        </label>
      )}
      {s.type === 'question' && (
        <label className="se-field">Answer (only on your screen)
          <textarea className="input" rows={3} value={s.answer ?? ''} onChange={(e) => set({ answer: e.target.value })} />
        </label>
      )}
      <label className="se-field">Comes up when I reach
        <select className="input" value={s.anchor ?? ''} onChange={(e) => set({ anchor: e.target.value })}>
          <option value="">Only when I press Next</option>
          <option value="^">The start</option>
          {!anchorKnown && <option value={s.anchor}>{s.anchor.slice(0, 70)} (not found in the note)</option>}
          {choices.map((c) => <option key={c.text} value={c.text}>{c.tag === 'h1' ? '§ ' : c.tag === 'h2' ? '› ' : c.tag === 'li' ? '• ' : ''}{c.label}</option>)}
        </select>
        <span className="muted se-hint">While you preach or teach, reaching this place in the note puts the slide up.</span>
      </label>
      <label className="se-field">Notes for you
        <textarea className="input" rows={2} value={s.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} placeholder="Shown on your screen while presenting, never on the slide" />
      </label>
      {s.type !== 'image' && (
        <details className="se-more" open={!!(s.art || s.bg)}>
          <summary>This slide’s background</summary>
          <label className="se-field">Art
            <select className="input" value={s.art ?? ''} onChange={(e) => set({ art: e.target.value || undefined })}>
              <option value="">The deck’s{look.art ? ` (${ART.find((a) => a.id === look.art)?.name})` : ' (none)'}</option>
              <option value="none">None on this slide</option>
              <optgroup label="Line drawings">{ART.filter((a) => a.kind === 'line').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>
              <optgroup label="Textures">{ART.filter((a) => a.kind === 'texture').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>
            </select>
          </label>
          <div className="se-field">Picture behind it
            <MediaPicker value={s.bg ?? null} onPick={(id) => set({ bg: id ?? undefined })} media={media} allowNone noneLabel={deck.bg ? 'The deck’s' : 'None'} />
          </div>
          {deck.theme === 'brand' && brand.logo && (
            <label className="se-check"><input type="checkbox" checked={s.logo !== false} onChange={(e) => set({ logo: e.target.checked ? undefined : false })} /> Church logo on this slide</label>
          )}
        </details>
      )}
    </div>
  ) : <p className="muted">Add a slide to start.</p>;

  const themes = [...THEMES.map((t) => ({ id: t.id, name: t.name })), { id: 'brand', name: brand.name || 'Church brand' }];
  const sample = s ?? { id: 'x', type: 'title', title: source.title || 'Title' };
  const pickTheme = async (id) => {
    if (id === 'brand' && !brand.primary) await dialog.open((c) => <BrandDialog close={c} />);
    setD({ theme: id, colors: undefined, custom: undefined, fonts: undefined, art: undefined });
  };
  const pickColors = async (id) => {
    if (id === 'brand' && !brand.primary) await dialog.open((c) => <BrandDialog close={c} />);
    if (id === 'custom') {
      const p = look.palette;
      setD({ colors: 'custom', custom: deck.custom ?? { bg: p.bg, text: p.text, accent: p.accent } });
    } else setD({ colors: id, custom: undefined });
  };
  const themeName = themes.find((t) => t.id === deck.theme)?.name ?? 'Theme';
  const colorSets = [{ id: undefined, name: `The theme’s (${themeName})` }, ...themes.filter((t) => t.id !== deck.theme), { id: 'custom', name: 'Your own' }];
  const swatch = (p) => (
    <span className="se-swatch" style={{ background: `linear-gradient(${p.bg}, ${p.bg2})` }}>
      <i style={{ background: p.head }} /><i style={{ background: p.text }} /><i style={{ background: p.accent }} />
    </span>
  );
  const designPanel = (
    <div className="se-fields se-design">
      <div className="se-field">Theme
        <div className="se-themes">
          {themes.map((t) => (
            <button key={t.id} type="button" className={`se-theme ${deck.theme === t.id ? 'is-active' : ''}`} onClick={() => pickTheme(t.id)}>
              <SlideView slide={sample} deck={{ theme: t.id }} passages={passages} all className="is-thumb" />
              <span>{t.name}</span>
            </button>
          ))}
        </div>
        <button type="button" className="link-btn se-brand-link" onClick={() => dialog.open((c) => <BrandDialog close={c} />)}><Icon name="settings" size={12} /> {brand.primary ? 'Edit the church brand…' : 'Set up your church brand…'}</button>
      </div>
      <div className="se-field">Colors
        <div className="se-colors">
          {colorSets.map((c) => {
            const on = (deck.colors ?? undefined) === c.id;
            const p = c.id === undefined ? namedPalette(deck.theme, brand) : namedPalette(c.id, brand, c.id === 'custom' ? (deck.custom ?? look.palette) : null);
            return (
              <button key={c.id ?? 'theme'} type="button" className={`se-color ${on ? 'is-active' : ''}`} onClick={() => (c.id === undefined ? setD({ colors: undefined, custom: undefined }) : pickColors(c.id))} title={c.name}>
                {swatch(p)}<span>{c.name}</span>
              </button>
            );
          })}
        </div>
        {deck.colors === 'custom' && (
          <div className="se-custom">
            {[['bg', 'Background'], ['text', 'Text'], ['accent', 'Accent']].map(([k, l]) => (
              <label key={k}><input type="color" value={look.palette[k]} onChange={(e) => setD({ custom: { ...deck.custom, [k]: e.target.value } })} /> {l}</label>
            ))}
          </div>
        )}
      </div>
      <label className="se-field">Fonts
        <select className="input" value={deck.fonts ?? ''} onChange={(e) => setD({ fonts: e.target.value || undefined })}>
          <option value="">The theme’s ({look.fonts.name})</option>
          {FONT_PAIRS.map((f) => <option key={f.id} value={f.id}>{f.name}: {f.head.family} and {f.body.family}</option>)}
        </select>
      </label>
      <div className="se-field">Background art
        <ArtPicker value={deck.art} onPick={(v) => setD({ art: v })} color={look.palette.art} bg={look.palette.bg}
          themeDefault={deck.theme === 'brand' ? brand.art : THEMES.find((t) => t.id === deck.theme)?.art} />
      </div>
      <div className="se-field">Picture behind every slide
        <MediaPicker value={deck.bg ?? null} onPick={(id) => setD(id ? { bg: id, dim: deck.dim ?? 0.45 } : { bg: undefined, dim: undefined })} media={media} allowNone />
        {deck.bg && (
          <label className="se-dim">Darken it
            <input type="range" min="0" max="0.85" step="0.05" value={deck.dim ?? 0.45} onChange={(e) => setD({ dim: Number(e.target.value) })} />
          </label>
        )}
      </div>
      <label className="se-field">Translation
        <select className="input" value={deck.translation ?? ''} onChange={(e) => setD({ translation: e.target.value })} disabled={!bible.translations.length}>
          <option value="">Your favorite{favorite ? ` (${favorite.label})` : ''}</option>
          {bible.translations.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <span className="muted se-hint">{bible.translations.length ? 'For every passage slide; a slide can pick its own.' : 'Connect a Bible in Settings → Connections to show passage text.'}</span>
      </label>
      {deck.theme === 'brand' && brand.logo && (
        <label className="se-check"><input type="checkbox" checked={deck.logo !== false} onChange={(e) => setD({ logo: e.target.checked })} /> Church logo on the slides</label>
      )}
    </div>
  );

  const outline = (
    <ol className="se-outline">
      {slides.map((x, j) => (
        <li key={x.id} className={`se-o-row ${x.id === s?.id ? 'is-active' : ''}`} onFocus={() => setSel(x.id)}>
          <button type="button" className="se-o-thumb" onClick={() => { setSel(x.id); setView('canvas'); }} title="Open in the canvas">
            <span className="se-n">{j + 1}</span>
            <SlideView slide={x} deck={deck} passages={passages} all className="is-thumb" />
          </button>
          <div className="se-o-fields">
            <div className="se-o-head">
              <select className="input se-o-type" value={x.type} onChange={(e) => setSlide(x.id, retype(x, e.target.value))} aria-label="Type">
                {SLIDE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {x.type === 'passage'
                ? <input className="input se-o-title" value={x.ref ?? ''} onChange={(e) => setSlide(x.id, { ref: e.target.value })} placeholder="Passage, e.g. John 3:16-21" aria-label="Passage" />
                : <input className="input se-o-title" value={x.title ?? ''} onChange={(e) => setSlide(x.id, { title: e.target.value })} placeholder={x.type === 'question' ? 'Question' : 'Title'} aria-label="Title" />}
              <Menu align="right" trigger={({ toggle }) => <button type="button" className="icon-btn" onClick={toggle} aria-label="More"><Icon name="more" size={15} /></button>} items={[
                j > 0 && { label: 'Move up', onClick: () => move(j, j - 1) },
                j < slides.length - 1 && { label: 'Move down', onClick: () => move(j, j + 1) },
                { label: 'Add a slide after', onClick: () => add('point', j) },
                { label: 'Duplicate', onClick: () => duplicate(j) },
                'sep',
                { label: 'Delete', danger: true, onClick: () => remove(x.id) },
              ]} />
            </div>
            {['title', 'point', 'question', 'custom'].includes(x.type) && (
              <textarea className="input se-o-text" rows={Math.min(6, Math.max(1, (x.text ?? '').split('\n').length))} value={x.text ?? ''} onChange={(e) => setSlide(x.id, { text: e.target.value })}
                placeholder={x.type === 'title' ? 'Subtitle' : 'Text'} aria-label="Text" />
            )}
            {x.type === 'point' && (
              <textarea className="input se-o-text" rows={Math.min(8, Math.max(1, (x.points ?? []).length))} value={pointsText(x.points)} onChange={(e) => setSlide(x.id, { points: textPoints(e.target.value, x.points) })}
                placeholder="Points, one a line (indent two spaces for a sub-point)" aria-label="Points" />
            )}
          </div>
        </li>
      ))}
      <li className="se-o-add">
        <Menu align="left" trigger={({ toggle }) => <button type="button" className="btn btn-small" onClick={toggle}><Icon name="plus" size={14} /> Add a slide at the end</button>}
          items={SLIDE_TYPES.map(([k, l]) => ({ label: l, onClick: () => add(k, slides.length - 1) }))} />
      </li>
    </ol>
  );

  return (
    <div className="se">
      <div className="se-toolbar">
        <Menu align="left" trigger={({ toggle }) => <button type="button" className="btn btn-small" onClick={toggle}><Icon name="plus" size={14} /> Add slide</button>}
          items={SLIDE_TYPES.map(([k, l]) => ({ label: l, onClick: () => add(k) }))} />
        <div className="segmented" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === 'canvas'} className={view === 'canvas' ? 'is-active' : ''} onClick={() => setView('canvas')}><Icon name="monitor" size={13} /> Canvas</button>
          <button type="button" role="tab" aria-selected={view === 'outline'} className={view === 'outline' ? 'is-active' : ''} onClick={() => setView('outline')}><Icon name="list" size={13} /> Outline</button>
        </div>
        <span className="muted se-saving">{saving}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={toPowerPoint} title="Download the deck as a PowerPoint file (.pptx)"><Icon name="download" size={14} /> PowerPoint</button>
        <button type="button" className="btn btn-small" onClick={projector} title="The audience’s view, for the projector or TV"><Icon name="monitor" size={14} /> Slides window</button>
        {onPresent && <button type="button" className="btn btn-small btn-primary" onClick={present}><Icon name="play" size={14} /> Present</button>}
      </div>
      {(rec.fresh.length > 0 || flagged > 0) && (
        <div className="se-banner">
          <Icon name="refresh" size={14} />
          <span>
            {rec.fresh.length > 0 && <>{rec.fresh.length} new {rec.fresh.length === 1 ? 'part' : 'parts'} in the note: {rec.fresh.slice(0, 3).map((g) => `“${g.title || g.ref || g.text}”`).join(', ')}{rec.fresh.length > 3 ? '…' : ''}. </>}
            {flagged > 0 && <>{flagged} {flagged === 1 ? 'slide differs' : 'slides differ'} from the note now.</>}
          </span>
          {rec.fresh.length > 0 && <button type="button" className="btn btn-small" onClick={() => addFresh(rec.fresh)}>Add {rec.fresh.length === 1 ? 'it' : 'them'}</button>}
          {rec.fresh.length > 0 && <button type="button" className="link-btn" onClick={() => change((d) => ({ ...d, dismissed: [...(d.dismissed ?? []), ...rec.fresh.map(dismissKey)] }))}>Not {rec.fresh.length === 1 ? 'this one' : 'these'}</button>}
          {Object.keys(rec.changed).length > 1 && <button type="button" className="link-btn" onClick={updateAll}>Update all from the note</button>}
        </div>
      )}
      {view === 'outline' ? (
        <div className="se-outline-wrap">{outline}</div>
      ) : (
        <div className="se-main">
          {thumbs}
          <div className="se-stage">
            {s ? (
              <>
                <SlideView slide={s} deck={deck} passages={passages} all fit className="is-preview" />
                <div className="se-stage-nav">
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => setSel(slides[i - 1].id)} aria-label="Previous slide"><Icon name="chevronLeft" size={16} /></button>
                  <span className="muted">Slide {i + 1} of {slides.length} · {typeLabel[s.type]}</span>
                  <button type="button" className="icon-btn" disabled={i === slides.length - 1} onClick={() => setSel(slides[i + 1].id)} aria-label="Next slide"><Icon name="chevronRight" size={16} /></button>
                </div>
                {flags}
              </>
            ) : <p className="muted">No slides yet.</p>}
          </div>
          <aside className="se-panel">
            <div className="home-tabs is-sub se-panel-tabs" role="tablist" aria-label="Panel">
              <button type="button" role="tab" aria-selected={panel === 'slide'} className={panel === 'slide' ? 'is-active' : ''} onClick={() => setPanel('slide')}>Slide</button>
              <button type="button" role="tab" aria-selected={panel === 'design'} className={panel === 'design' ? 'is-active' : ''} onClick={() => setPanel('design')}>Design</button>
            </div>
            <div className="se-panel-body">{panel === 'design' ? designPanel : slidePanel}</div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** Slides… from a note's ⋯ menu: the editor in a dialog of its own. */
export function SlidesDialog({ note, kind, passage, close, onPresent }) {
  const source = useMemo(() => ({ title: note.title, html: note.html, passage }), [note, passage]);
  return (
    <div className="sb se-dialog">
      <header className="sb-header">
        <Icon name="present" size={20} />
        <div className="sb-title">
          <h2>Slides</h2>
          <span className="muted">{note.title || 'Untitled'}</span>
        </div>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </header>
      <SlidesEditor noteId={note.id} kind={kind} source={source} onPresent={onPresent ? () => { close(); onPresent(); } : null} />
    </div>
  );
}

/** Opens a lesson's or sermon's slides from its note. */
export async function openSlides(dialog, noteId) {
  try {
    const [note, sermon] = await Promise.all([api.getNote(noteId), api.noteSermon(noteId).catch(() => null)]);
    const kind = deckKind(note.html, { sermon }) ?? 'lesson';
    const { passage } = await deckSource(note, sermon);
    await dialog.open((close) => <SlidesDialog note={note} kind={kind} passage={passage} close={close} onPresent={() => presentNote(dialog, noteId)} />, { dismissable: false });
  } catch (e) {
    dialog.toast(e.message, 'error');
  }
}
