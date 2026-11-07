import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { alert } from './store.js';

/**
 * The monthly server maintenance reminder (patching the operating system under Selah), and the server's patch status.
 *
 * The schedule is a week of the month (1st–4th or last) and a weekday, the last Tuesday unless changed. From LEAD_DAYS
 * before it the console shows a notice; from the day itself a banner, until maintenance is marked done. Marking it
 * done any time from the start of the notice counts for that month. Dates are calendar days in the console's time zone.
 *
 * Settings: maintenance_schedule { week, weekday }, maintenance_log [{ at, date, checks, note }] (newest first),
 * maintenance_since (the day the reminder started, so months before it are never "overdue"), maintenance_snooze
 * { cycle, until }, patch_flags { rebootSince, securitySince } (when each problem was first seen).
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
export const LEAD_DAYS = 7;
const DEFAULT_SCHEDULE = { week: 'last', weekday: 2 };
export const CHECKS = [
  { key: 'backup', label: 'The host backup is recent (or run Back up now first)' },
  { key: 'stop', label: 'Stopped Selah everywhere', command: 'npm run admin -- maintenance-stop' },
  { key: 'upgrade', label: 'Installed updates', command: 'sudo apt update && sudo apt full-upgrade' },
  { key: 'reboot', label: 'Rebooted, if the server asked for it (everything starts by itself), or started Selah again', command: 'sudo reboot   # or: npm run admin -- maintenance-start' },
  { key: 'tenants', label: 'Every tenant is answering again' },
  { key: 'restore', label: 'Test-restored a tenant (Backups)' },
];
const KEEP_LOG = 36;

const readJson = (key, fallback) => { try { return JSON.parse(getSetting(key) ?? 'null') ?? fallback; } catch { return fallback; } };

// ---------- calendar days (as "YYYY-MM-DD", worked on as UTC dates) ----------

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const toStr = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return toStr(d); };
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86_400_000);
/** Today (or the day of `ms`) in the console's time zone. */
export const localDay = (ms = Date.now(), timeZone = config.timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

/** The maintenance day in a month (month 0–11; either may run over, e.g. month -1 or 12). */
export function dueIn(year, month, { week, weekday }) {
  const first = new Date(Date.UTC(year, month, 1));
  if (week === 'last') {
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - weekday + 7) % 7));
    return toStr(d);
  }
  first.setUTCDate(1 + ((weekday - first.getUTCDay() + 7) % 7) + (week - 1) * 7);
  return toStr(first);
}

/**
 * Where maintenance stands on `today`: the month's maintenance day it's about (`cycle`), whether it's been done, and
 * the stage: 'done' (`due` is then next month's day), 'soon' (within LEAD_DAYS), 'today' or 'overdue'.
 */
export function maintenanceState({ today, schedule, log = [], since = today, snooze = null }) {
  const [y, m] = today.split('-').map(Number);
  const thisMonth = dueIn(y, m - 1, schedule);
  const cycle = today < addDays(thisMonth, -LEAD_DAYS) ? dueIn(y, m - 2, schedule) : thisMonth;
  const lastDone = log[0]?.date ?? null;
  const done = (lastDone && lastDone >= addDays(cycle, -LEAD_DAYS)) || cycle < since;
  const [cy, cm] = cycle.split('-').map(Number);
  const following = dueIn(cy, cm, schedule);
  // Done (or before the reminder started): nothing until the next month's notice.
  if (done) return { stage: 'done', cycle, due: following, days: daysBetween(today, following), lastDone, snoozed: null };
  const days = daysBetween(today, cycle);
  const stage = days > 0 ? 'soon' : days === 0 ? 'today' : 'overdue';
  const snoozed = snooze?.cycle === cycle && today < snooze.until ? snooze.until : null;
  return { stage, cycle, due: cycle, days, lastDone, snoozed };
}

// ---------- settings ----------

export const schedule = () => ({ ...DEFAULT_SCHEDULE, ...readJson('maintenance_schedule', {}) });
export const maintenanceLog = () => readJson('maintenance_log', []);

function since() {
  let s = getSetting('maintenance_since');
  if (!s) { s = localDay(); setSetting('maintenance_since', s); }
  return s;
}

export function currentState(now = Date.now()) {
  const today = localDay(now);
  return { today, ...maintenanceState({ today, schedule: schedule(), log: maintenanceLog(), since: since(), snooze: readJson('maintenance_snooze', null) }) };
}

export function saveSchedule({ week, weekday }) {
  const w = week === 'last' ? 'last' : Number(week);
  if (w !== 'last' && ![1, 2, 3, 4].includes(w)) throw httpError(400, 'Pick the 1st, 2nd, 3rd, 4th or last week.');
  const d = Number(weekday);
  if (!Number.isInteger(d) || d < 0 || d > 6) throw httpError(400, 'Pick a day of the week.');
  setSetting('maintenance_schedule', JSON.stringify({ week: w, weekday: d }));
  return schedule();
}

export function markDone({ checks = {}, note = '' } = {}) {
  const entry = {
    at: Date.now(),
    date: localDay(),
    checks: Object.fromEntries(CHECKS.map((c) => [c.key, !!checks[c.key]])),
    note: String(note ?? '').trim().slice(0, 2000),
  };
  setSetting('maintenance_log', JSON.stringify([entry, ...maintenanceLog()].slice(0, KEEP_LOG)));
  setSetting('maintenance_snooze', 'null');
  patchCache = null; // updates were probably just installed
  return entry;
}

/** Hides the banner until `until` (a day, at most 21 days ahead); the Overview still shows it. */
export function snooze(until) {
  const s = currentState();
  const today = localDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(until)) || until <= today || until > addDays(today, 21)) throw httpError(400, 'Snooze to a day in the next three weeks.');
  setSetting('maintenance_snooze', JSON.stringify({ cycle: s.cycle, until }));
  return currentState();
}

// ---------- the server's patch status (Ubuntu/Debian; null elsewhere) ----------

const PATCH_EVERY = 30 * 60_000;
let patchCache = null;

const aptCheck = () => new Promise((resolve) => {
  // apt-check prints "<updates>;<security updates>" to stderr.
  execFile('/usr/lib/update-notifier/apt-check', [], { timeout: 120_000 }, (err, stdout, stderr) => {
    const m = String(stderr).trim().match(/^(\d+);(\d+)$/m);
    resolve(m ? { updates: Number(m[1]), security: Number(m[2]) } : null);
  });
});

/** The newest "Start-Date:" in apt's history (this month's log, else last month's), as ms. */
function lastAptRun() {
  for (const f of ['/var/log/apt/history.log', '/var/log/apt/history.log.1']) {
    try {
      const dates = fs.readFileSync(f, 'utf8').match(/^Start-Date: (\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/gm);
      if (dates?.length) {
        const [, d, t] = dates.at(-1).match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        return new Date(`${d}T${t}`).getTime(); // apt writes the server's local time
      }
    } catch { /* not there */ }
  }
  return null;
}

function osName() {
  try { return fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? null; } catch { return null; }
}

function unattended() {
  try {
    const conf = fs.readFileSync('/etc/apt/apt.conf.d/20auto-upgrades', 'utf8');
    return /APT::Periodic::Unattended-Upgrade\s+"1"/.test(conf);
  } catch { return null; }
}

let checking = null;
/** The cached status; a stale one is returned as it is while a new check runs (apt-check takes a second or two). */
export async function patchStatus({ fresh = false } = {}) {
  if (process.platform !== 'linux') return null;
  if (!fresh && patchCache && Date.now() - patchCache.checkedAt < PATCH_EVERY) return patchCache;
  checking ??= checkPatches().finally(() => { checking = null; });
  return fresh || !patchCache ? checking : patchCache;
}

async function checkPatches() {
  const reboot = fs.existsSync('/var/run/reboot-required');
  let rebootPackages = [];
  try { rebootPackages = [...new Set(fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8').split('\n').filter(Boolean))]; } catch { /* none */ }
  const apt = fs.existsSync('/usr/lib/update-notifier/apt-check') ? await aptCheck() : null;
  patchCache = {
    checkedAt: Date.now(),
    os: osName(), kernel: os.release(),
    updates: apt?.updates ?? null, security: apt?.security ?? null,
    rebootRequired: reboot, rebootPackages,
    bootedAt: Date.now() - os.uptime() * 1000,
    lastAptRun: lastAptRun(),
    unattended: unattended(),
  };
  return patchCache;
}

// ---------- alerts (from the monitor, once a minute) ----------

const DAY = 86_400_000;

export async function checkMaintenance() {
  const s = currentState();
  if (s.stage === 'today') alert(null, 'warning', `maintenance:${s.cycle}`, `Server maintenance is due today: install updates and reboot if needed, then mark it done (Overview).`, { quiet: 60 * DAY });
  if (s.stage === 'overdue' && s.days <= -LEAD_DAYS) alert(null, 'danger', `maintenance-overdue:${s.cycle}`, `Server maintenance is ${-s.days} days overdue (it was due ${s.cycle}).`, { quiet: 60 * DAY });

  // Between maintenance days: a reboot or security updates left waiting more than three days.
  const p = await patchStatus();
  if (!p) return;
  const flags = readJson('patch_flags', {});
  const next = {
    rebootSince: p.rebootRequired ? (flags.rebootSince ?? Date.now()) : null,
    securitySince: p.security > 0 ? (flags.securitySince ?? Date.now()) : null,
  };
  if (JSON.stringify(next) !== JSON.stringify(flags)) setSetting('patch_flags', JSON.stringify(next));
  if (next.rebootSince && Date.now() - next.rebootSince > 3 * DAY) {
    alert(null, 'warning', 'reboot-required', `The server has needed a reboot for ${Math.floor((Date.now() - next.rebootSince) / DAY)} days${p.rebootPackages.length ? ` (${p.rebootPackages.slice(0, 4).join(', ')})` : ''}.`, { quiet: 3 * DAY });
  }
  if (next.securitySince && Date.now() - next.securitySince > 3 * DAY) {
    alert(null, 'warning', 'security-updates', `${p.security} security update${p.security === 1 ? ' has' : 's have'} been waiting for more than three days. Automatic updates may have stopped.`, { quiet: 3 * DAY });
  }
}

export async function maintenanceInfo({ fresh = false } = {}) {
  return { ...currentState(), schedule: schedule(), leadDays: LEAD_DAYS, checks: CHECKS, log: maintenanceLog(), patch: await patchStatus({ fresh }) };
}
