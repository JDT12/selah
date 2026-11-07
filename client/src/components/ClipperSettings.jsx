import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from './Dialogs.jsx';

const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

/** Settings → Browser extension: download the Edge clipper, connect it with a one-time code, and revoke keys. */
export function ClipperRow() {
  const dialog = useDialog();
  return (
    <div className="about-row">
      <span className="muted">Clip pages, selections, links, images and screenshots from Edge to your Inbox.</span>
      <button className="btn btn-small" onClick={() => dialog.open((c) => <ClipperDialog close={c} />)}>Set up clipper…</button>
    </div>
  );
}

export function ClipperDialog({ close }) {
  const dialog = useDialog();
  const [devices, setDevices] = useState(null);
  const [pair, setPair] = useState(null); // { code, expiresAt }
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => api.clipDevices().then(setDevices).catch((e) => dialog.toast(e.message, 'error')), [dialog]);
  useEffect(() => { load(); }, [load]);
  // While a code is showing: count down, and notice when the extension has used it.
  useEffect(() => {
    if (!pair) return undefined;
    const t = setInterval(() => { setNow(Date.now()); load(); }, 2000);
    return () => clearInterval(t);
  }, [pair, load]);
  const [known, setKnown] = useState(null);
  useEffect(() => {
    if (!devices) return;
    if (pair && known != null && devices.length > known) { setPair(null); dialog.toast('Clipper connected'); }
    if (!pair) setKnown(devices.length);
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    try {
      setKnown(devices?.length ?? 0);
      setPair(await api.clipPairing());
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };
  const revoke = async (d) => {
    const ok = await dialog.confirm({ title: `Disconnect ${d.name}?`, message: 'That clipper’s key stops working right away. You can connect it again with a new code.', okLabel: 'Disconnect', danger: true });
    if (!ok) return;
    await api.revokeClipDevice(d.id);
    load();
  };
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;

  return (
    <div className="clipper-dialog">
      <div className="dialog-header">
        <h2>Edge clipper</h2>
        <button className="icon-btn" onClick={() => close()} aria-label="Close" title="Close"><Icon name="x" /></button>
      </div>

      <ol className="clipper-steps">
        <li>
          <a className="btn btn-small" href="/api/clip/extension.zip" download><Icon name="download" size={14} /> Download the extension</a>
          <span className="muted"> and unzip it (right-click → Extract All) into a folder you’ll keep, for example Documents\Selah Clipper.</span>
        </li>
        <li>In Edge, go to <code>edge://extensions</code> and turn on <strong>Developer mode</strong>.</li>
        <li>Click <strong>Load unpacked</strong> and pick the folder you unzipped into (the one with <strong>manifest.json</strong> in it).</li>
        <li>
          Click the Selah button in Edge’s toolbar and type a code from here:
          <div className="clipper-pair">
            {pair && left > 0 ? (
              <>
                <span className="clipper-code" aria-label="Pairing code">{pair.code}</span>
                <span className="muted">Good for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · works once</span>
              </>
            ) : (
              <button className="btn btn-primary btn-small" onClick={connect}>Connect a browser…</button>
            )}
          </div>
        </li>
      </ol>
      <p className="muted clipper-note">
        To update the clipper, download it again, replace the folder’s files, and click <strong>Reload</strong> on the
        extension in <code>edge://extensions</code>. Its key can only add notes; it can’t read or change them.
      </p>

      <h3>Connected</h3>
      {devices && !devices.length && <p className="muted">No clipper connected yet.</p>}
      {devices?.map((d) => (
        <div key={d.id} className="about-row">
          <span><strong>{d.name}</strong> <span className="muted">· connected {when(d.created_at)} · last used {when(d.last_used_at)}</span></span>
          <button className="btn btn-small btn-danger-text" onClick={() => revoke(d)}>Disconnect</button>
        </div>
      ))}

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={() => close()}>Done</button>
      </div>
    </div>
  );
}
