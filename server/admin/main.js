// The admin console: node server/admin/main.js (the selah-admin service). NOTEAPP_CLOUD_ROOT says where its data,
// the tenants and the gateway's config live; `npm run admin -- init` sets them up.
import fs from 'node:fs';
import path from 'node:path';
import { adminEnv, paths } from './paths.js';

if (!fs.existsSync(path.join(paths.adminStorage, '.note-app-storage'))) {
  console.error(`The admin console isn't set up in ${paths.root}. Run: npm run admin -- init`);
  process.exit(1);
}
adminEnv();
await import('./server.js');
