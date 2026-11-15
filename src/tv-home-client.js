// The renderer never receives arbitrary network access. Rating decisions stay in tv-server.
// The M2 is the TV box with the whole library, reached through its tailnet-only
// Tailscale HTTPS proxy (tailscale serve --https=8443): the certificate proves it is the M2;
// this Mac's own server is the fallback when the M2 cannot be reached.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
// At home the M2 is asked on the home network first: the tailnet's HTTPS proxy carried a cached episode's
// first 4 MB in about 2 s where the home network took 0.5 s (15 Nov 2026), and the Mac player was slow to
// start. The M2's address is fixed (192.168.20.20 since 6 Nov). Away from home that address does not answer
// within LAN_WAIT_MS and the tailnet is asked, as before.
// Plain http proves nothing about who answers, and 192.168.20.20 exists on other networks too: the address
// is used only after the server there proves it holds this Mac's pairing token (homeOrigins below).
export const M2_HOME_ORIGIN = 'http://192.168.20.20:8686';
export const M2_TAILNET_ORIGIN = 'https://iantodds-macbook-air.tail8cd07b.ts.net:8443';
export const TV_HOME_ORIGINS = [M2_HOME_ORIGIN, M2_TAILNET_ORIGIN, 'http://localhost:8686'];

// Ask the server at the home address for an HMAC of a fresh nonce under the pairing token; only the M2 can
// answer it, and the token never leaves this Mac.
export async function provesM2(token, fetcher = fetch, origin = M2_HOME_ORIGIN) {
  if (!token) return false;
  const nonce = randomBytes(16).toString('hex');
  try {
    const response = await fetcher(new URL('/api/whoami?n=' + nonce, origin), { signal: AbortSignal.timeout(LAN_WAIT_MS), redirect: 'error' });
    if (!response.ok) return false;
    const { proof } = await response.json();
    const want = Buffer.from(createHmac('sha256', token).update('onto-whoami:' + nonce).digest('hex'));
    const got = Buffer.from(typeof proof === 'string' ? proof : '');
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}

// The servers to ask, in order: the home address only while it has proved itself (checked again every few
// minutes, and soon after a failure, so leaving or coming home is noticed).
export function createHomeOrigins({ token, fetcher = fetch, now = Date.now } = {}) {
  let proved = null, checkedAt = 0;
  return async function homeOrigins() {
    const age = now() - checkedAt;
    if (proved === null || (proved && age > 5 * 60_000) || (!proved && age > 60_000)) {
      proved = await provesM2(await token(), fetcher);
      checkedAt = now();
    }
    return proved ? TV_HOME_ORIGINS : TV_HOME_ORIGINS.slice(1);
  };
}
const LAN_WAIT_MS = 1200;
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

// Find a show: the shows this audience may watch, from the same server as the lineup. /api/shows is
// the short listing made for this; a server from before it existed answers 404 and is asked for its
// whole library instead (megabytes). Either way only what a card draws and plays crosses to the
// window, and a picture is always the server's own /art route for that episode, never a sent address.
const MAX_SHOWS = 5000, MAX_EPISODES = 500;
const text = (value, limit = 400) => (typeof value === 'string' ? value.slice(0, limit) : '');
const artFor = src => '/art?src=' + encodeURIComponent(src);
export async function fetchTvShows(viewers, fetcher = fetch, rating = null, origins = TV_HOME_ORIGINS) {
  return firstOrigin(origins, async origin => {
    const ask = path => fetcher(audienceUrl(path, origin, viewers, rating), { signal: AbortSignal.timeout(12000), redirect: 'error' });
    let response = await ask('/api/shows');
    if (response.status === 404) response = await ask('/api/library');
    if (!response.ok) throw new Error(`TV library unavailable (${response.status}).`);
    const library = await response.json();
    if (!library || !Array.isArray(library.shows)) throw new Error('Invalid TV library.');
    const shows = [];
    for (const show of library.shows.slice(0, MAX_SHOWS)) {
      if (!show || typeof show.title !== 'string' || !show.title || !Array.isArray(show.episodes)) continue;
      const episodes = [];
      let face = '';
      show.episodes.slice(0, MAX_EPISODES).forEach((item, index) => {
        if (!item || typeof item.src !== 'string' || !item.src) return;
        // The short listing says seconds/at/done/when; the whole library says it the long way.
        const seconds = Number(item.seconds ?? item.durationSeconds) || 0, at = Number(item.at ?? item.positionSeconds) || 0;
        const completed = (item.done ?? item.completed) === true;
        const art = artFor(item.src);
        if (index === show.face || (typeof show.art === 'string' && show.art === item.art)) face = art;
        episodes.push({ src: item.src, title: text(item.title) || show.title, art, minutes: seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0,
          resume: at > 5 && !completed ? Math.floor(at) : 0, completed, updatedAt: text(item.when ?? item.updatedAt, 40) });
      });
      if (episodes.length) shows.push({ title: text(show.title), art: face || episodes[0].art, episodes });
    }
    return { shows };
  });
}
async function fetchHomeFrom(origin, viewers, fetcher, rating) {
  const url = audienceUrl('/api/home', origin, viewers, rating);
  const response = await fetcher(url, { signal: AbortSignal.timeout(origin === TV_HOME_ORIGIN ? 5000 : origin === M2_HOME_ORIGIN ? LAN_WAIT_MS : 3000), redirect: 'error' });
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
