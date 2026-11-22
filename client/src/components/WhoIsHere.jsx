/** 14.3: the others with this note (or builder) open, live co-editing: small circles in their cursor colors. */
const initials = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export default function WhoIsHere({ peers }) {
  const shown = peers.slice(0, 4);
  const label = peers.map((p) => [p.name, p.device].filter(Boolean).join(' on ') || 'Someone').join(', ');
  return (
    <span className="who-here" role="status" aria-label={`Also here: ${label}`} title={`Also here: ${label}`}>
      {shown.map((p) => (
        <span key={p.id} className="who-here-dot" style={{ backgroundColor: p.color }}>{initials(p.name) || initials(p.device) || '?'}</span>
      ))}
      {peers.length > shown.length && <span className="who-here-more">+{peers.length - shown.length}</span>}
    </span>
  );
}
