import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useDialog } from './Dialogs.jsx';

/**
 * 14.0 Settings → General → App: connecting the Selah app on a phone or tablet to this server. The code opens
 * /connect-app (server/routes.js) in the phone's camera, whose button opens the app with this server's address.
 */
export function PhoneAppRow() {
  const dialog = useDialog();
  return (
    <div className="about-row">
      <span className="muted">The Selah app for iPhone, iPad and Android opens this Selah too. Scan a code with the phone’s camera, or type {location.host} in the app.</span>
      <button type="button" className="btn btn-small" onClick={() => dialog.open((c) => <PhoneAppDialog close={c} />)}>Connect a phone or tablet…</button>
    </div>
  );
}

function PhoneAppDialog({ close }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(`${location.origin}/connect-app`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg).catch(() => setSvg(''));
  }, []);
  return (
    <div>
      <h2>Connect a phone or tablet</h2>
      <div className="phone-connect">
        {svg ? <div className="qr-box" role="img" aria-label={`QR code that opens ${location.host} in the Selah app`} dangerouslySetInnerHTML={{ __html: svg }} />
          : <div className="qr-box qr-loading" />}
        <ol className="phone-connect-steps">
          <li>Install the Selah app on the phone or tablet.</li>
          <li>Point the phone’s camera at this code and open the link.</li>
          <li>Tap <strong>Open in the Selah app</strong>, then sign in as you do here.</li>
        </ol>
      </div>
      <p className="muted">Or open the app and type <strong>{location.host}</strong>.</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" autoFocus onClick={() => close(null)}>Done</button>
      </div>
    </div>
  );
}
