import { getSetting, setSetting } from './db.js';
import { today } from './recurrence.js';
import { format, parse } from '../shared/scripture.js';

/**
 * The verse of the day on Home (9.0), read in your own translation (server/bible.js). Bible Gateway's daily pick gives
 * the reference (11.0: the only source; Selah's own list is gone). When the feed can't be reached the day has no verse
 * and Home says so; it's asked again an hour on.
 */
const FEED = 'https://www.biblegateway.com/votd/get/?format=json';
const RETRY = 60 * 60 * 1000;

async function fetchPick() {
  const res = await fetch(FEED, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Bible Gateway: ${res.status}`);
  const ref = String((await res.json())?.votd?.reference ?? '').replace(/&ndash;|–/g, '-').trim();
  const found = parse(ref).refs[0];
  if (!found) throw new Error('Bible Gateway: no reference');
  return format(found);
}

let pending = null;
/** { day, reference } (reference null when Bible Gateway couldn't be reached today). */
export async function verseOfTheDay() {
  const day = today();
  const kept = JSON.parse(getSetting('votd') ?? 'null');
  if (kept?.day === day && (kept.reference || Date.now() - kept.at < RETRY)) return kept;
  pending ??= fetchPick()
    .then((reference) => ({ day, reference, at: Date.now() }))
    .catch(() => ({ day, reference: null, at: Date.now() }))
    .then((v) => { setSetting('votd', JSON.stringify(v)); return v; })
    .finally(() => { pending = null; });
  return pending;
}

export default async function votdRoutes(app) {
  app.get('/api/votd', async () => {
    const { day, reference } = await verseOfTheDay();
    return { day, reference, source: 'biblegateway' };
  });
}
