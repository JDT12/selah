// How the server runs (from /api/session): 'single' (your own server), 'tenant' (one person's Selah on a shared host)
// or 'admin' (the admin console). Hosted Selahs have no private CA, maintenance guide or full changelog.
// 12.0: the edition is 'desktop' in Selah Desktop (single mode on the person's own PC, no sign-in) and 'server'
// everywhere else.
let info = { mode: 'single', tenant: null, edition: 'server' };

export const setServerInfo = (s) => {
  info = { mode: s?.mode ?? 'single', tenant: s?.tenant ?? null, edition: s?.edition === 'desktop' ? 'desktop' : 'server' };
};
export const serverMode = () => info.mode;
export const isHosted = () => info.mode !== 'single';
export const tenantName = () => info.tenant;
/** Selah Desktop's own library (Offline mode), not a server: no sign-in, sharing, phone remote or maintenance. */
export const isDesktopEdition = () => info.edition === 'desktop';
/** One person's own server (home or VPS), looked after with the selah command. */
export const isOwnServer = () => info.mode === 'single' && info.edition !== 'desktop';
