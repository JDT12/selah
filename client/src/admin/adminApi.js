import { request } from '../api.js';
import { clientId } from '../live.js';

/** A large file as the raw request body (the server streams it to disk), with upload progress (0–1). */
function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('X-Client-Id', clientId);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(Object.assign(new Error(xhr.response?.error || `Upload failed (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('The upload stopped (network error).'));
    xhr.send(file);
  });
}

/** The admin console's API (server/admin/routes.js). */
export const adminApi = {
  overview: () => request('GET', '/api/admin/overview'),

  tenants: () => request('GET', '/api/admin/tenants'),
  tenant: (slug) => request('GET', `/api/admin/tenants/${slug}`),
  tenantLogs: (slug) => request('GET', `/api/admin/tenants/${slug}/logs`),
  createTenant: (t) => request('POST', '/api/admin/tenants', t),
  changeTenant: (slug, patch) => request('PATCH', `/api/admin/tenants/${slug}`, patch),
  setupLink: (slug, kind) => request('POST', `/api/admin/tenants/${slug}/setup-link`, { kind }),
  suspend: (slug) => request('POST', `/api/admin/tenants/${slug}/suspend`),
  resume: (slug) => request('POST', `/api/admin/tenants/${slug}/resume`),
  restart: (slug) => request('POST', `/api/admin/tenants/${slug}/restart`),
  deleteTenant: (slug, confirm) => request('DELETE', `/api/admin/tenants/${slug}`, { confirm }),
  rollBack: (slug) => request('POST', `/api/admin/tenants/${slug}/rollback`),
  rollBackMany: (slugs) => request('POST', '/api/admin/releases/rollback', { slugs }),
  resetDemo: (confirm) => request('POST', '/api/admin/demo/reset', { confirm }),

  events: (q = {}) => request('GET', `/api/admin/events?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`),
  alerts: () => request('GET', '/api/admin/alerts'),
  alertsSeen: (id = null) => request('POST', '/api/admin/alerts/seen', { id }),
  runMonitor: () => request('POST', '/api/admin/monitor/run'),
  jobs: (q = {}) => request('GET', `/api/admin/jobs?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`),

  backups: () => request('GET', '/api/admin/backups'),
  backupConnectStart: () => request('POST', '/api/admin/backups/connect/start'),
  backupConnectFinish: (url) => request('POST', '/api/admin/backups/connect/finish', { url }),
  setupBackups: (body) => request('PUT', '/api/admin/backups', body),
  testBackupStorage: (body) => request('POST', '/api/admin/backups/test', body),
  removeBackupDest: (id) => request('DELETE', `/api/admin/backups/dests/${id}`),
  backupSchedule: (backupTime) => request('PUT', '/api/admin/backups/schedule', { backupTime }),
  runBackups: (slugs = null, verify = false) => request('POST', '/api/admin/backups/run', { slugs, verify }),
  inBackup: () => request('GET', '/api/admin/backups/in-backup'),
  snapshots: (slug, dest = null) => request('GET', `/api/admin/backups/${slug}/snapshots${dest ? `?dest=${dest}` : ''}`),
  testRestore: (slug, snapshot, dest) => request('POST', `/api/admin/backups/${slug}/test-restore`, { snapshot, dest }),
  restore: (slug, snapshot, confirm, dest) => request('POST', `/api/admin/backups/${slug}/restore`, { snapshot, confirm, dest }),
  openItems: (slug, snapshot, dest) => request('POST', `/api/admin/backups/${slug}/items`, { snapshot, dest }),
  restoreItems: (token, body) => request('POST', `/api/admin/backups/items/${token}/restore`, body),
  closeItems: (token) => request('DELETE', `/api/admin/backups/items/${token}`),
  uploadBackup: (slug, file, onProgress) => uploadFile(`/api/admin/backups/${slug}/upload`, file, onProgress),
  restoreFile: (slug, upload, passphrase, confirm) => request('POST', `/api/admin/backups/${slug}/restore-file`, { upload, passphrase, confirm }),

  releases: () => request('GET', '/api/admin/releases'),
  prepareRelease: (channel = 'beta') => request('POST', '/api/admin/releases/prepare', { channel }),
  promoteRelease: (release) => request('POST', '/api/admin/releases/promote', { release }),
  update: (release, slugs = null) => request('POST', '/api/admin/releases/update', { release, slugs }),

  maintenance: (fresh = false) => request('GET', `/api/admin/maintenance${fresh ? '?fresh=1' : ''}`),
  maintenanceDone: (checks, note) => request('POST', '/api/admin/maintenance/done', { checks, note }),
  maintenanceSnooze: (until) => request('POST', '/api/admin/maintenance/snooze', { until }),
  maintenanceSchedule: (schedule) => request('PUT', '/api/admin/maintenance/schedule', schedule),
  sharing: () => request('GET', '/api/admin/sharing'),
  setSharing: (slug, on) => request('PUT', `/api/admin/sharing/${slug}`, { on }),
  notice: () => request('GET', '/api/admin/notice'),
  saveNotice: (body) => request('PUT', '/api/admin/notice', body),

  settings: () => request('GET', '/api/admin/settings'),
  whoami: () => request('GET', '/api/admin/whoami'),
  saveAllowIps: (allowIps) => request('PUT', '/api/admin/settings/allow-ips', { allowIps }),
  saveDefaultLimits: (limits) => request('PUT', '/api/admin/settings/limits', { limits }),
  saveTimeZone: (timeZone) => request('PUT', '/api/admin/settings/time-zone', { timeZone }),
  reloadGateway: () => request('POST', '/api/admin/gateway/reload'),

  changelog: () => request('GET', '/api/admin/docs/changelog'),
  maintenanceGuide: () => request('GET', '/api/admin/docs/maintenance'),
  adminChangelog: () => request('GET', '/api/admin/docs/admin-changelog'),
  disasterRecovery: () => request('GET', '/api/admin/docs/disaster-recovery'),
  maintenanceProcedure: () => request('GET', '/api/admin/docs/maintenance-procedure'),
  dependencies: (fresh = false) => request('GET', `/api/admin/dependencies${fresh ? '?fresh=1' : ''}`),
};
