import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { bibleChanged } from '../esv.js';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';
import EsvDialog from './EsvDialog.jsx';
import { useBible } from './TranslationPicker.jsx';

/**
 * Settings → Connections → Bible: the translations Selah reads (the ESV, the NLT, and Bibles from API.Bible), each
 * with the user's own key, and the favorite used wherever a view hasn't picked its own.
 */
export function BibleSettings() {
  const dialog = useDialog();
  const bible = useBible();
  const [status, setStatus] = useState(null);
  const load = () => api.bibleStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    load();
    window.addEventListener('noteapp:bible-changed', load);
    return () => window.removeEventListener('noteapp:bible-changed', load);
  }, []);
  const p = status?.providers ?? {};
  const setFavorite = async (id) => {
    try {
      await api.setBibleFavorite(id);
      bibleChanged();
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const on = (yes) => (yes ? <span className="bible-on"><Icon name="check" size={13} /> Connected</span> : null);
  return (
    <>
      <h3>Bible</h3>
      <div className="about-row">
        <span className="muted">Verse text when you hover over a Bible reference, the passage beside builders and on the Scripture page, quotations in notes and passage slides.</span>
      </div>
      {bible.translations.length > 0 && (
        <div className="about-row">
          <span>Favorite translation<span className="muted bible-sub">Used unless a view picks another</span></span>
          <select className="input bible-favorite" value={bible.tr} onChange={(e) => setFavorite(e.target.value)} aria-label="Favorite translation">
            {bible.translations.map((t) => <option key={t.id} value={t.id}>{t.label} · {t.name}</option>)}
          </select>
        </div>
      )}
      <div className="about-row">
        <span>ESV {on(p.esv?.connected)}</span>
        <button className="btn btn-small" onClick={() => dialog.open((c) => <EsvDialog close={c} />)}>ESV…</button>
      </div>
      <div className="about-row">
        <span>NLT {on(p.nlt?.connected)}</span>
        <button className="btn btn-small" onClick={() => dialog.open((c) => <NltDialog close={c} />)}>NLT…</button>
      </div>
      <div className="about-row">
        <span>API.Bible {on(p.apibible?.connected)}{p.apibible?.chosen?.length ? <span className="muted"> · {p.apibible.chosen.map((b) => b.abbr).join(', ')}</span> : null}</span>
        <button className="btn btn-small" onClick={() => dialog.open((c) => <ApiBibleDialog close={c} />)}>API.Bible…</button>
      </div>
    </>
  );
}

/** A usage bar like the ESV's (EsvDialog). */
function Bar({ label, n, max, warn = true }) {
  const pct = Math.min(100, (n / max) * 100);
  return (
    <div className="esv-meter-row">
      <span>{label}</span>
      <div className="esv-meter-bar" role="meter" aria-label={label} aria-valuenow={n} aria-valuemin={0} aria-valuemax={max}>
        <span className={pct >= 80 && warn ? 'is-high' : ''} style={{ width: `${pct}%` }} />
      </div>
      <span className="esv-meter-num">{n.toLocaleString()} / {max.toLocaleString()}</span>
    </div>
  );
}

/** Lookups against a provider's limit and the verses kept here, with a button to forget them. */
function Meter({ provider, max = 500 }) {
  const dialog = useDialog();
  const [u, setU] = useState(null);
  useEffect(() => { api.bibleUsage().then(setU).catch(() => {}); }, []);
  if (!u) return null;
  const m = u[provider];
  const forget = async () => {
    if (!await dialog.confirm({ title: 'Forget the stored passages?', message: 'They’ll be looked up again the next time you read them.', okLabel: 'Forget', danger: true })) return;
    try { setU(await api.forgetBible(provider === 'nlt' ? 'NLT' : 'apibible')); bibleChanged(); } catch (e) { dialog.toast(e.message, 'error'); }
  };
  return (
    <div className="esv-meter" aria-label="Usage">
      <h3>Lookups</h3>
      {provider === 'nlt'
        ? <Bar label="Last 24 hours" n={m.day} max={m.limits.day} />
        : <Bar label="This month" n={m.month} max={m.limits.month} />}
      <p className="muted esv-meter-note">
        Only passages fetched from the API count. Passages already stored here are free:
        {' '}<strong>{(provider === 'nlt' ? m.storedDay : m.storedMonth).toLocaleString()}</strong> read from storage {provider === 'nlt' ? 'in the last 24 hours' : 'this month'}.
      </p>
      <h3>Stored verses</h3>
      <Bar label="Stored" n={m.cached} max={max} warn={false} />
      <p className="muted esv-meter-note">
        Up to 500 verses a translation are kept; the least recently read make room for new ones.
        {provider === 'apibible' && ' Stored text is looked up again after 30 days, as API.Bible asks.'}
        {' '}<button type="button" className="link-btn" onClick={forget} disabled={!m.cached}>Forget them</button>
      </p>
    </div>
  );
}

/** Settings → Bible → NLT: Tyndale's NLT API with the user's own (free, non-commercial) key. */
export function NltDialog({ close }) {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.bibleStatus().then((s) => setStatus(s.providers.nlt)).catch((e) => setError(e.message)); }, []);
  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connectNlt(apiKey);
      setStatus((await api.bibleStatus()).providers.nlt);
      setApiKey('');
      bibleChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    await api.disconnectNlt();
    setStatus((await api.bibleStatus()).providers.nlt);
    bibleChanged();
  };
  if (!status && !error) return <div className="wp-dialog"><h2>NLT</h2><p className="muted">Loading…</p></div>;
  const connected = status?.connected;
  return (
    <form className="wp-dialog stack-form" onSubmit={connect}>
      <h2>New Living Translation</h2>
      {connected ? (
        <p className="wp-connected"><Icon name="check" size={16} /> Connected to the NLT API.</p>
      ) : (
        <>
          <p className="modal-message">
            Read and quote the NLT with your own key from Tyndale. Create a free account
            at <a href="https://api.nlt.to/Account/Register" target="_blank" rel="noopener noreferrer">api.nlt.to</a> (non-commercial, personal
            use), then paste the key it gives you below.
          </p>
          <label className="field-label" htmlFor="nlt-key">API key</label>
          <input id="nlt-key" className="input" type="password" autoComplete="off" spellCheck={false} value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} required autoFocus />
        </>
      )}
      {connected && <Meter provider="nlt" />}
      <p className="muted esv-copyright">{status?.copyright} The NLT API allows 5,000 lookups a day and 500 verses a lookup.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        {connected && <button type="button" className="btn btn-danger-text" onClick={disconnect}>Disconnect</button>}
        {connected
          ? <button type="button" className="btn btn-primary" onClick={() => close()}>Done</button>
          : (
            <>
              <button type="button" className="btn" onClick={() => close()}>Close</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !apiKey.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
            </>
          )}
      </div>
    </form>
  );
}

/**
 * Settings → Bible → API.Bible: the user's own key, then the Bibles it may use, ticked to show them in Selah
 * (the free plan allows the open and public-domain Bibles and up to 3 copyrighted ones).
 */
export function ApiBibleDialog({ close }) {
  const dialog = useDialog();
  const [status, setStatus] = useState(null);
  const [bibles, setBibles] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [q, setQ] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const refresh = async () => {
    const s = (await api.bibleStatus()).providers.apibible;
    setStatus(s);
    setChosen(s.chosen ?? []);
    return s;
  };
  useEffect(() => {
    refresh().then((s) => { if (s.connected) api.apiBibles().then(setBibles).catch((e) => setError(e.message)); }).catch((e) => setError(e.message));
  }, []);
  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.connectApiBible(apiKey);
      setBibles(r.bibles);
      await refresh();
      setApiKey('');
      bibleChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (b) => setChosen((c) => (c.some((x) => x.id === b.id) ? c.filter((x) => x.id !== b.id) : [...c, { id: b.id, abbr: b.abbr, name: b.name }]));
  const save = async () => {
    setBusy(true);
    try {
      await api.chooseApiBibles(chosen);
      bibleChanged();
      close();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!await dialog.confirm({ title: 'Disconnect API.Bible?', message: 'Its Bibles leave Selah, and their stored passages are forgotten.', okLabel: 'Disconnect', danger: true })) return;
    await api.disconnectApiBible();
    setBibles(null);
    await refresh();
    bibleChanged();
  };
  if (!status && !error) return <div className="wp-dialog"><h2>API.Bible</h2><p className="muted">Loading…</p></div>;
  const connected = status?.connected;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (bibles ?? []).filter((b) => words.every((w) => `${b.abbr} ${b.name} ${b.language}`.toLowerCase().includes(w)));
  const changed = JSON.stringify(chosen.map((b) => b.id)) !== JSON.stringify((status?.chosen ?? []).map((b) => b.id));
  return (
    <form className="wp-dialog stack-form api-bible-dialog" onSubmit={connect}>
      <h2>API.Bible</h2>
      {connected ? (
        <>
          <p className="wp-connected"><Icon name="check" size={16} /> Connected to API.Bible.</p>
          <p className="muted">Tick the Bibles to read in Selah. The free plan has the open and public-domain Bibles and up to 3 copyrighted ones.</p>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a Bible (name, abbreviation or language)" aria-label="Find a Bible" />
          {!bibles ? <p className="muted">Loading the Bibles your key can use…</p> : (
            <ul className="api-bible-list">
              {shown.slice(0, 200).map((b) => (
                <li key={b.id}>
                  <label className="check">
                    <input type="checkbox" checked={chosen.some((x) => x.id === b.id)} onChange={() => toggle(b)} />
                    <strong>{b.abbr}</strong> <span>{b.name}</span> <span className="muted">{b.language}</span>
                  </label>
                </li>
              ))}
              {!shown.length && <li className="muted">Nothing matches.</li>}
            </ul>
          )}
          <Meter provider="apibible" max={500 * Math.max(1, status.chosen?.length ?? 0)} />
        </>
      ) : (
        <>
          <p className="modal-message">
            Read Bibles from API.Bible (the American Bible Society) with your own key: the KJV and other public-domain and open
            Bibles, plus a few copyrighted ones on the free plan. Sign up at <a href="https://api.bible/sign-up" target="_blank" rel="noopener noreferrer">api.bible</a>,
            copy the key from your dashboard, and paste it below.
          </p>
          <label className="field-label" htmlFor="ab-key">API key</label>
          <input id="ab-key" className="input" type="password" autoComplete="off" spellCheck={false} value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} required autoFocus />
        </>
      )}
      <p className="muted esv-copyright">
        Each Bible’s copyright shows with its text. The free plan allows 5,000 lookups a month (for all its Bibles together)
        and personal, non-commercial use; each lookup is reported to API.Bible’s fair-use counter, as it asks.
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        {connected && <button type="button" className="btn btn-danger-text" onClick={disconnect}>Disconnect</button>}
        {connected
          ? <button type="button" className="btn btn-primary" onClick={changed ? save : () => close()} disabled={busy}>{changed ? 'Save' : 'Done'}</button>
          : (
            <>
              <button type="button" className="btn" onClick={() => close()}>Close</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !apiKey.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
            </>
          )}
      </div>
    </form>
  );
}
