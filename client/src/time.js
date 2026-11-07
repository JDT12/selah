// Calendar/task times are floating wall-clock strings in the app time zone (from the server,
// America/Chicago by default): 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm'. For arithmetic and display
// they're mapped onto UTC Dates and always formatted with timeZone 'UTC', so the device's own
// time zone never shifts them.

let TZ = 'America/Chicago';
export const setTimeZone = (tz) => { if (tz) TZ = tz; };
export const getTimeZone = () => TZ;

/** Current wall-clock date/time in the app time zone. */
export function nowParts() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${p.hour}:${p.minute}`, iso: `${date}T${p.hour}:${p.minute}:${p.second}`, hour: Number(p.hour) };
}
export const todayStr = () => nowParts().date;

export function toUTC(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, h, mi));
}
export const fmtD = (date) => date.toISOString().slice(0, 10);
export const fmtDT = (date) => date.toISOString().slice(0, 16);
export const addDays = (s, n) => fmtD(new Date(toUTC(s).getTime() + n * 86_400_000));
export const addMinutes = (s, n) => fmtDT(new Date(toUTC(s).getTime() + n * 60_000));
export const diffMinutes = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 60_000);

const fmtCache = new Map();
function format(s, opts) {
  const key = JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }));
  return fmtCache.get(key).format(toUTC(s));
}

/** '09:30' or '2026-10-19T09:30' -> '9:30 AM' */
export function formatTime(s) {
  const iso = s.includes('T') ? s : `2000-01-01T${s}`;
  return format(iso, { hour: 'numeric', minute: '2-digit' });
}
export const formatLongDate = (s) => format(s, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
/** 'Oct 20' (with the year when it isn't this year). */
export const formatMonthDay = (s) => format(s, s.slice(0, 4) === todayStr().slice(0, 4)
  ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
/** Same day of the month n months later, clamped to the month's end: Jan 31 + 1 -> Feb 28. */
export function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmtD(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}
export const formatShortDate = (s) => {
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (s.slice(0, 4) !== todayStr().slice(0, 4)) opts.year = 'numeric';
  return format(s, opts);
};

/** 'Today', 'Tomorrow', 'Yesterday', 'Thursday' (within a week) or 'Mon, Oct 20'. */
export function relativeDay(date) {
  const t = todayStr();
  const diff = Math.round((toUTC(date) - toUTC(t)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return format(date, { weekday: 'long' });
  return formatShortDate(date);
}

/** Round a time up to the next half hour: '09:10' -> '09:30'. */
export function nextHalfHour() {
  const { date, time } = nowParts();
  const [h, m] = time.split(':').map(Number);
  const mins = Math.ceil((h * 60 + m + 1) / 30) * 30;
  return addMinutes(`${date}T00:00`, mins);
}

/** An exact moment (ms or ISO string) as a wall-clock 'YYYY-MM-DDTHH:mm' in the app time zone. */
export function wallClock(moment) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(moment)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A wall-clock 'YYYY-MM-DDTHH:mm' in the app time zone as an exact moment (ms). */
export function fromWallClock(s) {
  let t = toUTC(s).getTime();
  for (let i = 0; i < 2; i++) t -= toUTC(wallClock(t)) - toUTC(s); // twice settles DST changeovers
  return t;
}

/** 'Tue, Oct 21 at 9:00 AM' for an exact moment, in the app time zone. */
export const formatMoment = (moment) => {
  const s = wallClock(moment);
  return `${relativeDay(s.slice(0, 10))} at ${formatTime(s)}`;
};

/** The app time zone's name, e.g. 'Central Daylight Time'. */
export const zoneName = (moment = Date.now()) => new Intl.DateTimeFormat(undefined, { timeZone: TZ, timeZoneName: 'long' })
  .formatToParts(new Date(moment)).find((x) => x.type === 'timeZoneName')?.value ?? TZ;
