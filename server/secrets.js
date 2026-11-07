import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Encryption for stored passwords and API keys (WordPress, Zotero). The key lives in the data directory, not in
 * the database, so a copy of notes.db alone doesn't reveal them. It keeps its original name, wordpress.key, because
 * the off-site backup and the restore script copy it under that name.
 */
const keyPath = path.join(config.dataDir, 'wordpress.key');
// Selah Desktop passes the key in (config.secretKey, sealed by Windows on disk). A wordpress.key file still wins: one
// put back by a restore, which the app seals the next time it starts.
export function secretKey() {
  if (config.secretKey && !fs.existsSync(keyPath)) return config.secretKey;
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(keyPath);
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
