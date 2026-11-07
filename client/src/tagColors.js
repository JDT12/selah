/** Tag and task list colors (the server stores the key). Modern mid tones that read on light and dark backgrounds. */
export const TAG_COLORS = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#f59e0b',
  lime: '#84cc16',
  green: '#22c55e',
  teal: '#14b8a6',
  sky: '#0ea5e9',
  blue: '#3b82f6',
  indigo: '#6366f1',
  purple: '#8b5cf6',
  pink: '#ec4899',
  gray: '#64748b',
};

export const tagColor = (key) => (key ? TAG_COLORS[key] ?? null : null);
