/** A progress ring: `value` of `max`, with a label in the middle (the percent unless given). */
export default function Ring({ value, max, label, size = 44 }) {
  const pct = max ? Math.min(1, value / max) : 0;
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="desk-ring" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(pct * 100)} percent`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="desk-ring-track" />
        <circle cx={size / 2} cy={size / 2} r={r} className="desk-ring-fill" strokeDasharray={`${pct * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="desk-ring-label">{label ?? `${Math.round(pct * 100)}%`}</span>
    </span>
  );
}
