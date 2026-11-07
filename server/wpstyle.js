import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { safeFetch } from './netguard.js';

/**
 * The connected site's look, for the dashboard widget: the Lampstand theme's color and font
 * tokens (read from its inline stylesheet, so a scheme changed under Appearance follows along),
 * the site icon and the tagline. Other themes get no tokens and the widget falls back to
 * Lampstand's original scheme.
 *
 * The theme's Google Fonts are served through this server (fetched once, kept on disk): the
 * app's Content-Security-Policy only allows its own fonts and images, and it keeps the
 * dashboard working offline.
 */

const TTL = 6 * 3600_000;
const TIMEOUT = 15_000;
const fontDir = path.join(config.dataDir, 'wp-fonts');
const mapPath = path.join(fontDir, 'map.json');
// Google Fonts picks the font format from the browser; ask as a current Chrome to get woff2.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const COLOR_TOKENS = ['ink', 'lapis', 'walnut', 'oak', 'sand', 'page', 'line', 'muted', 'paper', 'on-primary'];
const FONT_TOKENS = ['font-display', 'font-text', 'font-ui'];
const isColor = (v) => /^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\([\d\s.,%]+\)$/i.test(v);
const isFontStack = (v) => v.length <= 200 && /^[\w\s"',.-]+$/.test(v);

let cache = null; // { site, at, style, css }

const get = async (url, opts = {}) => {
  const res = await safeFetch(url, { signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow', ...opts });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res;
};

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map((m) => [m[1].toLowerCase(), m[3]]));
const unescapeAttr = (s) => s.replace(/&#0?38;|&amp;/g, '&');

/** The best icon the page links to, as a data: URL (SVG first, then the largest small PNG). */
async function siteIcon(html, base) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]))
    .filter((a) => /(^|\s)icon(\s|$)/i.test(a.rel ?? '') && a.href);
  const size = (a) => Number(/^(\d+)x/.exec(a.sizes ?? '')?.[1] ?? 0);
  links.sort((a, b) => (b.type === 'image/svg+xml') - (a.type === 'image/svg+xml') || size(b) - size(a));
  for (const a of links) {
    try {
      const url = new URL(unescapeAttr(a.href), base);
      if (url.protocol !== 'https:') continue;
      const res = await get(url);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!/^image\/(svg\+xml|png|x-icon|vnd\.microsoft\.icon|webp)$/.test(type)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 200_000) continue;
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch { /* try the next one */ }
  }
  return null;
}

const fontName = (url) => `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}.woff2`;

function loadMap() {
  try { return JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch { return {}; }
}

/** The theme's Google Fonts stylesheet with every font file pointed at this server. */
async function fontsCss(href) {
  const url = new URL(href);
  if (url.hostname !== 'fonts.googleapis.com') return null;
  const css = await (await get(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/css' } })).text();
  const map = loadMap();
  const out = css.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g, (m, src) => {
    const name = fontName(src);
    map[name] = src;
    return `url(/api/wordpress/fonts/${name})`;
  });
  fs.mkdirSync(fontDir, { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(map));
  return out;
}

/** Read the site's look; cached for a few hours (fresh = true reads it again). tagline() gives the site's own. Never throws. */
export async function siteStyle(conn, { fresh = false, tagline = async () => null } = {}) {
  if (!fresh && cache?.site === conn.site && Date.now() - cache.at < TTL) return cache.style;
  const style = { theme: null, tokens: {}, displayWeight: null, icon: null, tagline: await tagline().catch(() => null), fonts: false };
  let css = null;
  try {
    const html = (await (await get(`${conn.site}/`, { headers: { Accept: 'text/html' } })).text()).slice(0, 3_000_000);
    const inline = /<style[^>]*id=["']lampstand-inline-css["'][^>]*>([\s\S]*?)<\/style>/i.exec(html)?.[1];
    if (inline) {
      style.theme = 'lampstand';
      for (const [, name, raw] of inline.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) {
        const value = raw.trim();
        if (COLOR_TOKENS.includes(name) && isColor(value)) style.tokens[name] = value;
        if (FONT_TOKENS.includes(name) && isFontStack(value)) style.tokens[name] = value;
        if (name === 'display-weight' && /^\d{3}$/.test(value)) style.displayWeight = Number(value);
      }
      const fontLink = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]))
        .find((a) => /fonts\.googleapis\.com\/css2?\?/.test(a.href ?? ''));
      if (fontLink) {
        try { css = await fontsCss(unescapeAttr(fontLink.href)); } catch { /* the widget falls back to similar local fonts */ }
      }
    }
    style.icon = await siteIcon(html, `${conn.site}/`);
    if (!style.tagline) {
      const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0])).find((a) => a.name === 'description');
      if (meta?.content) style.tagline = meta.content;
    }
  } catch {
    if (cache?.site === conn.site) return cache.style; // keep the last good look through a network blip
  }
  style.fonts = !!css;
  if (css) style.fontsVersion = crypto.createHash('sha256').update(css).digest('hex').slice(0, 10);
  cache = { site: conn.site, at: Date.now(), style, css };
  return style;
}

export const cachedFontsCss = () => cache?.css ?? null;

/** A font file, from disk or fetched from Google once. Returns the path, or null if unknown. */
export async function fontFile(name) {
  if (!/^[0-9a-f]{24}\.woff2$/.test(name)) return null;
  const file = path.join(fontDir, name);
  if (fs.existsSync(file)) return file;
  const src = loadMap()[name];
  if (!src?.startsWith('https://fonts.gstatic.com/')) return null;
  const buf = Buffer.from(await (await get(src)).arrayBuffer());
  fs.mkdirSync(fontDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, buf);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}
