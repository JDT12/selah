// electron-builder leaves node_modules out of extraResources, so the local server's packages are copied in here.
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(ctx) {
  const from = path.join(__dirname, '..', 'stage', 'server', 'node_modules');
  const to = path.join(ctx.appOutDir, 'resources', 'server', 'node_modules');
  if (!fs.existsSync(from)) throw new Error('stage/server/node_modules is missing: run npm run stage first.');
  fs.cpSync(from, to, { recursive: true });
};
