import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import SlidesWindow from './components/SlidesWindow.jsx';
import RemotePage from './components/RemotePage.jsx';
import CaptureWindow from './components/CaptureWindow.jsx';
import SetupPage from './components/SetupPage.jsx';
import { DialogProvider } from './components/Dialogs.jsx';
import { applyNoteFont } from './noteFont.js';
import '@fontsource/cormorant-garamond/latin-600-italic.css';
// 7.0: Inter for the interface, Source Serif 4 for titles and reading.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/source-serif-4/latin-400.css';
import '@fontsource/source-serif-4/latin-400-italic.css';
import '@fontsource/source-serif-4/latin-600.css';
import '@fontsource/source-serif-4/latin-600-italic.css';
// 11.0: slide font pairs (each file loads only when a slide uses it).
import '@fontsource/lora/latin-400.css';
import '@fontsource/lora/latin-400-italic.css';
import '@fontsource/lora/latin-700.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/montserrat/latin-700.css';
import '@fontsource/oswald/latin-600.css';
import '@fontsource/inter/latin-400-italic.css';
import './styles.css';
import './install.js';

// The slides window (opened from preaching, teaching or presenting), the phone remote, the Windows app's quick capture
// window and a hosted Selah's setup link are pages of their own.
const slidesFor = /^#slides(?:\/(\d+))?$/.exec(location.hash);

applyNoteFont();
createRoot(document.getElementById('root')).render(
  <StrictMode>
    {slidesFor ? <SlidesWindow noteId={slidesFor[1] ? Number(slidesFor[1]) : null} /> : location.hash === '#remote' ? <RemotePage /> : location.hash === '#capture' ? <CaptureWindow /> : /^#setup\b/.test(location.hash) ? (
      <DialogProvider>
        <SetupPage />
      </DialogProvider>
    ) : (
      <DialogProvider>
        <App />
      </DialogProvider>
    )}
  </StrictMode>,
);
