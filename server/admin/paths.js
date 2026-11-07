import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where a multi-tenant Selah keeps everything (NOTEAPP_CLOUD_ROOT, default notes-data/cloud):
 *   admin/data, admin/storage   the admin console's own data (its sign-in, the tenant list, the security log copy)
 *   tenants/<name>/             each tenant: data/ (keys, OneDrive config), storage/ (notes.db, files/), tenant.env
 *   releases/<version>/         copies of Selah that tenants run from (process runner), so updates can roll back
 *   caddy/                      the gateway's config and its admin socket
 *   certs/                      the wildcard certificate (home server; the cloud uses Let's Encrypt)
 *   trash/                      deleted tenants, kept 7 days
 * Nothing here imports config.js, so it can be used to set the environment before config.js is read.
 */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(repoRoot, process.env.NOTEAPP_CLOUD_ROOT || path.join('notes-data', 'cloud'));

export const paths = {
  root,
  adminData: path.join(root, 'admin', 'data'),
  adminStorage: path.join(root, 'admin', 'storage'),
  tenants: path.join(root, 'tenants'),
  releases: path.join(root, 'releases'),
  caddy: path.join(root, 'caddy'),
  certs: path.join(root, 'certs'),
  trash: path.join(root, 'trash'),
  tenant: (slug) => {
    const dir = path.join(root, 'tenants', slug);
    return { dir, data: path.join(dir, 'data'), storage: path.join(dir, 'storage'), env: path.join(dir, 'tenant.env'), db: path.join(dir, 'storage', 'notes.db'), files: path.join(dir, 'storage', 'files') };
  },
};

/** Sets the environment for the admin console's own database and data, before config.js is first imported. */
export function adminEnv() {
  process.env.NOTEAPP_MODE = 'admin';
  process.env.NOTEAPP_DATA_DIR = paths.adminData;
  process.env.NOTEAPP_STORAGE_DIR = paths.adminStorage;
  process.env.NOTEAPP_TLS = '0';
}
