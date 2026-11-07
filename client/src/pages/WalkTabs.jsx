/** Walk's tabs (9.2): Daily Walk, Reading Plans (10.2) and Prayer are one page on the rail, a tab apiece. */
export default function WalkTabs({ tab, onSection }) {
  return (
    <div className="home-tabs walk-tabs" role="tablist" aria-label="Walk">
      {[['dailywalk', 'Daily Walk'], ['plans', 'Plans'], ['prayer', 'Prayer']].map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => tab !== k && onSection?.(k)}>{l}</button>
      ))}
    </div>
  );
}
