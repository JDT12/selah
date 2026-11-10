/**
 * The admin console's own version, separate from Selah's (package.json, which is what tenants run) and the Windows
 * app's. Bump it for a release that changes the console; its history is ADMIN-CHANGELOG.md. A change to code both use
 * (server/db.js, config.js, rclone.js, …) bumps whichever side it affects, or both.
 */
export const ADMIN_VERSION = '3.4.0';
