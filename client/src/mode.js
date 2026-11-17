// How the server runs (from /api/session): 'single' (your own server), 'tenant' (one person's Selah on a shared host)
// or 'admin' (the admin console). Hosted Selahs have no private CA, maintenance guide or full changelog.
// 14.0: the product is which Selah this is, the one setting the rest of the app asks:
//   'desktop'  Selah Desktop, local only (no sign-in)
//   'cloud'    a self-hosted single Selah
//   'ministry' a self-hosted multi-tenant Selah (tenants and the admin console)
let info = { mode: 'single', tenant: null, product: 'cloud' };

const PRODUCTS = ['desktop', 'cloud', 'ministry'];
export const setServerInfo = (s) => {
  const mode = s?.mode ?? 'single';
  // A server from before 14.0 sends only edition ('desktop' or 'server').
  const product = PRODUCTS.includes(s?.product) ? s.product
    : mode !== 'single' ? 'ministry' : s?.edition === 'desktop' ? 'desktop' : 'cloud';
  info = { mode, tenant: s?.tenant ?? null, product, container: !!s?.container };
};
export const serverMode = () => info.mode;
/** Selah Cloud in its container (14.1, docker/cloud/): set up by a setup link, updated from Settings. */
export const cloudContainer = () => info.product === 'cloud' && info.container;
export const selahProduct = () => info.product;
export const isHosted = () => info.mode !== 'single';
export const tenantName = () => info.tenant;
/** Selah Desktop's own library (Offline mode), not a server: no sign-in, sharing, phone remote or maintenance. */
export const isDesktopEdition = () => info.product === 'desktop';
/** One person's own server (home or VPS), looked after with the selah command. */
export const isOwnServer = () => info.product === 'cloud';
/** Sharing between people is a Selah Ministry feature, on a tenant's Selah (14.0). */
export const canShare = () => info.mode === 'tenant';
