import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { citationStyle, forgetSources, setCitationStyle } from '../citations/index.js';
import { CITATION_STYLES } from '../citations/styles.js';
import Icon from './Icon.jsx';

/** Settings → Zotero: connect with a read-only API key, choose the citation style, refresh cited sources. */
export function ZoteroConnectDialog({ close }) {
  const [status, setStatus] = useState(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [style, setStyle] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  useEffect(() => {
    api.zotero().then((s) => { setStatus(s); setEditing(!s.connected); }).catch((e) => setError(e.message));
    citationStyle().then(setStyle);
  }, []);

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.connectZotero(apiKey));
      setEditing(false);
      setApiKey('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => { setStatus(await api.disconnectZotero()); setEditing(true); };
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.refreshSources();
      forgetSources();
      setNote(r.total ? `Updated ${r.updated} of ${r.total} cited sources from Zotero.` : 'No sources cited yet.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const pickStyle = (id) => { setStyle(id); setCitationStyle(id); };

  if (!status && !error) return <div className="wp-dialog"><h2>Zotero</h2><p className="muted">Loading…</p></div>;

  return (
    <form className="wp-dialog stack-form" onSubmit={connect}>
      <h2>Zotero</h2>
      {status?.connected && !editing && (
        <>
          <p className="wp-connected"><Icon name="check" size={16} /> Connected to <strong>{status.username}</strong>’s library{status.groups ? ' and groups' : ''}.</p>
          <p className="muted">Search it from a note with <strong>/cite</strong>, the toolbar’s citation button, or Ctrl+Alt+F.</p>
        </>
      )}
      {editing && (
        <>
          <p className="modal-message">
            Your library needs to sync to zotero.org (Zotero → Settings → Sync). Then, at{' '}
            <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noopener noreferrer">zotero.org/settings/keys</a>,
            create a key: name it “Notes”, tick <strong>Allow library access</strong> (read-only is enough; tick
            <strong> Read Only</strong> under groups too if you cite from group libraries) and choose <strong>Save Key</strong>.
            Paste the key below.
          </p>
          <label className="field-label" htmlFor="zotero-key">API key</label>
          <input id="zotero-key" className="input" type="password" autoComplete="off" spellCheck={false} value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} required autoFocus placeholder="24 letters and numbers" />
        </>
      )}

      <label className="field-label" htmlFor="cite-style">Citation style</label>
      <select id="cite-style" className="input" value={style ?? ''} onChange={(e) => pickStyle(e.target.value)}>
        {CITATION_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <p className="muted zotero-style-note">Used for every note. Notes styles put citations in numbered footnotes with a
        full first note, then short notes; author–date puts them in the text.</p>

      {note && <p className="muted">{note}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        {status?.connected && !editing && (
          <>
            <button type="button" className="btn btn-danger-text" onClick={disconnect}>Disconnect</button>
            <button type="button" className="btn" onClick={refresh} disabled={busy} title="Re-read cited sources after editing them in Zotero">
              {busy ? 'Refreshing…' : 'Refresh sources'}
            </button>
          </>
        )}
        {editing && status?.connected && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>}
        {editing
          ? <button type="submit" className="btn btn-primary" disabled={busy || !apiKey.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
          : <button type="button" className="btn btn-primary" onClick={() => close()}>Done</button>}
        {editing && !status?.connected && <button type="button" className="btn" onClick={() => close()}>Close</button>}
      </div>
    </form>
  );
}
