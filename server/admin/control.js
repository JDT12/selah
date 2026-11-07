import { controlToken } from './store.js';

/** Calls a tenant's control port (server/tenant.js) with its key. */
const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });

export async function control(t, method, url, body, { timeout = 10_000 } = {}) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${t.controlPort}${url}`, {
      method,
      headers: { Authorization: `Bearer ${controlToken(t.slug)}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw httpError(502, `${t.slug} isn’t answering (${e.cause?.code || e.name})`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw httpError(502, data?.error || `${t.slug} answered ${res.status}.`);
  return data;
}

/** Waits until the tenant answers its health check (and, with `version`, runs that version). */
export async function waitHealthy(t, { version = null, timeout = 60_000, failFast = null } = {}) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    // e.g. it keeps crashing on start: no need to wait out the whole time.
    const fatal = await failFast?.();
    if (fatal) throw httpError(504, `${t.slug} didn’t start: ${fatal}`);
    try {
      const h = await control(t, 'GET', '/control/health', undefined, { timeout: 3000 });
      if (h.ok && (!version || h.version === version)) return h;
      last = `it runs ${h.version}, not ${version}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw httpError(504, `${t.slug} didn’t come up in time: ${last ?? 'no answer'}`);
}
