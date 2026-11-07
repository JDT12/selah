import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Fetching addresses that came from outside: clipped pages and their images, calendar feeds, the WordPress site.
 * The server must never be steered into its own network (the router, other machines, a cloud host's metadata
 * service at 169.254.169.254), so every connection's address is checked when it's made, after DNS, which also
 * covers redirects and names that resolve differently the second time. NOTEAPP_FETCH_ALLOW lists host names (or
 * host:port) that may be on a private address anyway, e.g. a WordPress site on the home network.
 */
const allowed = new Set(String(process.env.NOTEAPP_FETCH_ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (!net.isIPv6(ip)) return true;
  const a = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPrivateAddress(mapped[1]);
  // The URL parser writes IPv4-mapped addresses in hex: [::ffff:127.0.0.1] becomes [::ffff:7f00:1].
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) return isPrivateAddress([hex[1], hex[2]].flatMap((h) => { const n = parseInt(h, 16); return [n >> 8, n & 255]; }).join('.'));
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith('64:ff9b:') || a.startsWith('2001:db8:');
}

const hostAllowed = (url) => allowed.has(url.hostname.toLowerCase()) || allowed.has(url.host.toLowerCase());

const blockedError = (host) => Object.assign(new Error(`${host} is on a private network; Selah doesn't fetch from there.`), { code: 'EPRIVATE' });

/** A connection pool whose DNS lookups refuse private addresses (unless the host name is allowed). */
const agent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        // The lookup doesn't know the port, so a host:port entry allows the host name here.
        const name = hostname.toLowerCase();
        const nameAllowed = [...allowed].some((a) => a === name || a.replace(/:\d+$/, '') === name);
        const ok = nameAllowed ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
        if (!ok.length) return callback(blockedError(hostname));
        if (options.all) callback(null, ok);
        else callback(null, ok[0].address, ok[0].family);
      });
    },
  },
});

/** Checks a URL before it's fetched: http(s) only, no credentials in it, and no private IP written as the host. */
export function checkUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be fetched.');
  if (url.username || url.password) throw new Error('Links with a user name or password in them can’t be fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host) && !hostAllowed(url)) throw blockedError(url.hostname);
  return url;
}

/**
 * For addresses another program connects to (rclone, for backup storage): https (http only for an allowed host),
 * and the host name must not resolve to a private address. Returns the URL.
 */
export async function checkPublicHost(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('That isn’t a web address.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && hostAllowed(url))) throw new Error('Use an https:// address.');
  if (url.username || url.password) throw new Error('Put the user name and password in their own boxes, not in the address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (hostAllowed(url)) return url;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blockedError(url.hostname);
    return url;
  }
  const found = await dns.promises.lookup(host, { all: true }).catch(() => { throw new Error(`Couldn’t find ${host}. Check the address.`); });
  if (!found.length || found.some((a) => isPrivateAddress(a.address))) throw blockedError(url.hostname);
  return url;
}

/**
 * fetch() for outside addresses. Same options as fetch; redirects are followed here (up to 5), checking each one,
 * and the Authorization header is dropped when a redirect leaves the original host.
 */
export async function safeFetch(input, opts = {}) {
  let url = checkUrl(input);
  const follow = (opts.redirect ?? 'follow') === 'follow';
  let init = { ...opts, redirect: 'manual', dispatcher: agent };
  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(url.href, init);
    if (!follow || res.status < 300 || res.status >= 400 || !res.headers.get('location')) return res;
    if (hop >= 5) throw new Error('Too many redirects.');
    const next = checkUrl(new URL(res.headers.get('location'), url));
    await res.body?.cancel().catch(() => {});
    if (next.host !== url.host && init.headers) {
      const headers = new Headers(init.headers);
      headers.delete('authorization');
      headers.delete('cookie');
      init = { ...init, headers };
    }
    // 303 (and 301/302 after a POST) turn into a GET without a body, as browsers do.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method && init.method !== 'GET' && init.method !== 'HEAD')) {
      init = { ...init, method: 'GET', body: undefined, duplex: undefined };
    }
    url = next;
  }
}
