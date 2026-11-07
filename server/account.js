import { getSetting, setSetting } from './db.js';
import * as auth from './auth.js';
import { config } from './config.js';
import { twoFactorOn } from './security.js';

/**
 * 10.0: who signs in. A Selah has a username and an email (chosen on the setup link, or the first time you sign in
 * after 10.0), and the sign-in page asks for either one with the password. Until both are chosen, the password alone
 * still signs in. Two-step sign-in is recommended, not required: until it's on, Home and Settings → Security say so
 * (each reminder can be put away).
 */

const httpError = (code, message, extra = {}) => Object.assign(new Error(message), { statusCode: code, ...extra });
const readJson = (key, fallback) => {
  try { return JSON.parse(getSetting(key) ?? 'null') ?? fallback; } catch { return fallback; }
};

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** { username, email } once chosen, else null. */
export function identity() {
  const v = readJson('account_identity', null);
  return v?.username && v?.email ? v : null;
}

/** The username and email as typed, tidied, or a 400 saying what's wrong. */
export function checkIdentity(body) {
  const username = String(body?.username ?? '').trim().toLowerCase();
  const email = String(body?.email ?? '').trim();
  if (!USERNAME.test(username)) throw httpError(400, 'Choose a username of 3 to 32 letters, numbers, dots, dashes or underscores (it can’t start or end with a dot or dash).');
  if (email.length > 254 || !EMAIL.test(email)) throw httpError(400, 'That email address doesn’t look right.');
  if (username.includes('@')) throw httpError(400, 'A username can’t have an @ in it.');
  return { username, email };
}

export function saveIdentity(who) {
  setSetting('account_identity', JSON.stringify({ ...who, since: Date.now() }));
}

/** Whether what was typed in the sign-in page's first box is this Selah's username or email. */
export function isMe(login) {
  const who = identity();
  if (!who) return true; // not chosen yet: the password alone
  const typed = String(login ?? '').trim().toLowerCase();
  return !!typed && (typed === who.username || typed === who.email.toLowerCase());
}

export default async function account(app) {
  // The username and email, and whether to ask for them (once) and to suggest two-step sign-in.
  app.get('/api/account/identity', async () => {
    const who = identity();
    return {
      username: who?.username ?? '',
      email: who?.email ?? '',
      // Ask once, right after signing in, on a Selah from before 10.0 (not the admin console).
      // Neither in Selah Desktop, which has no sign-in.
      ask: !who && config.mode !== 'admin' && config.edition !== 'desktop' && getSetting('account_identity_asked') == null,
      twoStepNudge: config.mode !== 'admin' && config.edition !== 'desktop' && !twoFactorOn() && getSetting('two_step_nudge_off') == null,
    };
  });

  app.put('/api/account/identity', async (req) => {
    auth.requireConfirmed(req);
    const was = identity();
    const who = checkIdentity(req.body);
    saveIdentity(who);
    setSetting('account_identity_asked', String(Date.now()));
    auth.logEvent(was ? 'identity-changed' : 'identity-set', req);
    return { username: who.username, email: who.email };
  });

  // "Later" on the question after signing in: it isn't asked again (Settings → Account still has it).
  app.post('/api/account/identity/later', async () => {
    setSetting('account_identity_asked', String(Date.now()));
    return { ok: true };
  });

  app.post('/api/account/two-step-nudge/off', async () => {
    setSetting('two_step_nudge_off', String(Date.now()));
    return { ok: true };
  });
}
