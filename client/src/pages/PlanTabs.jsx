/** Plan's tabs (11.0): the calendar and Attendance, like Walk's. */
export default function PlanTabs({ tab, onSection }) {
  return (
    <div className="home-tabs plan-tabs" role="tablist" aria-label="Plan">
      {[['calendar', 'Calendar'], ['attendance', 'Attendance']].map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => tab !== k && onSection?.(k)}>{l}</button>
      ))}
    </div>
  );
}
