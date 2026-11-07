// electron-builder leaves node_modules out of extraResources, so the local server's packages are copied in here
// (before signing, so on a Mac ffmpeg is signed with the app). A Mac build of each architecture gets that
// architecture's ffmpeg (stage.mjs fetched both).
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(ctx) {
  const stage = path.join(__dirname, '..', 'stage');
  const from = path.join(stage, 'server', 'node_modules');
  const mac = ctx.electronPlatformName === 'darwin';
  const resources = mac
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const to = path.join(resources, 'server', 'node_modules');
  if (!fs.existsSync(from)) throw new Error('stage/server/node_modules is missing: run npm run stage first.');
  // No .bin folders (command shims the server never runs), and links copied as the files they point to: cpSync
  // makes relative links absolute, pointing back into stage/, which a Mac's codesign rejects ("invalid destination
  // for symbolic link in bundle") and which would be broken on every installed computer anyway.
  fs.cpSync(from, to, { recursive: true, dereference: true, filter: (src) => path.basename(src) !== '.bin' });
  if (mac) {
    const arch = { 1: 'x64', 3: 'arm64' }[ctx.arch] ?? String(ctx.arch);
    const bin = path.join(stage, 'ffmpeg', `darwin-${arch}`, 'ffmpeg');
    if (!fs.existsSync(bin)) throw new Error(`No ffmpeg for darwin-${arch} in stage/ffmpeg: run npm run stage on a Mac.`);
    const dest = path.join(to, 'ffmpeg-static', 'ffmpeg');
    fs.copyFileSync(bin, dest);
    fs.chmodSync(dest, 0o755);
  }
};
