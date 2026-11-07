/**
 * Slide themes (11.0): each a palette, a pair of fonts and (maybe) a piece of background art from the built-in set.
 * A deck picks a theme, and can change its colors (another theme's, the brand's or its own), fonts and art; 'brand' is your church's own theme (Utility → Media →
 * Church brand), built from its colors. Shared by the browser (drawing) and the server (checking what's saved).
 *
 * Palette: bg and bg2 (the background's top and bottom), text, muted, accent (current point, rules, verse numbers),
 * head (headings), art (the background art's color).
 */

export const THEMES = [
  { id: 'light', name: 'Lamplight', fonts: 'classic', art: null,
    palette: { bg: '#fbfaf7', bg2: '#f5f0e8', text: '#1c2b3a', muted: '#5b6875', accent: '#93613a', head: '#2f5d86', art: '#93613a' } },
  { id: 'dark', name: 'Lamplight Dark', fonts: 'classic', art: null,
    palette: { bg: '#16222f', bg2: '#10171f', text: '#f1ece2', muted: '#a9b5c1', accent: '#f3c870', head: '#ffffff', art: '#f3c870' } },
  { id: 'parchment', name: 'Parchment', fonts: 'serif', art: 'parchment',
    palette: { bg: '#f4ead5', bg2: '#e9d9b8', text: '#3b2f22', muted: '#6e5d48', accent: '#8a5a2b', head: '#4a3424', art: '#8a5a2b' } },
  { id: 'linen', name: 'Linen', fonts: 'serif', art: 'linen',
    palette: { bg: '#f3f1ec', bg2: '#e7e3da', text: '#262b30', muted: '#646c74', accent: '#5c7f6a', head: '#1f3a4a', art: '#5c7f6a' } },
  { id: 'dawn', name: 'Dawn', fonts: 'elegant', art: 'watercolor',
    palette: { bg: '#fdf4ec', bg2: '#f6e0d0', text: '#3a2a2a', muted: '#7a6058', accent: '#c46a3c', head: '#6b2f2a', art: '#d98a5f' } },
  { id: 'forest', name: 'Forest', fonts: 'elegant', art: 'olive',
    palette: { bg: '#20332a', bg2: '#15221c', text: '#edf2ea', muted: '#b7c7b9', accent: '#d8b55b', head: '#f6f3e7', art: '#d8b55b' } },
  { id: 'slate', name: 'Slate', fonts: 'modern', art: 'grain',
    palette: { bg: '#2d3744', bg2: '#1f262f', text: '#eef1f4', muted: '#b4bec8', accent: '#7fb8d9', head: '#ffffff', art: '#7fb8d9' } },
  { id: 'midnight', name: 'Midnight', fonts: 'bold', art: 'mountains',
    palette: { bg: '#101a30', bg2: '#070b16', text: '#e8ecf6', muted: '#9aa6c4', accent: '#9db7ff', head: '#ffffff', art: '#9db7ff' } },
];
export const THEME_IDS = [...THEMES.map((t) => t.id), 'brand'];

/**
 * Font pairs: headings and text. Each family is bundled with Selah (fontsource, SIL Open Font License), so a slide
 * looks the same on every screen; the PowerPoint file names the same fonts.
 */
export const FONT_PAIRS = [
  { id: 'classic', name: 'Classic', head: { family: 'Cormorant Garamond', weight: 600, style: 'italic' }, body: { family: 'Inter', weight: 400 } },
  { id: 'serif', name: 'Book', head: { family: 'Lora', weight: 700 }, body: { family: 'Lora', weight: 400 } },
  { id: 'elegant', name: 'Elegant', head: { family: 'Playfair Display', weight: 700 }, body: { family: 'Source Serif 4', weight: 400 } },
  { id: 'modern', name: 'Modern', head: { family: 'Montserrat', weight: 700 }, body: { family: 'Inter', weight: 400 } },
  { id: 'bold', name: 'Bold', head: { family: 'Oswald', weight: 600, upper: true }, body: { family: 'Source Serif 4', weight: 400 } },
  { id: 'clean', name: 'Clean', head: { family: 'Inter', weight: 700 }, body: { family: 'Inter', weight: 400 } },
];
export const FONT_IDS = FONT_PAIRS.map((f) => f.id);

/** The built-in background art: line drawings (beside the text) and textures (the whole slide). See client/src/slideArt.js. */
export const ART = [
  ['cross', 'Cross', 'line'], ['sunrise', 'Cross at sunrise', 'line'], ['dove', 'Dove', 'line'], ['olive', 'Olive branch', 'line'],
  ['bible', 'Open Bible', 'line'], ['lamp', 'Oil lamp', 'line'], ['wheat', 'Wheat', 'line'], ['mountains', 'Mountains', 'line'],
  ['waves', 'Waves', 'line'], ['vine', 'Vine', 'line'], ['bread', 'Bread and cup', 'line'], ['star', 'Star', 'line'],
  ['staff', 'Shepherd’s staff', 'line'], ['tree', 'Tree', 'line'], ['candle', 'Candle', 'line'], ['road', 'Road', 'line'],
  ['anchor', 'Anchor', 'line'], ['fish', 'Fish', 'line'], ['crown', 'Crown', 'line'], ['sheep', 'Sheep', 'line'],
  ['parchment', 'Parchment', 'texture'], ['linen', 'Linen', 'texture'], ['watercolor', 'Watercolor', 'texture'],
  ['grain', 'Grain', 'texture'], ['paper', 'Paper fibers', 'texture'], ['wash', 'Soft corners', 'texture'],
].map(([id, name, kind]) => ({ id, name, kind }));
export const ART_IDS = ART.map((a) => a.id);

const hex = (c) => /^#[0-9a-f]{6}$/i.test(c ?? '');
/** A color between two (t from 0 to 1). */
export function mix(a, b, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** A church's brand as a palette: { primary, secondary, accent, base: 'light' | 'dark' | 'color' }. */
export function brandPalette(brand = {}) {
  const primary = hex(brand.primary) ? brand.primary : '#2f5d86';
  const secondary = hex(brand.secondary) ? brand.secondary : primary;
  const accent = hex(brand.accent) ? brand.accent : secondary;
  if (brand.base === 'dark') return { bg: '#171b22', bg2: '#0e1116', text: '#f2f3f5', muted: '#a6adb8', accent, head: '#ffffff', art: secondary };
  if (brand.base === 'color') return { bg: primary, bg2: mix(primary, '#000000', 0.28), text: '#ffffff', muted: mix(primary, '#ffffff', 0.72), accent, head: '#ffffff', art: '#ffffff' };
  return { bg: '#ffffff', bg2: '#f4f4f1', text: '#1f2933', muted: '#6b7280', accent, head: primary, art: secondary };
}

/**
 * A deck's own colors as a palette: { bg, text, accent } picked, the rest worked out from them (the bottom of the
 * background a little darker, muted text between the text and the background, headings in the text color).
 */
export function customPalette(c = {}) {
  const bg = hex(c.bg) ? c.bg : '#ffffff';
  const text = hex(c.text) ? c.text : (isDark(bg) ? '#f2f3f5' : '#1f2933');
  const accent = hex(c.accent) ? c.accent : '#2f5d86';
  return { bg, bg2: mix(bg, '#000000', isDark(bg) ? 0.3 : 0.05), text, muted: mix(text, bg, 0.38), accent, head: text, art: accent };
}

/** The palette a colors id names: a theme's, the brand's, or 'custom' (the deck's own). */
export function namedPalette(id, brand = null, custom = null) {
  if (id === 'custom') return customPalette(custom ?? {});
  if (id === 'brand') return brandPalette(brand ?? {});
  return (THEMES.find((t) => t.id === id) ?? THEMES[0]).palette;
}
export const COLOR_IDS = [...THEME_IDS, 'custom'];

/** What a deck looks like: { palette, fonts (a FONT_PAIRS entry), art (id or null), theme }. */
export function deckLook(deck = {}, brand = null) {
  const theme = deck.theme === 'brand' ? null : THEMES.find((t) => t.id === deck.theme) ?? THEMES[0];
  const palette = COLOR_IDS.includes(deck.colors) ? namedPalette(deck.colors, brand, deck.custom) : theme ? theme.palette : brandPalette(brand ?? {});
  const fontsId = deck.fonts ?? (theme ? theme.fonts : brand?.fonts) ?? 'classic';
  const fonts = FONT_PAIRS.find((f) => f.id === fontsId) ?? FONT_PAIRS[0];
  const art = deck.art === undefined ? (theme ? theme.art : brand?.art ?? null) : deck.art;
  return { palette, fonts, art: ART_IDS.includes(art) ? art : null, theme: theme?.id ?? 'brand' };
}

/** Is the background dark (so pictures and the editor know what's on top)? */
export function isDark(color) {
  if (!hex(color)) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}
