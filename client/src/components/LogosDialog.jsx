import { useState } from 'react';
import { logosLink, parse } from '../../../shared/scripture.js';
import { DEFAULT_BIBLE, bibleFromLink, logosBible, logosMode, openPassage, setLogosBible, setLogosMode } from '../logos.js';

/** Add a named link to a place in a Logos book (a commentary, lexicon…). Resolves to { url, text } or null. */
export default function LogosLinkDialog({ close }) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const link = logosLink(url);
  const submit = (e) => {
    e.preventDefault();
    if (link) close({ url: link.url, text: text.trim() || link.label });
  };
  return (
    <form className="stack-form logos-dialog" onSubmit={submit}>
      <h2>Link to Logos</h2>
      <p className="modal-message">
        In Logos, open the book at the place you want, then use the panel menu’s <strong>Copy location as → URL</strong>
        (in newer versions it’s under <strong>Share</strong>) and paste it here.
      </p>
      <label className="field-label" htmlFor="logos-url">Logos link</label>
      <input id="logos-url" className="input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)}
        placeholder="https://ref.ly/logosres/…" spellCheck={false} />
      {url.trim() && !link && <p className="form-error">That isn’t a Logos link (it should start with https://ref.ly/ or logosres:).</p>}
      <label className="field-label" htmlFor="logos-text">Show it as</label>
      <input id="logos-text" className="input" value={text} onChange={(e) => setText(e.target.value)}
        placeholder={link?.label ?? 'e.g. Moo, Romans (NICNT) on 8:28'} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!link}>Insert link</button>
      </div>
    </form>
  );
}

/** Settings → Logos (this device): open links in the desktop app or on the web, and the Bible passages open in. */
export function LogosSettingsDialog({ close }) {
  const [mode, setMode] = useState(logosMode());
  const [bible, setBible] = useState(logosBible());
  const [link, setLink] = useState('');
  const learned = bibleFromLink(link);
  const pickMode = (m) => { setMode(m); setLogosMode(m); };
  const useBible = (b) => { setBible(b); setLogosBible(b); setLink(''); };
  return (
    <div className="stack-form logos-dialog">
      <h2>Logos</h2>
      <p className="muted">Bible references and Logos links in notes open in Logos. This setting is for this device only.</p>
      <div className="choice-list" role="radiogroup" aria-label="Open Logos links in">
        <label className={`choice ${mode === 'desktop' ? 'is-active' : ''}`}>
          <input type="radio" checked={mode === 'desktop'} onChange={() => pickMode('desktop')} />
          <span><strong>Logos desktop app</strong><br /><span className="muted">Opens straight in Logos on this computer. The browser
            may ask the first time; tick “Always allow”.</span></span>
        </label>
        <label className={`choice ${mode === 'web' ? 'is-active' : ''}`}>
          <input type="radio" checked={mode === 'web'} onChange={() => pickMode('web')} />
          <span><strong>Logos website / mobile app</strong><br /><span className="muted">Through ref.ly; use this on phones or
            where Logos isn’t installed.</span></span>
        </label>
      </div>
      {mode === 'desktop' && (
        <>
          <label className="field-label" htmlFor="logos-bible">Bible for passages: <strong>{bible.name}</strong></label>
          <p className="muted logos-bible-help">To use another Bible, open it in Logos, copy a link to any verse (<strong>Copy location
            as → URL</strong>, or <strong>Share → Copy link</strong>) and paste it here.</p>
          <input id="logos-bible" className="input" value={link} onChange={(e) => setLink(e.target.value)}
            placeholder="https://ref.ly/logosres/…?ref=Bible….Jn3.16" spellCheck={false} />
          {link.trim() && !learned && <p className="form-error">That link doesn’t name a Bible (it needs “ref=Bible…”).</p>}
          <div className="logos-bible-actions">
            {learned && <button type="button" className="btn btn-small btn-primary" onClick={() => useBible(learned)}>Use {learned.name}</button>}
            {bible.id !== DEFAULT_BIBLE.id && <button type="button" className="btn btn-small" onClick={() => useBible(DEFAULT_BIBLE)}>Back to ESV</button>}
          </div>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => openPassage(parse('John 3:16').refs[0])}>Test: open John 3:16</button>
        <button type="button" className="btn btn-primary" onClick={() => close()}>Done</button>
      </div>
    </div>
  );
}
