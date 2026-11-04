// The renderer never receives arbitrary network access. Rating decisions stay in tv-server.
export const TV_HOME_ORIGIN = 'http://localhost:8686';
export async function fetchTvHome(viewers, fetcher = fetch, rating = null) {
  const url = new URL('/api/home', TV_HOME_ORIGIN);
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
  const response = await fetcher(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
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
