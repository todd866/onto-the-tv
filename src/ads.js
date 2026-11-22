// Period ads between shows, and where a long show breaks for them.
const ORDER = ['G', 'PG', 'PG-13', 'M'];
const FOLDER_RATING = { preschool: 'G', shared: 'G', big: 'PG', older: 'PG-13' };
const BREAK_TARGET = 90;
const LONG_SHOW = 20 * 60;

export function adDecade(src) {
  const match = /^ads\/(50s|60s|70s|80s|90s)\//.exec(String(src || ''));
  return match ? match[1] : '';
}

export function isAdSrc(src) {
  return adDecade(src) !== '';
}

/** G, unless the show folder inside ads/<decade>/<folder>/ is named in tiers.json. */
export function adRating(src, tiers) {
  const parts = String(src || '').split('/');
  const folder = parts.length >= 4 ? parts[2] : '';
  if (folder && tiers && typeof tiers === 'object') {
    for (const tier of Object.keys(FOLDER_RATING)) {
      const shows = tiers[tier];
      if (Array.isArray(shows) && shows.includes(folder)) return FOLDER_RATING[tier];
    }
  }
  return 'G';
}

function allowed(rating, ceiling, blocked) {
  if (blocked || !ceiling) return false;
  const cap = ORDER.indexOf(ceiling);
  const have = ORDER.indexOf(rating);
  return cap >= 0 && have >= 0 && have <= cap;
}

function durationOf(items) {
  let total = 0;
  for (const item of items) total += Number(item.duration) > 0 ? Number(item.duration) : 0;
  return total;
}

function takeBreak(pool, playedSrcs) {
  const used = new Set(playedSrcs);
  const unused = pool.filter(ad => !used.has(ad.src));
  const replay = [];
  for (const src of playedSrcs) {
    const ad = pool.find(item => item.src === src);
    if (ad && !replay.some(item => item.src === ad.src)) replay.push(ad);
  }
  const picked = [];
  const seen = new Set();
  for (const ad of unused.concat(replay)) {
    if (seen.has(ad.src)) continue;
    seen.add(ad.src);
    picked.push(ad);
    if (picked.length === 3) break;
    if (picked.length >= 2 && durationOf(picked) >= BREAK_TARGET) break;
  }
  return picked;
}

function remember(srcs, picked) {
  for (const ad of picked) if (!srcs.includes(ad.src)) srcs.push(ad.src);
}

export function midBreakTimes(duration, blacks) {
  if (!(Number(duration) > LONG_SHOW) || !Array.isArray(blacks) || !blacks.length) return [];
  const lo = duration * 0.1;
  const hi = duration * 0.9;
  const usable = blacks.filter(t => typeof t === 'number' && Number.isFinite(t) && t >= lo && t <= hi);
  const chosen = [];
  for (const target of [duration / 3, (2 * duration) / 3]) {
    let best = null;
    let dist = Infinity;
    for (const t of usable) {
      const gap = Math.abs(t - target);
      if (gap < dist) { dist = gap; best = t; }
    }
    if (best != null && !chosen.includes(best)) chosen.push(best);
  }
  return chosen;
}

function pack(ad) {
  return { kind: 'ad', src: ad.src, title: ad.title || '', duration: Number(ad.duration) > 0 ? ad.duration : 0 };
}

/**
 * Preroll, then the show. Shows over 20 minutes also carry mid-show breaks
 * at the black frames nearest one third and two thirds.
 * `played` is { day, srcs } for the household's day, so a spot is not reused
 * while another spot from the same decade is still unused.
 */
export function buildPlayQueue({ show, ads = [], blacks = [], played = null, now = Date.now(), ceiling = 'M', blocked = false, tiers = null }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const srcs = played && played.day === day && Array.isArray(played.srcs) ? played.srcs.slice() : [];
  const pool = (Array.isArray(ads) ? ads : [])
    .filter(ad => ad && typeof ad.src === 'string' && allowed(adRating(ad.src, tiers), ceiling, blocked))
    .slice()
    .sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
  const preroll = takeBreak(pool, srcs);
  remember(srcs, preroll);
  const breaks = midBreakTimes(show?.duration || 0, blacks).map(at => {
    const chosen = takeBreak(pool, srcs);
    remember(srcs, chosen);
    return { at, ads: chosen.map(pack) };
  });
  return {
    queue: [...preroll.map(pack), { kind: 'show', src: show?.src || '', breaks }],
    played: { day, srcs },
  };
}
