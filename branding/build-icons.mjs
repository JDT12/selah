// Renders the branding masters (selah-icon.svg, selah-rail.svg) to every icon file Selah ships:
//   node branding/build-icons.mjs
// Needs Playwright's Chromium (npx playwright install chromium). See branding/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icon = fs.readFileSync(path.join(root, 'branding', 'selah-icon.svg'), 'utf8');
const rail = fs.readFileSync(path.join(root, 'branding', 'selah-rail.svg'), 'utf8');

// Maskable: the navy gradient fills the canvas and the fermata sits in the 80% safe zone.
const maskable = icon
  .replace(/<rect x="2" y="2" width="60" height="60" rx="14"/, '<rect x="0" y="0" width="64" height="64"')
  .replace(/<rect x="2\.75"[^>]*\/>/, '')
  .replace(/<path /, '<g transform="translate(32 34) scale(.78) translate(-32 -34)"><path ')
  .replace(/<\/svg>$/, '</g></svg>');

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const write = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); console.log(rel); };

/** An .ico holding PNG images (Windows Vista and later read these). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.data)]);
}

write('client/public/favicon.svg', icon);
write('client/public/selah-rail.svg', rail);
write('client/public/icons/icon-192.png', await png(icon, 192));
write('client/public/icons/icon-512.png', await png(icon, 512));
write('client/public/icons/maskable-512.png', await png(maskable, 512));
write('client/public/icons/apple-touch-icon.png', await png(maskable, 180));
for (const s of [16, 32, 48, 128]) write(`extension/icons/icon${s}.png`, await png(icon, s));
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const imgs = [];
for (const size of sizes) imgs.push({ size, data: await png(icon, size) });
write('desktop-app/build/icon.ico', ico(imgs));
write('desktop-app/build/icon.png', await png(icon, 512));
write('desktop-app/build/tray.png', await png(icon, 32));
await browser.close();
