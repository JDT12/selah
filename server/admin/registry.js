/**
 * Selah's published images (14.1): GitHub Actions pushes ghcr.io/<owner>/selah:<version> for every release and beta
 * tag (.github/workflows/image.yml). The admin console (Updates → Get) and Selah Cloud (Settings → Updates) ask the
 * registry which versions exist, anonymously, the way `docker pull` does for a public image. No settings of its own:
 * callers pass the image name.
 */

export const DEFAULT_IMAGE = 'ghcr.io/jdt12/selah';

const SEMVER = /^\d+\.\d+\.\d+(-beta\.\d+)?$/;

/** Newer first: 14.1.0 > 14.1.0-beta.3 > 14.1.0-beta.2 > 14.0.0. */
export function newerFirst(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-beta.');
    return [...core.split('.').map(Number), pre === undefined ? Infinity : Number(pre)];
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

/** registry host and repository path of an image name: ghcr.io/jdt12/selah → ['ghcr.io', 'jdt12/selah']. */
function split(image) {
  const i = image.indexOf('/');
  return [image.slice(0, i), image.slice(i + 1)];
}

let cache = { at: 0, image: '', value: null };

/**
 * { latest, beta, versions } from the registry (beta: only when it's newer than latest), cached for ten minutes.
 * Throws when the registry can't be reached; callers show "couldn't check".
 */
export async function publishedVersions(image = DEFAULT_IMAGE, { fresh = false } = {}) {
  if (!fresh && cache.image === image && Date.now() - cache.at < 600_000 && cache.value) return cache.value;
  const [host, repo] = split(image);
  const notThere = (status) => new Error(status === 401 || status === 403 || status === 404
    ? `${image} isn’t published, or isn’t public, yet`
    : `${host} answered ${status}`);
  const tokenRes = await fetch(`https://${host}/token?scope=repository:${repo}:pull&service=${host}`, { signal: AbortSignal.timeout(15_000) });
  if (!tokenRes.ok) throw notThere(tokenRes.status);
  const { token } = await tokenRes.json();
  const versions = [];
  let url = `https://${host}/v2/${repo}/tags/list?n=1000`;
  for (let page = 0; url && page < 10; page++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw notThere(r.status);
    const body = await r.json();
    versions.push(...(body.tags ?? []).filter((t) => SEMVER.test(t)));
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '');
    url = next ? new URL(next[1], `https://${host}`).href : null;
  }
  versions.sort(newerFirst);
  const latest = versions.find((v) => !v.includes('-')) ?? null;
  const newestBeta = versions.find((v) => v.includes('-')) ?? null;
  const beta = newestBeta && (!latest || newerFirst(newestBeta, latest) < 0) ? newestBeta : null;
  const value = { image, latest, beta, versions };
  cache = { at: Date.now(), image, value };
  return value;
}
