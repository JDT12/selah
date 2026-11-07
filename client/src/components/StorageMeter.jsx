import { useEffect, useState } from 'react';
import { api, formatSize } from '../api.js';

/** Used vs. total space on the notes disk, split into notes data and everything else. */
export default function StorageMeter() {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => api.storage().then(setS, (e) => setError(e.message));
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  if (error) return <p className="card-empty">Couldn’t read storage: {error}</p>;
  if (!s) return <div className="storage-meter is-loading" />;

  const notes = s.database + s.attachments;
  const other = Math.max(0, s.used - notes);
  const pct = (n) => (s.capacity ? (n / s.capacity) * 100 : 0);
  const usedPct = pct(s.used);
  const level = usedPct >= 90 ? 'is-full' : usedPct >= 80 ? 'is-high' : '';
  // Keep a sliver visible for small but non-zero amounts.
  const width = (n) => (n > 0 ? `max(3px, ${pct(n)}%)` : 0);

  return (
    <div className={`storage-meter ${level}`}>
      <div className="storage-summary">
        <span><strong>{formatSize(s.used)}</strong> <span className="muted">of {formatSize(s.capacity)} used</span></span>
        <span className="storage-pct">{usedPct < 1 && s.used > 0 ? '<1' : Math.round(usedPct)}%</span>
      </div>
      <div className="storage-bar" role="meter" aria-label={s.quota ? 'Your storage used' : 'Notes storage used'}
        aria-valuemin={0} aria-valuemax={s.capacity} aria-valuenow={s.used}
        aria-valuetext={`${formatSize(s.used)} of ${formatSize(s.capacity)} used`}>
        <span className="storage-seg is-notes" style={{ width: width(notes) }} />
        <span className="storage-seg is-other" style={{ width: width(other) }} />
      </div>
      <ul className="storage-legend">
        <li><span className="storage-dot is-notes" />Notes &amp; attachments <span className="muted">{formatSize(notes)}</span></li>
        {!s.quota && <li><span className="storage-dot is-other" />Other <span className="muted">{formatSize(other)}</span></li>}
        <li><span className="storage-dot is-free" />Free <span className="muted">{formatSize(s.free)}</span></li>
      </ul>
      {level && <p className="storage-warning">{s.quota ? 'Your storage' : 'The notes disk'} is {level === 'is-full' ? 'almost full' : 'filling up'}.{s.quota ? ' Delete attachments you don’t need, or ask your Selah host for more space.' : ''}</p>}
    </div>
  );
}
