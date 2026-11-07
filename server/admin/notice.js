import { getSetting, setSetting } from '../db.js';
import { listTenants } from './store.js';
import { control } from './control.js';

/**
 * The maintenance notice for users (7.3): a banner across Selah for everyone, about maintenance at a date and time,
 * shown from a time the admin chooses. Kept here (setting `user_notice`) and sent to each tenant (POST
 * /control/notice in server/tenant.js); the monitor sends it again to a tenant whose copy is older (one restarted, or
 * added since).
 *
 * { on, start, end, showFrom, message, updatedAt }: times are epoch ms; end may be null (the banner then goes 4 hours
 * after the start).
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const OFF = { on: false, start: null, end: null, showFrom: null, message: '', updatedAt: 0 };

export function getNotice() {
  try { return { ...OFF, ...JSON.parse(getSetting('user_notice') ?? 'null') }; } catch { return { ...OFF }; }
}

const time = (v, label) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw httpError(400, `${label} isn’t a date and time.`);
  return Math.round(n);
};

/** Saves the notice (body as above, without updatedAt) and sends it to every active tenant. */
export async function saveNotice(b = {}) {
  const on = !!b.on;
  const start = time(b.start, 'The start');
  const end = time(b.end, 'The end');
  const showFrom = time(b.showFrom, '“Show from”');
  const message = String(b.message ?? '').trim().slice(0, 300);
  if (on && !start) throw httpError(400, 'Choose when maintenance starts.');
  if (end && start && end <= start) throw httpError(400, 'The end has to be after the start.');
  if (on && showFrom && start && showFrom > start) throw httpError(400, 'Show the banner before maintenance starts.');
  const notice = { on, start, end, showFrom, message, updatedAt: Date.now() };
  setSetting('user_notice', JSON.stringify(notice));
  const sent = await Promise.all(listTenants().filter((t) => t.status === 'active').map((t) => pushNotice(t, notice).then(() => true, () => false)));
  return { notice, sent: sent.filter(Boolean).length, failed: sent.filter((x) => !x).length };
}

export const pushNotice = (t, notice = getNotice()) => control(t, 'POST', '/control/notice', notice, { timeout: 5000 });
