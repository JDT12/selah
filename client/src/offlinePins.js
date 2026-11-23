// 14.4: notes, sermons and lessons pinned to stay on the phone and tablet for use with no connection, beyond the ones
// the app picks by itself (offlineWork.js). Kept as a preference, so pinning on the PC reaches the app.
import { api } from './api.js';

const KEY = 'offlinePins';
const MAX = 100;
let pins = null;
const listeners = new Set();

export async function offlinePins() {
  if (!pins) pins = ((await api.getPref(KEY).catch(() => null)) ?? []).filter(Number.isInteger);
  return pins;
}

export const isKeptOffline = (id) => !!pins?.includes(id);

export function onOfflinePins(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pins or unpins a note; resolves to whether it's pinned now. */
export async function keepOffline(id, on) {
  const list = (await offlinePins()).filter((x) => x !== id);
  if (on) list.unshift(id);
  pins = list.slice(0, MAX);
  await api.setPref(KEY, pins);
  listeners.forEach((fn) => fn(pins));
  return on;
}
