import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500,
    // Selah itself, and the admin console (6.0), which only the admin console's server serves.
    rollupOptions: { input: { main: `${import.meta.dirname}/client/index.html`, admin: `${import.meta.dirname}/client/admin.html` } },
  },
  server: {
    // `npm run dev` proxies the API to the running HTTPS server.
    proxy: { '/api': { target: 'https://localhost:8443', secure: false } },
  },
});
