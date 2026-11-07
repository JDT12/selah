import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

/**
 * Maintenance mode: everything Selah runs is stopped on purpose (npm run admin -- maintenance-stop), for updating the
 * server's operating system and tools. It's a file in the cloud root, so the command line and the console both see
 * it with the console stopped:
 *   - while it's there, the console's monitor doesn't start tenants again or run the nightly host backup;
 *   - npm run admin -- maintenance-start starts everything and removes it;
 *   - a reboot ends it too: the file names the boot it was made in, and a console that starts in a later boot removes
 *     it and starts every tenant as usual. So "stop, update, reboot" needs nothing more.
 */

const FILE = path.join(paths.root, 'maintenance-mode.json');

/** This boot's id (Linux), or null elsewhere. */
export function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; }
}

/** { since, by, boot, sameBoot } while in maintenance mode, else null. */
export function maintenanceMode() {
  try {
    const m = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...m, sameBoot: !m.boot || m.boot === bootId() };
  } catch {
    return null;
  }
}

/** True while tenants should be left stopped (maintenance mode, in this boot). */
export const holdingTenants = () => !!maintenanceMode()?.sameBoot;

export function enterMaintenance(by = 'command line') {
  fs.writeFileSync(FILE, JSON.stringify({ since: Date.now(), by, boot: bootId() }, null, 2), { mode: 0o600 });
}

export function leaveMaintenance() {
  fs.rmSync(FILE, { force: true });
}
