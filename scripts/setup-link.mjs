#!/usr/bin/env node
// Selah Cloud (14.1): a new one-time setup link, for a first setup whose link was lost, or a forgotten password or
// lost phone (a reset: the person chooses a new password and sets up their authenticator again). Runs inside the
// container, by `selah setup-link` (docker/cloud/selah):
//   docker compose exec selah node scripts/setup-link.mjs [--days 7]
// Prints the link. Making one replaces any earlier link that hasn't been used.
import { config } from '../server/config.js';

if (!config.cloudContainer && config.mode !== 'tenant') {
  console.error('Setup links are for Selah Cloud in its container. On another server, use: npm run set-password');
  process.exit(1);
}
const auth = await import('../server/auth.js');
const { newSetupLink } = await import('../server/tenant.js');
const i = process.argv.indexOf('--days');
const days = i > 0 ? Number(process.argv[i + 1]) || 7 : 7;
const kind = auth.passwordIsSet() ? 'reset' : 'invite';
const { token, expires } = newSetupLink(kind, days, 'server');
const base = (process.env.NOTEAPP_PUBLIC_URL || '').replace(/\/+$/, '');
console.log(kind === 'reset'
  ? 'Open this link to choose a new password (and set up the authenticator app again):'
  : 'Open this link to finish setting up Selah:');
console.log(`  ${base}/#setup=${token}`);
console.log(`It works once, until ${new Date(expires).toUTCString()}.`);
process.exit(0);
