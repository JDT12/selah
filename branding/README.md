# Selah 12 branding (Phase 5)

Picked 2026-11-06. Name and colors stay; the logo becomes a **fermata** (the musical "hold" sign, for Selah's "pause").
Rounded square (60/64, rx 14), soft gradients, tapered arch + dot. Ships in **Selah 12.0.0** with Phase 5.

| File | Use |
| --- | --- |
| `selah-icon.svg` | App identity everywhere outside the rail: favicon, PWA icons (192/512/maskable), apple-touch-icon, Windows app/taskbar/title-bar icons (Electron `.ico`), browser extension icons, sign-in/setup/About screens, Admin console. Navy gradient tile, oak-gradient fermata, light edge. |
| `selah-rail.svg` | Inside the app on the navy rail/sidebar only (`.as-brand`). Oak-to-walnut wood tile, cream fermata, no edge. |

Colors: navy `#1c2b3a` (tile top `#34506b`), oak `#93613a` (arch top `#d7a676`, dot `#c99766`→`#a06b40`),
walnut `#5a3e2b` (wood tile top `#b07a4a`), cream `#e3d6c2`–`#fffaf2`.

Maskable PWA icon: fill the whole canvas with the navy gradient and scale the fermata into the 80% safe zone.

Regenerate every icon file from the two masters: `node branding/build-icons.mjs` (needs Playwright's Chromium). Done for 12.0: favicon, PWA icons, extension icons, `client/public/selah-rail.svg` (rail logo), and Selah Desktop's `desktop-app/build/icon.ico`/`icon.png`/`tray.png`.
