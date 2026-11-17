import { db } from '../db.js';
import { cloud, getTenant, listTenants, saveCloud } from './store.js';
import { control } from './control.js';
import { checkHub, forgetInHub, hubControl, syncHub } from './hub.js';

/**
 * Sharing between tenants (Admin 3.0, Selah 8.0; through the share hub since 14.1, server/hub/ and ./hub.js). The
 * hub holds contacts, shares, the shared notes and comments, and checks every request against them; the console
 * keeps it running, tells it who the Selahs are and whether each may share, and shows the overview (titles and who,
 * never the notes) on its Sharing page.
 *
 * The 8.0 relay's tables (relay_*) stay only so the hub can take their contacts the first time it starts.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

db.exec(`
CREATE TABLE IF NOT EXISTS relay_contacts (
  a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b)
);`);

export const sharingOff = () => new Set(cloud().sharingOff ?? []);

/** Turns sharing off (or on) for a tenant. Turning it off ends what it shares and what's shared with it (the hub does). */
export async function setSharing(slug, on) {
  const t = getTenant(slug);
  if (!t) throw httpError(404, 'No tenant by that name.');
  const off = sharingOff();
  if (on) off.delete(slug); else off.add(slug);
  saveCloud({ sharingOff: [...off] });
  await syncHub().catch(() => {});
  await pushSharingState(t).catch(() => {});
  return sharingOverview();
}

/** Tells the tenant directly too (its Settings show it at once, even if it hasn't heard from the hub yet). */
export const pushSharingState = (t) => control(t, 'POST', '/control/sharing/state', { on: !sharingOff().has(t.slug) }, { timeout: 5000 });

export async function sharingOverview() {
  let hub = null;
  let error = null;
  try { hub = await hubControl('GET', '/control/overview'); } catch (e) { error = `The share hub isn’t answering (${e.message}).`; }
  const byHub = new Map((hub?.tenants ?? []).map((t) => [t.slug, t]));
  const off = sharingOff();
  return {
    error,
    tenants: listTenants().map((t) => {
      const h = byHub.get(t.slug);
      return {
        slug: t.slug, name: t.name || t.slug, on: !off.has(t.slug),
        contacts: h?.contacts ?? 0, pending: h?.pending ?? 0, sharing: h?.sharing ?? 0, sharedWith: h?.sharedWith ?? 0,
        held: h?.waiting ?? 0,
        // Asked the hub within the last minute (each Selah keeps a request waiting there).
        connected: !!h?.seenAt && Date.now() - h.seenAt < 90_000,
      };
    }),
    contacts: hub?.contacts ?? [],
    shares: hub?.shares ?? [],
    log: hub?.log ?? [],
  };
}

/** Removes a tenant from sharing (deleted): the hub drops its contacts and shares, and its network goes. */
export async function forgetTenant(slug) {
  await forgetInHub(slug);
}

/** Keeps the hub running and up to date: at start, then every minute. */
export function startSharingHub(logger) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await checkHub(logger); } catch (e) { logger?.warn?.(`Share hub: ${e.message}`); } finally { busy = false; }
  };
  tick();
  setInterval(tick, 60_000).unref();
}
