// The renderer never receives arbitrary network access. Rating decisions stay in tv-server.
// The M2 is the TV box with the whole library, reached through its tailnet-only
// Tailscale HTTPS proxy (tailscale serve --https=8443): the certificate proves it is the M2;
// this Mac's own server is the fallback when the M2 cannot be reached.
export const TV_HOME_ORIGINS = ['https://iantodds-macbook-air.tail8cd07b.ts.net:8443', 'http://localhost:8686'];
export const TV_HOME_ORIGIN = TV_HOME_ORIGINS[TV_HOME_ORIGINS.length - 1];
export async function fetchTvHome(viewers, fetcher = fetch, rating = null, origins = TV_HOME_ORIGINS) {
  return firstOrigin(origins, origin => fetchHomeFrom(origin, viewers, fetcher, rating));
}
// The audience is checked here, before any request, for both the lineup and the show list.
function audienceUrl(path, origin, viewers, rating) {
  const url = new URL(path, origin);
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
  return url;
}
async function firstOrigin(origins, ask) {
  let failure;
  for (const origin of origins) {
    try { return { ...(await ask(origin)), origin }; }
    catch (error) {
      if (/^Invalid (viewers|rating)\.$/.test(error.message)) throw error;
      failure = error;
    }
  }
  throw failure;
}

// Find a show: the shows this audience may watch, from the same server as the lineup. The
// server's listing runs to megabytes, so only what a card draws and plays crosses to the window.
const MAX_SHOWS = 5000, MAX_EPISODES = 500;
const text = (value, limit = 400) => (typeof value === 'string' ? value.slice(0, limit) : '');
const artPath = value => (typeof value === 'string' && value.startsWith('/art?') ? value : '');
export async function fetchTvShows(viewers, fetcher = fetch, rating = null, origins = TV_HOME_ORIGINS) {
  return firstOrigin(origins, async origin => {
    const response = await fetcher(audienceUrl('/api/library', origin, viewers, rating), { signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw new Error(`TV library unavailable (${response.status}).`);
    const library = await response.json();
    if (!library || !Array.isArray(library.shows)) throw new Error('Invalid TV library.');
    const shows = [];
    for (const show of library.shows.slice(0, MAX_SHOWS)) {
      if (!show || typeof show.title !== 'string' || !show.title || !Array.isArray(show.episodes)) continue;
      const episodes = [];
      for (const item of show.episodes.slice(0, MAX_EPISODES)) {
        if (!item || typeof item.src !== 'string' || !item.src) continue;
        const seconds = Number(item.durationSeconds) || 0, at = Number(item.positionSeconds) || 0;
        episodes.push({ src: item.src, title: text(item.title) || show.title, art: artPath(item.art), minutes: seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0,
          resume: at > 5 && item.completed !== true ? Math.floor(at) : 0, completed: item.completed === true, updatedAt: text(item.updatedAt, 40) });
      }
      if (episodes.length) shows.push({ title: text(show.title), art: artPath(show.art), episodes });
    }
    return { shows };
  });
}
async function fetchHomeFrom(origin, viewers, fetcher, rating) {
  const url = audienceUrl('/api/home', origin, viewers, rating);
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
