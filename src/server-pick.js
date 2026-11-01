// Choosing which TV server to show: the first in the list that answers /api/health.
// The Mac behind the TV lists the M2 first and its own server (library on an
// external drive) second, so it streams from the M2 at home and falls back to
// its own copy when the M2 cannot be reached ("holiday mode").

/** The configured servers, in order of preference: `servers` if given, else `server`. */
export function serverList(config) {
  const list = Array.isArray(config?.servers) ? config.servers : [config?.server];
  return [...new Set(list.filter(url => typeof url === 'string' && /^https?:\/\//.test(url))
    .map(url => url.endsWith('/') ? url : url + '/'))];
}

/** True if the server at `base` answers its health check within `timeoutMs`. */
export async function answers(base, { fetch = globalThis.fetch, timeoutMs = 2500 } = {}) {
  try {
    const response = await fetch(new URL('api/health', base), { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

/** The first server that answers, or null if none does. */
export async function pickServer(servers, options) {
  for (const base of servers) if (await answers(base, options)) return base;
  return null;
}
