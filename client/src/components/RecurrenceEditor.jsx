import { useMemo } from 'react';
import { RRule } from 'rrule';
import { toUTC } from '../time.js';

const FREQS = [
  { value: RRule.DAILY, label: 'day' },
  { value: RRule.WEEKLY, label: 'week' },
  { value: RRule.MONTHLY, label: 'month' },
  { value: RRule.YEARLY, label: 'year' },
];
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // rrule weekday order (0 = Monday)
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const RR_DAYS = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];

/** Facts about the start date used for sensible defaults. */
function dateInfo(dateStr) {
  const d = toUTC(dateStr);
  const weekday = (d.getUTCDay() + 6) % 7; // rrule numbering
  const day = d.getUTCDate();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return { weekday, day, nth: Math.ceil(day / 7), isLast: day + 7 > daysInMonth };
}

function parse(rule) {
  if (!rule) return null;
  try {
    const o = RRule.parseString(rule);
    const byweekday = (Array.isArray(o.byweekday) ? o.byweekday : o.byweekday != null ? [o.byweekday] : [])
      .map((w) => (typeof w === 'number' ? { weekday: w, n: undefined } : { weekday: w.weekday, n: w.n }));
    return {
      freq: o.freq,
      interval: o.interval || 1,
      weekdays: byweekday.filter((w) => !w.n).map((w) => w.weekday),
      nthDay: byweekday.find((w) => w.n) ?? null,
      until: o.until ? o.until.toISOString().slice(0, 10) : '',
      count: o.count || '',
    };
  } catch {
    return null;
  }
}

function build(s) {
  const opts = { freq: s.freq, interval: Math.max(1, Number(s.interval) || 1) };
  if (s.freq === RRule.WEEKLY && s.weekdays.length) opts.byweekday = [...s.weekdays].sort().map((d) => RR_DAYS[d]);
  if (s.freq === RRule.MONTHLY && s.nthDay) opts.byweekday = [RR_DAYS[s.nthDay.weekday].nth(s.nthDay.n)];
  if (s.until) {
    const [y, m, d] = s.until.split('-').map(Number);
    opts.until = new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
  } else if (s.count) {
    opts.count = Math.max(1, Number(s.count) || 1);
  }
  return RRule.optionsToString(opts).replace(/^RRULE:/, '');
}

export function describeRule(rule) {
  if (!rule) return '';
  try {
    const text = RRule.fromString(rule).toText();
    return text.charAt(0).toUpperCase() + text.slice(1);
  } catch {
    return 'Repeats';
  }
}

/**
 * value: RRULE string or null. startDate: 'YYYY-MM-DD' of the first occurrence.
 */
export default function RecurrenceEditor({ value, onChange, startDate }) {
  const info = useMemo(() => dateInfo(startDate), [startDate]);
  const s = parse(value);

  const set = (patch) => onChange(build({ ...s, ...patch }));

  const setFreq = (v) => {
    if (v === '') return onChange(null);
    const freq = Number(v);
    onChange(build({
      freq, interval: s?.interval ?? 1, until: s?.until ?? '', count: s?.count ?? '',
      weekdays: freq === RRule.WEEKLY ? [info.weekday] : [],
      nthDay: null,
    }));
  };

  const ends = s?.until ? 'until' : s?.count ? 'count' : 'never';
  const monthlyMode = s?.nthDay ? (s.nthDay.n === -1 ? 'last' : 'nth') : 'day';

  return (
    <div className="recur">
      <div className="recur-row">
        <select className="input input-inline" value={s ? s.freq : ''} onChange={(e) => setFreq(e.target.value)}>
          <option value="">Does not repeat</option>
          <option value={RRule.DAILY}>Daily</option>
          <option value={RRule.WEEKLY}>Weekly</option>
          <option value={RRule.MONTHLY}>Monthly</option>
          <option value={RRule.YEARLY}>Yearly</option>
        </select>
        {s && (
          <>
            <span>every</span>
            <input className="input input-num" type="number" min="1" max="99" value={s.interval}
              onChange={(e) => set({ interval: e.target.value })} />
            <span>{FREQS.find((f) => f.value === s.freq)?.label}{Number(s.interval) > 1 ? 's' : ''}</span>
          </>
        )}
      </div>

      {s?.freq === RRule.WEEKLY && (
        <div className="recur-row weekday-picker" role="group" aria-label="Repeat on">
          {DAY_LABELS.map((label, i) => {
            const on = s.weekdays.includes(i);
            return (
              <button key={i} type="button" title={DAY_NAMES[i]} aria-pressed={on} className={on ? 'is-active' : ''}
                onClick={() => {
                  const next = on ? s.weekdays.filter((d) => d !== i) : [...s.weekdays, i];
                  set({ weekdays: next.length ? next : [info.weekday] });
                }}>
                {label}
              </button>
            );
          })}
        </div>
      )}

      {s?.freq === RRule.MONTHLY && (
        <div className="recur-col">
          <label><input type="radio" checked={monthlyMode === 'day'} onChange={() => set({ nthDay: null })} /> On day {info.day}</label>
          {info.nth <= 4 && (
            <label>
              <input type="radio" checked={monthlyMode === 'nth'}
                onChange={() => set({ nthDay: { weekday: info.weekday, n: info.nth } })} />
              {' '}On the {ORDINALS[info.nth - 1]} {DAY_NAMES[info.weekday]}
            </label>
          )}
          {info.isLast && (
            <label>
              <input type="radio" checked={monthlyMode === 'last'}
                onChange={() => set({ nthDay: { weekday: info.weekday, n: -1 } })} />
              {' '}On the last {DAY_NAMES[info.weekday]}
            </label>
          )}
        </div>
      )}

      {s && (
        <div className="recur-row recur-ends">
          <span>Ends</span>
          <select className="input input-inline" value={ends} onChange={(e) => {
            const v = e.target.value;
            if (v === 'never') set({ until: '', count: '' });
            if (v === 'until') set({ until: startDate, count: '' });
            if (v === 'count') set({ until: '', count: 10 });
          }}>
            <option value="never">Never</option>
            <option value="until">On date</option>
            <option value="count">After</option>
          </select>
          {ends === 'until' && (
            <input className="input input-inline" type="date" min={startDate} value={s.until}
              onChange={(e) => e.target.value && set({ until: e.target.value })} />
          )}
          {ends === 'count' && (
            <>
              <input className="input input-num" type="number" min="1" max="999" value={s.count}
                onChange={(e) => set({ count: e.target.value })} />
              <span>times</span>
            </>
          )}
        </div>
      )}

      {s && <div className="recur-summary">↻ {describeRule(value)}</div>}
    </div>
  );
}
