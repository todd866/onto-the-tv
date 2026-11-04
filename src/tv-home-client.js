// The renderer never receives arbitrary network access. Rating decisions stay in tv-server.
// The M2 is the TV box with the whole library (reached over Tailscale from anywhere);
// this Mac's own server is the fallback when the M2 cannot be reached.
export const TV_HOME_ORIGINS = ['http://iantodds-macbook-air.tail8cd07b.ts.net:8686', 'http://localhost:8686'];
export const TV_HOME_ORIGIN = TV_HOME_ORIGINS[TV_HOME_ORIGINS.length - 1];
export async function fetchTvHome(viewers, fetcher = fetch, rating = null, origins = TV_HOME_ORIGINS) {
  let failure;
  for (const origin of origins) {
    try {
      return { ...(await fetchHomeFrom(origin, viewers, fetcher, rating)), origin };
    } catch (error) {
      if (/^Invalid (viewers|rating)\.$/.test(error.message)) throw error;
      failure = error;
    }
  }
  throw failure;
}
async function fetchHomeFrom(origin, viewers, fetcher, rating) {
  const url = new URL('/api/home', origin);
  if (rating !== null && rating !== undefined) {
    if (!['G', 'PG', 'M'].includes(rating)) throw new Error('Invalid rating.');
    url.searchParams.set('rating', rating);
  }
  if (viewers !== undefined) {
    if (!Array.isArray(viewers) || viewers.length > 4 || viewers.some(id => !['sam', 'jake', 'mum', 'dad'].includes(id))) {
      throw new Error('Invalid viewers.');
    }
    url.searchParams.set('viewers', [...new Set(viewers)].join(','));
  }
  const response = await fetcher(url, { signal: AbortSignal.timeout(origin === TV_HOME_ORIGIN ? 5000 : 3000), redirect: 'error' });
  if (!response.ok) throw new Error(`TV lineup unavailable (${response.status}).`);
  const home = await response.json();
  if (!home || ![null, 'G', 'PG', 'PG-13', 'M'].includes(home.ceiling)
      || !Array.isArray(home.channels) || home.channels.length > 64
      || home.channels.some(channel => !channel || typeof channel.id !== 'string' || !channel.id
        || !Number.isInteger(channel.number) || channel.number < 1 || typeof channel.name !== 'string'
        || typeof channel.now?.show !== 'string' || typeof channel.now?.art !== 'string')
      || !Array.isArray(home.viewers) || home.viewers.length !== 4
      || new Set(home.viewers.map(person => person?.id)).size !== 4
      || home.viewers.some(person => !person || !['sam', 'jake', 'mum', 'dad'].includes(person.id)
        || typeof person.name !== 'string' || typeof person.on !== 'boolean')) throw new Error('Invalid TV lineup.');
  return home;
}
