import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import { api } from '../api.js';
import { ART, FONT_PAIRS, THEMES } from '../../../shared/slideThemes.js';
import { artSvg } from '../slideArt.js';
import { brandChanged, loadBrand, useBrand } from '../slideLook.js';
import { SlideView } from './SlideView.jsx';

/**
 * Slide media (11.0): the church brand (its colors, logo and fonts make the Church brand theme), your own pictures
 * for slides and backgrounds (kept in Selah, not in a note), and the built-in background art. The Media page under
 * Utility shows all three; the slide editor uses the pickers.
 */

const SAMPLE = { id: 'sample', type: 'title', title: 'Grace Upon Grace', text: 'John 1:14-18' };
const SAMPLE_POINT = { id: 'sample2', type: 'point', title: 'He Dwelt Among Us', text: '', points: [{ text: 'Full of grace', level: 0 }, { text: 'Full of truth', level: 0 }] };

/** The media library's pictures: { list, reload, upload(file) }. */
export function useMedia() {
  const [list, setList] = useState(null);
  const reload = () => api.slideMedia().then(setList).catch(() => setList([]));
  useEffect(() => { reload(); }, []);
  const upload = async (file) => {
    const m = await api.uploadSlideMedia(file);
    setList((l) => [m, ...(l ?? [])]);
    return m;
  };
  return { list, reload, upload, setList };
}

/** Pick a picture from the media library (or add one): `value` is an attachment id; onPick(id | null). */
export function MediaPicker({ value, onPick, media, extra = [], allowNone = false, noneLabel = 'None' }) {
  const dialog = useDialog();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const add = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { const m = await media.upload(file); onPick(m.attachment_id); } catch (err) { dialog.toast(err.message, 'error'); }
    setBusy(false);
  };
  const all = [...extra.map((a) => ({ id: `n${a.id}`, attachment_id: a.id, filename: a.filename })), ...(media.list ?? [])];
  return (
    <div className="sm-pics">
      {allowNone && <button type="button" className={`sm-pic sm-none ${!value ? 'is-active' : ''}`} onClick={() => onPick(null)}>{noneLabel}</button>}
      {all.map((m) => (
        <button key={m.id} type="button" className={`sm-pic ${value === m.attachment_id ? 'is-active' : ''}`} onClick={() => onPick(m.attachment_id)} title={m.filename}>
          <img src={`/api/files/${m.attachment_id}`} alt={m.filename} loading="lazy" />
        </button>
      ))}
      <button type="button" className="sm-pic sm-add" disabled={busy} onClick={() => input.current?.click()} title="Add a picture to the media library">
        <Icon name="upload" size={16} /><span>{busy ? 'Adding…' : 'Add'}</span>
      </button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden onChange={add} />
    </div>
  );
}

/** The built-in art as a grid in `color` on `bg`: onPick(id | null | undefined), where undefined is the theme's own. */
export function ArtPicker({ value, onPick, color, bg, themeDefault = null }) {
  const tiles = useMemo(() => ART.map((a) => ({ ...a, svg: artSvg(a.id, color) })), [color]);
  const themeArt = ART.find((a) => a.id === themeDefault);
  return (
    <div className="sm-arts" style={{ '--sm-bg': bg }}>
      <button type="button" className={`sm-art sm-art-label ${value === undefined ? 'is-active' : ''}`} onClick={() => onPick(undefined)} title={themeArt ? `The theme’s own: ${themeArt.name}` : 'The theme’s own (none)'}>
        <span>Theme’s</span>
      </button>
      <button type="button" className={`sm-art sm-art-label ${value === null || value === 'none' ? 'is-active' : ''}`} onClick={() => onPick(null)}><span>None</span></button>
      {tiles.map((a) => (
        <button key={a.id} type="button" className={`sm-art is-${a.kind} ${value === a.id ? 'is-active' : ''}`} onClick={() => onPick(a.id)} title={a.name} aria-label={a.name}>
          <span className="sm-art-svg" dangerouslySetInnerHTML={{ __html: a.svg }} />
        </button>
      ))}
    </div>
  );
}

const CORNERS = [['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']];

/** The church brand: name, colors, background, fonts, art and logo. Saves as you go. */
export function BrandDialog({ close }) {
  const dialog = useDialog();
  const brand = useBrand();
  const [b, setB] = useState(null);
  const logoInput = useRef(null);
  useEffect(() => { loadBrand(true).then((x) => setB({ primary: '#2f5d86', secondary: '#93613a', accent: '#d8a23a', base: 'light', fonts: 'modern', logoPos: 'tr', ...x })); }, []);
  const save = async (patch) => {
    const next = { ...b, ...patch };
    setB(next);
    try { brandChanged(await api.saveSlideBrand(patch)); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  // Colors and the name save a moment after you stop changing them.
  const timer = useRef(null);
  const saveSoon = (patch) => {
    setB((x) => ({ ...x, ...patch }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api.saveSlideBrand(patch).then(brandChanged).catch((e) => dialog.toast(e.message, 'error')), 400);
  };
  const logo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try { const r = await api.uploadBrandLogo(file); setB((x) => ({ ...x, logo: r.logo })); brandChanged(r); } catch (err) { dialog.toast(err.message, 'error'); }
  };
  const dropLogo = async () => {
    try { const r = await api.removeBrandLogo(); setB((x) => ({ ...x, logo: null })); brandChanged(r); } catch (err) { dialog.toast(err.message, 'error'); }
  };
  if (!b) return <div className="sm-brand"><p className="muted">Loading…</p></div>;
  const deck = { theme: 'brand' };
  return (
    <div className="sm-brand">
      <div className="dialog-header">
        <h2>Church brand</h2>
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="muted">Your church’s colors, logo and fonts, as a theme any deck can use (Design → Church brand).</p>
      <div className="sm-brand-grid">
        <div className="sm-brand-fields">
          <label className="field">Church name
            <input className="input" value={b.name ?? ''} placeholder="Cedar Hollow Bible Church" onChange={(e) => saveSoon({ name: e.target.value })} />
          </label>
          <div className="sm-colors">
            {[['primary', 'Main color'], ['secondary', 'Second color'], ['accent', 'Highlight']].map(([k, l]) => (
              <label key={k} className="sm-color">
                <input type="color" value={b[k] ?? '#888888'} onChange={(e) => saveSoon({ [k]: e.target.value })} />
                <span>{l}</span>
              </label>
            ))}
          </div>
          <div className="field">Background
            <div className="segmented" role="radiogroup" aria-label="Background">
              {[['light', 'Light'], ['dark', 'Dark'], ['color', 'Main color']].map(([k, l]) => (
                <button key={k} type="button" role="radio" aria-checked={b.base === k} className={b.base === k ? 'is-active' : ''} onClick={() => save({ base: k })}>{l}</button>
              ))}
            </div>
          </div>
          <label className="field">Fonts
            <select className="input" value={b.fonts ?? 'modern'} onChange={(e) => save({ fonts: e.target.value })}>
              {FONT_PAIRS.map((f) => <option key={f.id} value={f.id}>{f.name}: {f.head.family} and {f.body.family}</option>)}
            </select>
          </label>
          <div className="field">Logo
            <div className="sm-logo-row">
              {b.logo ? <img className="sm-logo" src={`/api/files/${b.logo}`} alt="Logo" /> : <span className="muted">No logo yet</span>}
              <button type="button" className="btn btn-small" onClick={() => logoInput.current?.click()}><Icon name="upload" size={13} /> {b.logo ? 'Replace' : 'Upload'}</button>
              {b.logo && <button type="button" className="link-btn" onClick={dropLogo}>Remove</button>}
              <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={logo} />
            </div>
            {b.logo && (
              <select className="input sm-corner" value={b.logoPos ?? 'tr'} onChange={(e) => save({ logoPos: e.target.value })} aria-label="Logo corner">
                {CORNERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            )}
            <span className="muted sm-hint">A PNG or SVG with a see-through background looks best.</span>
          </div>
        </div>
        <div className="sm-brand-preview">
          <SlideView slide={SAMPLE} deck={{ ...deck, art: b.art ?? null }} className="is-preview" />
          <SlideView slide={SAMPLE_POINT} deck={{ ...deck, art: b.art ?? null }} all className="is-thumb" />
          <p className="muted sm-hint">{brand.name || b.name ? `${b.name || brand.name}` : 'Your church'} · {FONT_PAIRS.find((f) => f.id === (b.fonts ?? 'modern'))?.name} fonts</p>
        </div>
      </div>
      <div className="field">Background art
        <ArtPicker value={b.art ?? null} onPick={(v) => save({ art: v ?? null })} color={b.base === 'color' ? '#ffffff' : b.secondary ?? '#888'} bg={b.base === 'dark' ? '#171b22' : b.base === 'color' ? b.primary : '#ffffff'} />
      </div>
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => close(true)}>Done</button></div>
    </div>
  );
}

/** Utility → Media: the church brand, your pictures and the built-in art. */
export default function MediaPage({ onMenu }) {
  const dialog = useDialog();
  const media = useMedia();
  const brand = useBrand();
  const [themeId, setThemeId] = useState('light');
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const remove = async (m) => {
    if (!(await dialog.confirm({ title: 'Delete this picture?', message: `“${m.filename}” leaves the media library and any slide that shows it.`, okLabel: 'Delete', danger: true }))) return;
    try { await api.deleteSlideMedia(m.id); media.setList((l) => l.filter((x) => x.id !== m.id)); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  const input = useRef(null);
  const add = async (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    for (const f of files) {
      try { await media.upload(f); } catch (err) { dialog.toast(`${f.name}: ${err.message}`, 'error'); }
    }
  };
  return (
    <div className="page sm-page">
      <header className="page-header">
        <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Open sidebar"><Icon name="menu" /></button>
        <div className="page-heading">
          <h1>Media</h1>
          <p className="muted">Your church brand, pictures for slides and backgrounds, and Selah’s background art.</p>
        </div>
      </header>

      <section className="sm-section">
        <div className="sm-section-head">
          <h2>Church brand</h2>
          <button type="button" className="btn" onClick={() => dialog.open((c) => <BrandDialog close={c} />)}>{brand.primary ? 'Edit…' : 'Set up…'}</button>
        </div>
        {brand.primary ? (
          <div className="sm-brand-card">
            <SlideView slide={SAMPLE} deck={{ theme: 'brand', art: brand.art ?? null }} className="is-thumb" />
            <div>
              <strong>{brand.name || 'Your church'}</strong>
              <span className="sm-swatches">{['primary', 'secondary', 'accent'].map((k) => brand[k] && <i key={k} style={{ background: brand[k] }} title={brand[k]} />)}</span>
              <span className="muted">{FONT_PAIRS.find((f) => f.id === brand.fonts)?.name ?? 'Modern'} fonts{brand.logo ? ' · logo' : ''}</span>
            </div>
          </div>
        ) : <p className="muted">Set your church’s colors, logo and fonts once; every deck can then use the Church brand theme.</p>}
      </section>

      <section className="sm-section">
        <div className="sm-section-head">
          <h2>My pictures</h2>
          <button type="button" className="btn" onClick={() => input.current?.click()}><Icon name="upload" size={14} /> Add pictures</button>
          <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden onChange={add} />
        </div>
        {media.list?.length ? (
          <ul className="sm-grid">
            {media.list.map((m) => (
              <li key={m.id} className="sm-card">
                <img src={`/api/files/${m.attachment_id}`} alt={m.filename} loading="lazy" />
                <span className="sm-card-name" title={m.filename}>{m.filename}</span>
                <button type="button" className="icon-btn" onClick={() => remove(m)} aria-label={`Delete ${m.filename}`}><Icon name="trash" size={14} /></button>
              </li>
            ))}
          </ul>
        ) : <p className="muted">{media.list ? 'Pictures you add here can go on any slide or behind a whole deck.' : 'Loading…'}</p>}
      </section>

      <section className="sm-section">
        <div className="sm-section-head">
          <h2>Background art</h2>
          <select className="input sm-theme-pick" value={themeId} onChange={(e) => setThemeId(e.target.value)} aria-label="Show in theme">
            {THEMES.map((t) => <option key={t.id} value={t.id}>In {t.name}</option>)}
          </select>
        </div>
        <p className="muted">Line drawings sit faintly beside the text; textures cover the slide. Each takes the theme’s colors. Pick one in a deck’s Design panel.</p>
        <ul className="sm-grid sm-art-grid">
          {ART.map((a) => (
            <li key={a.id} className="sm-card">
              <SlideView slide={{ id: a.id, type: 'title', title: a.name, text: a.kind === 'line' ? 'Line drawing' : 'Texture' }} deck={{ theme: theme.id, art: a.id }} className="is-thumb" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
