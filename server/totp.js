import crypto from 'node:crypto';

/**
 * Time-based one-time codes (RFC 6238: SHA-1, 6 digits, 30 seconds), the kind every authenticator app makes, and
 * the recovery codes that stand in for the phone.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30_000;

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32(crypto.randomBytes(20));

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / STEP);
export const codeAt = (secret, step) => hotp(fromBase32(secret), step);

/**
 * The time step a 6-digit code belongs to (this one, or the one either side for a slow clock), or null. A step at or
 * before `lastStep` doesn't count, so a code that was seen once can't be used again.
 */
export function matchCode(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = fromBase32(secret);
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (s > lastStep && crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c))) return s;
  }
  return null;
}

export const otpauthUri = (secret, account) =>
  `otpauth://totp/${encodeURIComponent(`Selah:${account}`)}?secret=${secret}&issuer=Selah&algorithm=SHA1&digits=6&period=30`;

// ---------- recovery codes ----------

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const normalizeRecovery = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecovery = (s) => crypto.createHash('sha256').update(normalizeRecovery(s)).digest('hex');

/** Ten codes like "k7m2p-x9qtr", each good once. */
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const chars = Array.from(crypto.randomBytes(10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}
