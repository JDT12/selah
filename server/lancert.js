import crypto from 'node:crypto';

/**
 * A self-signed certificate for Selah Desktop's local network mode (localnetwork.js), made with node:crypto alone.
 * Nobody's certificate authority is involved: a phone trusts it because the pairing QR code carries its SHA-256
 * fingerprint, and the Selah app accepts that certificate and no other for this PC (native pinning). So the names in
 * it don't matter; it says "Selah Desktop" and this PC's name for anyone who looks.
 *
 * ECDSA P-256 with SHA-256, X.509 v3, good for 20 years (a new one would mean pairing every phone again).
 */

// ---------- DER ----------
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const ctx = (n, ...p) => tlv(0xa0 | n, ...p);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octets = (b) => tlv(0x04, b);
const bits = (b) => tlv(0x03, Buffer.from([0]), b);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));

function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    let v = n >> 7;
    while (v > 0) { chunk.unshift(0x80 | (v & 0x7f)); v >>= 7; }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime after (RFC 5280). */
function time(d) {
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(`${String(y).slice(2)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`));
}

const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.10'), utf8('Selah'))));

function ipBytes(ip) {
  const v4 = ip.split('.');
  if (v4.length === 4 && v4.every((x) => /^\d+$/.test(x) && Number(x) < 256)) return Buffer.from(v4.map(Number));
  return null;
}

/**
 * { key, cert } as PEM, and the certificate's fingerprint (SHA-256 of its DER, hex). `names` are host names and IPv4
 * addresses for the subjectAltName.
 */
export function makeCertificate({ commonName = 'Selah Desktop', names = [], years = 20 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const now = new Date(Date.now() - 24 * 3600_000); // a day back, for phones whose clock is behind
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + years);

  const alt = [];
  for (const n of new Set(names.filter(Boolean))) {
    const ip = ipBytes(n);
    alt.push(ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(n, 'ascii')));
  }
  const exts = [
    seq(oid('2.5.29.19'), bool(true), octets(seq())), // basicConstraints: not a CA
    seq(oid('2.5.29.15'), bool(true), octets(tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage: digitalSignature
    seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))), // extKeyUsage: serverAuth
  ];
  if (alt.length) exts.push(seq(oid('2.5.29.17'), octets(seq(...alt))));

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    ctx(0, int(Buffer.from([2]))), // v3
    int(serial),
    sigAlg,
    name(commonName),
    seq(time(now), time(until)),
    name(commonName),
    spki,
    ctx(3, seq(...exts)),
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, sigAlg, bits(signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem,
    fingerprint: fingerprintOf(der),
  };
}

/** SHA-256 of a certificate's DER, as lowercase hex (what the phone compares). */
export const fingerprintOf = (der) => crypto.createHash('sha256').update(der).digest('hex');

/** The fingerprint of a PEM certificate. */
export const fingerprintOfPem = (pem) => fingerprintOf(new crypto.X509Certificate(pem).raw);
