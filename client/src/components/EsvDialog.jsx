import { useEffect, useState } from 'react';
import { api, formatDate } from '../api.js';
import { bibleChanged } from '../esv.js';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';

/** Settings → ESV Bible: connect with your own (free) ESV API key from api.esv.org. */
export default function EsvDialog({ close }) {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { api.esvStatus().then(setStatus).catch((e) => setError(e.message)); }, []);

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connectEsv(apiKey);
      setStatus(await api.esvStatus());
      setApiKey('');
      bibleChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    await api.disconnectEsv();
    setStatus(await api.esvStatus());
    bibleChanged();
  };

  if (!status && !error) return <div className="wp-dialog"><h2>ESV Bible</h2><p className="muted">Loading…</p></div>;
  const connected = status?.connected;

  return (
    <form className="wp-dialog stack-form" onSubmit={connect}>
      <h2>ESV Bible</h2>
      {connected ? (
        <>
          <p className="wp-connected"><Icon name="check" size={16} /> Connected to the ESV API.</p>
          <p className="muted">Hover over a Bible reference in a note or on Daily Walk to read it. To quote a passage, right-click
            a reference → <strong>Insert ESV text</strong> (when the ESV is your favorite), or type <strong>/bible</strong> in a note.</p>
        </>
      ) : (
        <>
          <p className="modal-message">
            Show the text of Bible references when you hover over them, and insert passages into notes. Create a free account
            at <a href="https://api.esv.org/" target="_blank" rel="noopener noreferrer">api.esv.org</a>, choose
            <strong> Create an API application</strong> (non-commercial, personal use), and paste its key below.
          </p>
          <label className="field-label" htmlFor="esv-key">API key</label>
          <input id="esv-key" className="input" type="password" autoComplete="off" spellCheck={false} value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} required autoFocus placeholder="40 letters and numbers" />
        </>
      )}
      {connected && <EsvMeter />}
      <p className="muted esv-copyright">{status?.copyright} Up to 500 verses are kept on this server at a time, as Crossway asks.</p>
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
 * Lookups against Crossway's limits (only lookups the ESV API answers count; stored passages are free), and the
 * passages kept on this server, which can be looked through and forgotten.
 */
function EsvMeter() {
  const dialog = useDialog();
  const [u, setU] = useState(null);
  const [stored, setStored] = useState(null);
  const [showStored, setShowStored] = useState(false);
  useEffect(() => { api.esvUsage().then(setU).catch(() => {}); }, []);
  useEffect(() => { if (showStored) api.esvStored().then(setStored).catch((e) => dialog.toast(e.message, 'error')); }, [showStored, dialog]);
  if (!u) return null;

  const forget = async (ref) => {
    if (!ref && !await dialog.confirm({
      title: 'Forget all stored passages?',
      message: 'They’ll be looked up from the ESV again the next time you read them.',
      okLabel: 'Forget all', danger: true,
    })) return;
    try {
      setU(await api.forgetEsv(ref));
      setStored(await api.esvStored());
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const rows = [
    ['Last minute', u.minute, u.limits.minute],
    ['Last hour', u.hour, u.limits.hour],
    ['Last 24 hours', u.day, u.limits.day],
  ];
  const bar = (label, n, max, warn = true) => {
    const pct = Math.min(100, (n / max) * 100);
    return (
      <div key={label} className="esv-meter-row">
        <span>{label}</span>
        <div className="esv-meter-bar" role="meter" aria-label={label} aria-valuenow={n} aria-valuemin={0} aria-valuemax={max}>
          <span className={pct >= 80 && warn ? 'is-high' : ''} style={{ width: `${pct}%` }} />
        </div>
        <span className="esv-meter-num">{n.toLocaleString()} / {max.toLocaleString()}</span>
      </div>
    );
  };
  return (
    <div className="esv-meter" aria-label="ESV usage">
      <h3>Lookups from the ESV</h3>
      {rows.map(([label, n, max]) => bar(label, n, max))}
      <p className="muted esv-meter-note">
        Only passages fetched from the ESV count toward Crossway’s limits. Passages already stored here are free:
        {' '}<strong>{u.storedDay.toLocaleString()}</strong> {u.storedDay === 1 ? 'was' : 'were'} read from storage in the last 24 hours.
      </p>
      <h3>Stored verses</h3>
      {bar('Stored', u.cached, u.maxCached, false /* a store that fills up and makes room: never a warning */)}
      <p className="muted esv-meter-note">The least recently read passages make room for new ones.</p>
      <button type="button" className="link-btn esv-stored-toggle" aria-expanded={showStored} onClick={() => setShowStored((v) => !v)}>
        <Icon name={showStored ? 'chevronDown' : 'chevronRight'} size={14} /> {showStored ? 'Hide' : 'Show'} stored passages
      </button>
      {showStored && (
        <div className="esv-stored">
          {!stored ? <p className="muted">Loading…</p> : !stored.length ? <p className="muted">No passages are stored.</p> : (
            <>
              <ul>
                {stored.map((p) => (
                  <li key={p.ref}>
                    <span className="esv-stored-ref">{p.ref}</span>
                    <span className="muted">{p.verses === 1 ? '1 verse' : `${p.verses} verses`} · {formatDate(p.usedAt)}</span>
                    <button type="button" className="icon-btn" onClick={() => forget(p.ref)} aria-label={`Forget ${p.ref}`} title="Forget">
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="link-btn danger" onClick={() => forget(null)}>Forget all</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
