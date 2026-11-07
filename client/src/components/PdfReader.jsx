import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { fileUrl, pdfViewerUrl } from '../api.js';

/**
 * A PDF filling the app window, over everything else. It replaces opening the reader in a new tab, which the
 * Windows app and the installed app don't do. Escape (also while the PDF has the focus) or ✕ closes it.
 */
export default function PdfReader({ id, src = null, filename, onClose }) {
  // src: a file that isn't one of my attachments (a note shared with me).
  const url = src ?? fileUrl(id);
  const ref = useRef(null);
  const frame = useRef(null);
  const [fs, setFs] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    // Escape leaves browser full screen first (the browser does that itself), then closes the reader.
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    const onFs = () => setFs(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onFs);
    const prevFocus = document.activeElement;
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, []);

  // The viewer is on this site, so its keys can be watched too: Escape there closes the reader.
  const onLoad = () => {
    try {
      const win = frame.current.contentWindow;
      win.addEventListener('keydown', (e) => {
        // Capture runs before the viewer's own handling, so an open find bar still gets Escape first.
        if (e.key === 'Escape' && !document.fullscreenElement && !win.document.querySelector('#findbar:not(.hidden)')) closeRef.current();
      }, true);
      win.focus();
    } catch { /* not reachable: the buttons still close it */ }
  };

  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else ref.current?.requestFullscreen?.().catch(() => {});
  };

  return createPortal(
    <div ref={ref} className="pdf-reader" role="dialog" aria-modal="true" aria-label={filename}>
      <div className="pdf-reader-bar">
        <Icon name="pdf" size={18} />
        <span className="pdf-reader-name" title={filename}>{filename}</span>
        <span className="spacer" />
        {document.fullscreenEnabled && (
          <button type="button" className="icon-btn" onClick={toggleFs} title={fs ? 'Exit full screen' : 'Full screen'}
            aria-label={fs ? 'Exit full screen' : 'Full screen'}>
            <Icon name={fs ? 'shrink' : 'expand'} size={17} />
          </button>
        )}
        <a className="icon-btn" href={`${url}?download=1`} title="Download" aria-label="Download"><Icon name="download" size={17} /></a>
        <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close"><Icon name="x" size={18} /></button>
      </div>
      <iframe ref={frame} src={src ? `/pdfjs/web/viewer.html?file=${encodeURIComponent(src)}` : pdfViewerUrl(id)} title={filename} onLoad={onLoad} />
    </div>,
    document.body,
  );
}
