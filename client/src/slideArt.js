/**
 * The built-in background art for slides (11.0), as SVG drawn in the theme's art color. Line drawings are simple
 * strokes in a 100×100 box, set large beside the text and faint; textures fill the whole slide (SVG noise, so they're
 * sharp at any size). Names and kinds are in shared/slideThemes.js.
 */

const LINES = {
  cross: '<path d="M50 6V94M28 30H72"/>',
  sunrise: '<path d="M50 18V78M37 33H63M14 78A36 36 0 0 1 86 78M4 78H96M50 32L50 32M22 52L13 46M78 52L87 46M32 38L26 30M68 38L74 30M12 66L3 64M88 66L97 64"/>',
  dove: '<path d="M14 58C30 44 46 44 56 52C62 42 76 34 92 35C82 41 76 48 72 57C67 68 55 74 42 72L27 81L31 70C22 68 17 63 14 58Z"/><path d="M50 52C46 36 36 25 22 20C30 34 37 45 46 55"/><path d="M92 35L99 31M95 33C97 29 100 28 100 28"/><circle cx="83" cy="41" r="0.9"/>',
  olive: '<path d="M10 92C34 72 58 46 90 12"/>'
    + [[24, 80, -60], [32, 72, 20], [38, 64, -55], [46, 58, 25], [52, 48, -50], [60, 42, 28], [66, 34, -45], [74, 28, 32], [80, 20, -40]]
      .map(([x, y, a]) => `<ellipse cx="${x}" cy="${y}" rx="8" ry="2.8" transform="rotate(${a} ${x} ${y})"/>`).join('')
    + '<circle cx="35" cy="78" r="2.6"/><circle cx="57" cy="54" r="2.6"/>',
  bible: '<path d="M50 30C40 23 22 23 8 28V80C22 75 40 75 50 82C60 75 78 75 92 80V28C78 23 60 23 50 30ZM50 30V82"/><path d="M16 38C26 35 36 35 43 38M16 47C26 44 36 44 43 47M16 56C26 53 36 53 43 56M16 65C26 62 36 62 43 65M57 38C64 35 74 35 84 38M57 47C64 44 74 44 84 47M57 56C64 53 74 53 84 56M57 65C64 62 74 62 84 65"/>',
  lamp: '<path d="M18 62C18 74 38 79 56 75C67 73 75 67 86 60L73 57C67 53 59 51 50 51H29C22 51 18 56 18 62Z"/><path d="M19 59C8 56 8 69 17 69"/><path d="M87 56C83 48 87 40 91 33C93 41 97 48 93 56C91 59 89 59 87 56Z"/><path d="M38 51V45H48V51M30 82H66"/>',
  wheat: '<path d="M50 96V14M50 96C44 84 38 78 30 74M50 96C56 84 62 78 70 74"/>'
    + [18, 28, 38, 48, 58].map((y) => `<ellipse cx="44" cy="${y + 4}" rx="3.2" ry="6.5" transform="rotate(-28 44 ${y + 4})"/><ellipse cx="56" cy="${y}" rx="3.2" ry="6.5" transform="rotate(28 56 ${y})"/>`).join('')
    + '<path d="M50 14L50 4M44 18L38 8M56 14L62 4"/>',
  mountains: '<path d="M0 84L28 42L42 60L60 30L100 84"/><path d="M53 41L60 30L67 41L62 38L57 42Z"/><path d="M22 51L28 42L33 50"/><path d="M0 92C20 88 40 90 60 87S90 88 100 86"/><circle cx="80" cy="22" r="7"/>',
  waves: [44, 58, 72, 86].map((y, i) => `<path d="M${-10 + i * 4} ${y}C2 ${y - 9} 14 ${y - 9} 26 ${y}S50 ${y + 9} 62 ${y}S86 ${y - 9} 98 ${y}S122 ${y + 9} 134 ${y}"/>`).join(''),
  vine: '<path d="M6 10C30 18 40 34 44 52C48 70 62 80 92 86"/><path d="M24 18C26 10 34 8 38 12C34 16 30 20 24 18Z"/><path d="M40 36C46 30 54 32 54 38C48 40 44 40 40 36Z"/><path d="M58 70C62 62 70 62 72 68C66 72 62 72 58 70Z"/><path d="M30 26C26 30 26 34 30 36"/>'
    + [[50, 54], [56, 54], [53, 59], [59, 59], [47, 59], [50, 64], [56, 64], [53, 69]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join(''),
  bread: '<path d="M8 74C8 58 22 50 34 50C46 50 58 58 58 74Z"/><path d="M20 58L26 66M32 54L36 64M44 56L46 66M4 78H62"/><path d="M64 26H90C90 44 84 52 77 54V74M66 78H88M77 54C70 52 64 44 64 26"/>',
  star: '<path d="M50 6V94M14 46H86M28 24L72 68M72 24L28 68"/><path d="M50 30L54 42L66 46L54 50L50 62L46 50L34 46L46 42Z"/>',
  staff: '<path d="M44 96V32C44 14 70 12 72 30C73 39 64 42 60 36"/><path d="M40 70H48"/>',
  tree: '<path d="M50 94V58M50 74L38 62M50 68L62 56M50 82L58 76"/><path d="M50 12C34 12 24 22 26 34C16 38 16 54 28 58C34 66 46 64 50 58C56 64 68 66 74 58C86 54 86 38 76 34C78 22 68 12 50 12Z"/><path d="M30 94H70"/>',
  candle: '<path d="M40 44H60V92H40Z"/><path d="M50 44V38"/><path d="M50 36C45 30 47 22 50 14C53 22 55 30 50 36Z"/><circle cx="50" cy="28" r="14"/><path d="M34 92H66M44 52V70"/>',
  road: '<path d="M8 96C34 72 44 52 48 34M92 96C66 72 56 52 52 34M50 92V84M50 74V66M50 57V52M50 45V42M0 34H100"/><circle cx="50" cy="20" r="8"/><path d="M50 6V9M36 12L38 14M64 12L62 14"/>',
  anchor: '<circle cx="50" cy="15" r="7"/><path d="M50 22V90M34 34H66M16 62C18 80 34 90 50 90C66 90 82 80 84 62M16 62L10 70M16 62L24 68M84 62L90 70M84 62L76 68"/>',
  fish: '<path d="M8 32C30 68 62 74 92 50C62 26 30 32 8 68"/><circle cx="76" cy="47" r="1.4"/>',
  crown: '<path d="M16 72L22 34L38 54L50 26L62 54L78 34L84 72Z"/><path d="M14 82H86M16 72H84"/><circle cx="22" cy="31" r="3"/><circle cx="50" cy="22" r="3"/><circle cx="78" cy="31" r="3"/>',
  sheep: '<path d="M26 56C20 54 18 46 24 42C24 34 34 30 40 34C44 26 56 26 60 32C66 28 76 32 76 40C84 42 84 54 76 56C74 64 64 66 58 62C52 68 40 68 36 62C30 64 24 62 26 56Z"/><path d="M76 42C82 36 92 38 92 46C92 52 86 56 80 54"/><path d="M36 64V80M46 66V82M60 64V80M70 62V78"/><circle cx="86" cy="45" r="0.9"/>',
};

let uid = 0;
/** Textures: SVG filters over the whole slide, in the art color. */
function texture(id, color) {
  const n = `t${(uid++).toString(36)}`;
  const tint = `<feFlood flood-color="${color}"/><feComposite in2="a" operator="in"/>`;
  switch (id) {
    case 'grain':
      return `<filter id="${n}"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.6 1.1" result="a"/>${tint}</filter><rect width="1600" height="900" filter="url(#${n})" opacity="0.55"/>`;
    case 'paper':
      return `<filter id="${n}"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.09" numOctaves="3" seed="8"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.4 1.25" result="a"/>${tint}</filter><rect width="1600" height="900" filter="url(#${n})" opacity="0.6"/>`;
    case 'linen':
      return `<defs><pattern id="${n}" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 1.5H6M0 4.5H6" stroke="${color}" stroke-width="0.7" opacity="0.5"/><path d="M1.5 0V6M4.5 0V6" stroke="${color}" stroke-width="0.6" opacity="0.35"/></pattern>`
        + `<filter id="${n}f"><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="2"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.4 1.2" result="a"/>${tint}</filter></defs>`
        + `<rect width="1600" height="900" fill="url(#${n})" opacity="0.45"/><rect width="1600" height="900" filter="url(#${n}f)" opacity="0.18"/>`;
    case 'parchment':
      return `<defs><filter id="${n}"><feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="4" seed="11"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.8 1.05" result="a"/>${tint}</filter>`
        + `<radialGradient id="${n}v" cx="50%" cy="50%" r="75%"><stop offset="0.55" stop-color="${color}" stop-opacity="0"/><stop offset="1" stop-color="${color}" stop-opacity="0.55"/></radialGradient></defs>`
        + `<rect width="1600" height="900" filter="url(#${n})" opacity="0.35"/><rect width="1600" height="900" fill="url(#${n}v)"/>`;
    case 'watercolor':
      return `<defs><filter id="${n}" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="5"/><feDisplacementMap in="SourceGraphic" scale="120"/><feGaussianBlur stdDeviation="14"/></filter></defs>`
        + `<g filter="url(#${n})" fill="${color}"><ellipse cx="1440" cy="120" rx="360" ry="260" opacity="0.45"/><ellipse cx="1520" cy="520" rx="200" ry="300" opacity="0.25"/><ellipse cx="120" cy="840" rx="380" ry="200" opacity="0.35"/></g>`;
    case 'wash':
      return `<defs><radialGradient id="${n}a" cx="100%" cy="0%" r="70%"><stop offset="0" stop-color="${color}" stop-opacity="0.5"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`
        + `<radialGradient id="${n}b" cx="0%" cy="100%" r="65%"><stop offset="0" stop-color="${color}" stop-opacity="0.4"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>`
        + `<rect width="1600" height="900" fill="url(#${n}a)"/><rect width="1600" height="900" fill="url(#${n}b)"/>`;
    default:
      return '';
  }
}

export const isTexture = (id) => ['grain', 'paper', 'linen', 'parchment', 'watercolor', 'wash'].includes(id);

/** The art as an SVG string in `color` (null for an unknown id). */
export function artSvg(id, color = '#93613a') {
  if (LINES[id]) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" preserveAspectRatio="xMaxYMax meet">${LINES[id]}</svg>`;
  }
  const t = texture(id, color);
  return t ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="none">${t}</svg>` : null;
}

/** The art drawn on a canvas as a PNG data URL (for PowerPoint): a texture slide-sized, a line drawing square. */
export async function artPng(id, color, { width = 1920 } = {}) {
  const svg = artSvg(id, color);
  if (!svg) return null;
  const tex = isTexture(id);
  const w = tex ? width : Math.round(width * 0.5);
  const h = tex ? Math.round(width * 9 / 16) : w;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('<svg ', `<svg width="${w}" height="${h}" `))}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/png');
}
