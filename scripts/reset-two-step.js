// Turns off two-step sign-in, for when the authenticator app and the recovery codes are both lost.
// Usage: npm run reset-two-step (then sign in with the password and set it up again in Settings → Security).
import { setSetting } from '../server/db.js';
import { logEvent } from '../server/auth.js';

setSetting('totp', 'null');
setSetting('recovery_codes', '[]');
logEvent('two-step-off', null, { from: 'server' });
console.log('Two-step sign-in is off. Sign in with your password, then turn it on again in Settings → Security.');
