import { formatLongDate, nowParts } from '../time.js';
import { DESK_TABS } from '../studyPlans.js';

/** "Good morning" by the hour. */
export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * Home's header and tabs (7.1). 11.0: Home's Study, Teach, Write and Learn tabs show only the work that's still
 * active (Desk, on the rail, has all of it). `counts` is the active work on each tab; `actions` go on the right.
 */
export default function HomeTabs({ tab, today, counts = {}, onPick, actions }) {
  const date = today ?? nowParts().date;
  return (
    <>
      <header className="home-head">
        <div className="home-title">
          <p className="muted">{formatLongDate(date)}</p>
          <h1>{greeting()}</h1>
        </div>
        {actions}
      </header>
      <div className="home-tabs" role="tablist" aria-label="Home">
        {[{ key: 'home', label: 'Home' }, ...DESK_TABS].map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'is-active' : ''} onClick={() => onPick(t.key)}>
            {t.label}{counts[t.key] > 0 && <span className="home-tab-count">{counts[t.key]}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
