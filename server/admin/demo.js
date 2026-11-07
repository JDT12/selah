import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { alert, getTenant, mustTenant, startJob } from './store.js';
import { paths } from './paths.js';
import { crashLoop, runner } from './runner.js';
import { control, waitHealthy } from './control.js';
import { makeFolders } from './lifecycle.js';
import { releaseVersion, updateRunning } from './releases.js';

/**
 * The demo tenant (Admin 3.2): a Selah full of clearly made-up sample data, for trying a beta release and for
 * recording instructional videos. Reset puts it back to the same starting point every time:
 *   1. the sign-in (password, two-step, username and email), the connected Bible and site keys and the signed-in
 *      devices are read from its database;
 *   2. it's stopped and its storage (database, attachments, restore points) is moved aside to storage-before-reset/;
 *   3. it starts on an empty database, so everything a new Selah sets up for itself is there;
 *   4. its control port puts the sign-in back and adds the sample data (server/demo/seed.js, part of the release the
 *      demo runs, so the data always fits its code), dated around today.
 * If anything fails, the storage it had goes back and it starts as it was. Only ever on the tenant called "demo",
 * and only when you click Reset (nothing resets it by itself).
 */

export const DEMO_SLUG = 'demo';
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

/** Settings that are the account, not the sample data: they survive a reset. */
export const KEEP_SETTINGS = [
  'password_hash', 'account_identity', 'account_identity_asked', 'totp', 'recovery_codes', 'security', 'two_step_nudge_off',
  'esv', 'bible.nlt', 'bible.apibible', 'bible.favorite', 'bible.fumsDevice', 'zotero', 'wordpress', 'trash_days', 'sharing_off',
  // What you ticked off and noted while trying betas (server/betareview.js): it's about the release, not the sample data.
  'beta_review',
];

let running = null;
export const demoResetRunning = () => running;

/** The account settings and signed-in devices in the demo's database now. */
function readAccount(dbFile) {
  if (!fs.existsSync(dbFile)) return { settings: {}, sessions: [] };
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const settings = {};
    const get = db.prepare('SELECT value FROM settings WHERE key = ?');
    for (const k of KEEP_SETTINGS) {
      const r = get.get(k);
      if (r) settings[k] = r.value;
    }
    let sessions = [];
    try { sessions = db.prepare('SELECT * FROM sessions WHERE expires_at > ?').all(Date.now()); } catch { /* no sessions table */ }
    return { settings, sessions: sessions.map((s) => ({ ...s })) };
  } finally {
    db.close();
  }
}

export function resetDemo({ slug = DEMO_SLUG } = {}) {
  if (slug !== DEMO_SLUG) throw httpError(400, 'Only the demo tenant can be reset.');
  const t = mustTenant(slug);
  if (t.status !== 'active') throw httpError(409, 'The demo is paused. Resume it first.');
  if (updateRunning()) throw httpError(409, 'An update is running. Reset the demo when it’s finished.');
  if (running) throw httpError(409, 'The demo is already being reset.');
  const job = startJob('demo-reset', slug);
  running = { jobId: job.id };
  const p = paths.tenant(slug);
  const aside = path.join(p.dir, 'storage-before-reset');
  (async () => {
    let moved = false;
    try {
      job.phase('Reading the demo’s sign-in');
      // The newest writes are in the -wal file until a checkpoint; a stopped Selah has checkpointed, so stop first.
      await runner().stop(t);
      const account = readAccount(p.db);
      job.phase('Moving the demo’s data aside');
      fs.rmSync(aside, { recursive: true, force: true });
      fs.renameSync(p.storage, aside);
      moved = true;
      makeFolders(slug);
      job.phase('Starting the demo on an empty database');
      const fresh = getTenant(slug);
      await runner().start(fresh);
      await waitHealthy(fresh, { version: releaseVersion(fresh.release), timeout: 90_000, failFast: crashLoop(fresh) });
      job.phase('Adding the sample data');
      const r = await control(fresh, 'POST', '/control/demo-seed', account, { timeout: 180_000 });
      job.finish(true, { counts: r.counts ?? null, version: releaseVersion(fresh.release) });
    } catch (e) {
      let back = '';
      if (moved) {
        try {
          await runner().stop(t);
          fs.rmSync(p.storage, { recursive: true, force: true });
          fs.renameSync(aside, p.storage);
          back = ' Its data before the reset is back.';
        } catch (e2) {
          back = ` Putting its data back failed too (${e2.message}); it's in ${aside}.`;
        }
      }
      try {
        const again = getTenant(slug);
        await runner().start(again);
        await waitHealthy(again, { timeout: 60_000 }).catch(() => {});
      } catch { /* the alert says what happened */ }
      const message = /404|Not found/i.test(e.message)
        ? `The demo’s release (${releaseVersion(t.release) ?? 'this code'}) can’t add sample data yet. Move the demo to a newer release first.`
        : e.message;
      job.finish(false, { error: `${message}${back}` });
      alert(slug, 'danger', 'demo-reset-failed', `Resetting the demo failed: ${message}${back}`, { quiet: 0 });
    } finally {
      running = null;
    }
  })();
  return { jobId: job.id };
}
