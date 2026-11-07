import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DialogProvider } from '../components/Dialogs.jsx';
import AdminApp from './AdminApp.jsx';
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
import '../styles.css';
import './admin.css';

// The admin console (served by server/admin/server.js at admin.<domain>).
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DialogProvider>
      <AdminApp />
    </DialogProvider>
  </StrictMode>,
);
