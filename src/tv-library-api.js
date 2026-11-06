// Audience library for the TV. Ranking is the Mac library's (ui/continue.js),
// copied here so Node does not import browser code. Filtering matches /api/home:
// the youngest ceiling wins, grown-ups drop cartoon tiers, and Ian alone skips
// Fran's reality shows and the cosy mysteries.

const ORDER = ['G', 'PG', 'PG-13', 'M'];
const VIEWERS = [
  { id: 'sam', ceiling: 'G' },
  { id: 'jake', ceiling: 'PG' },
  { id: 'mum', ceiling: null },
  { id: 'dad', ceiling: null },
];
const CEILING = Object.fromEntries(VIEWERS.map(person => [person.id, person.ceiling]));
const TIER = {
  preschool: 'G', shared: 'G', music: 'G',
  big: 'PG',
  older: 'PG-13',
  grownup: 'M', couple: 'M', adultanim: 'M', sitcom: 'M', scifi: 'M',
  comedy: 'M', docs: 'PG', classic: 'M', sports: 'PG', bbc: 'M', standup: 'M',
  '50s': 'M', '60s': 'M', '70s': 'M', '80s': 'M', '90s': 'M',
};
const CARTOON = new Set(['preschool', 'shared', 'big', 'older']);
const GROWNUP_TV = new Set(['grownup', 'couple']);
const FILM_FOLDERS = new Set(['Films', 'Family Films']);
const YEAR_FOLDER = /\((?:19|20)\d\d\)\s*$/;
const EPISODE_MARK = /\bS\d{1,2}\s?E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i;
const EPISODE = /\bS(\d{1,2})E(\d{1,3})\b/i;
const RIDES = /\b(?:knight rider|the a[- ]team|the dukes of hazzard|airwolf|chips|baywatch|top gear)\b/i;
const AD = /^ads\/(?:50s|60s|70s|80s|90s)\//;
const IAN_SKIPS = /^(?:shetland|vera\b|death in paradise|miss fisher|midsomer|father brown|foyle|poirot|marple|agatha christie|lewis\b|endeavour|inspector|grantchester|murder,? she wrote|death on the nile|the madame blanc|whitstable pearl|the brokenwood|rosemary (?:&|and) thyme|bergerac|dalgliesh|ludwig|(?:couples )?come dine with me|first dates|a place in the sun|escape to the country|homes under the hammer|the hotel inspector|grand designs|dragons.? den|the repair shop|gogglebox|four in a bed|(?:the )?(?:great british )?bake off|bargain hunt|location,? location|love island|married at first sight|the apprentice)/i;
const STALE_MS = 21 * 24 * 3600 * 1000;

const folder = path => String(path || '').slice(0, String(path || '').lastIndexOf('/'));
const fileName = path => String(path || '').slice(String(path || '').lastIndexOf('/') + 1);
const showName = name => String(name || '').replace(/\s*\((?:19|20)\d\d\)\s*$/, '').replace(/\s*-?\s*Official(?: Channel)?\s*$/i, '').trim() || String(name || '');

function ratingOf(value) {
  if (value == null || value === '') return null;
  const rating = String(value).trim().toUpperCase();
  return ORDER.includes(rating) ? rating : null;
}

function viewerIds(value) {
  if (value == null) return VIEWERS.map(person => person.id);
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const ids = [];
  for (const part of parts) {
    const id = String(part).trim().toLowerCase();
    if (CEILING[id] !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function ceilingFor(ids, rating) {
  if (!ids.length) return null;
  if (rating) return rating;
  const caps = ids.map(id => CEILING[id]).filter(Boolean);
  if (!caps.length) return 'M';
  return caps.reduce((lowest, cap) => (ORDER.indexOf(cap) < ORDER.indexOf(lowest) ? cap : lowest));
}

const grownOnly = (ids, rating) => ids.length > 0 && (!rating || rating === 'M') && !ids.some(id => CEILING[id]);

function isFilm(item) {
  return FILM_FOLDERS.has(item.channel)
    || (GROWNUP_TV.has(item.tier) && YEAR_FOLDER.test(String(item.channel || ''))
      && !EPISODE_MARK.test(String(item.src || '') + ' ' + String(item.title || '')));
}

function contentRating(item) {
  const tier = TIER[item.tier] || 'M';
  const blob = (String(item.channel || '') + ' ' + String(item.src || '')).replace(/[._]/g, ' ');
  if (RIDES.test(blob) && ORDER.indexOf('PG') < ORDER.indexOf(tier)) return 'PG';
  return tier;
}

function allowed(item, ids, ceiling, adults, ian) {
  if (!item || typeof item.src !== 'string' || !item.src || AD.test(item.src)) return false;
  if (!ceiling) return false;
  if (adults && CARTOON.has(item.tier)) return false;
  if (ian && IAN_SKIPS.test(String(item.channel || '').replace(/^[^\w]+/, ''))) return false;
  const rating = contentRating(item);
  return ORDER.indexOf(rating) >= 0 && ORDER.indexOf(rating) <= ORDER.indexOf(ceiling);
}

function historyMap(history) {
  const list = Array.isArray(history) ? history : (history?.list?.() || []);
  const byPath = new Map();
  for (const entry of list) {
    if (!entry || typeof entry.path !== 'string') continue;
    const prior = byPath.get(entry.path);
    if (!prior || String(entry.updatedAt || '') > String(prior.updatedAt || '')) byPath.set(entry.path, entry);
  }
  return byPath;
}

function episodeParts(item) {
  const match = EPISODE.exec(item.title || '') || EPISODE.exec(fileName(item.path));
  if (!match) return { number: null, season: null, episode: null };
  return { number: Number(match[1]) * 1000 + Number(match[2]), season: Number(match[1]), episode: Number(match[2]) };
}

const episodeNumber = item => episodeParts(item).number;
const seen = item => {
  if (item.completed) return true;
  const dur = item.durationSeconds || 0, pos = item.positionSeconds || 0;
  return dur > 0 && (pos >= 0.85 * dur || (dur >= 1200 && dur - pos <= 300));
};
const touched = item => item.updatedAt && (item.completed || item.positionSeconds > 5);
const later = (a, b) => String(a.updatedAt) > String(b.updatedAt) ||
  (String(a.updatedAt) === String(b.updatedAt) && (episodeNumber(a) ?? -1) > (episodeNumber(b) ?? -1));
const showKey = item => episodeNumber(item) === null ? item.path : folder(item.path);
const nextEpisode = (items, after) => {
  const number = episodeNumber(after), dir = folder(after.path);
  return items.filter(other => folder(other.path) === dir && episodeNumber(other) > number && !seen(other))
    .sort((a, b) => episodeNumber(a) - episodeNumber(b))[0];
};

function continueRow(items, now) {
  const latest = new Map();
  for (const item of items) {
    if (!touched(item) || now - Date.parse(item.updatedAt) > STALE_MS) continue;
    const prior = latest.get(showKey(item));
    if (!prior || later(item, prior)) latest.set(showKey(item), item);
  }
  const row = [];
  for (const item of latest.values()) {
    if (!seen(item)) { if (item.positionSeconds >= 60) row.push(item); continue; }
    if (episodeNumber(item) === null) continue;
    const next = nextEpisode(items, item);
    if (next) row.push({ ...next, upNext: true, updatedAt: item.updatedAt });
  }
  return row.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function collectionOf(item) {
  const marker = String(item.path).indexOf('/Movies/');
  if (marker >= 0) {
    const rest = item.path.slice(marker + 8);
    if (rest.includes('/')) return rest.slice(0, rest.indexOf('/'));
  }
  return item.kind === 'film' ? 'films' : 'other';
}
const label = key => key.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());

function collectionRows(items, skip) {
  const groups = new Map();
  for (const item of items) {
    const key = collectionOf(item);
    if (!groups.has(key)) groups.set(key, { key, title: label(key), items: [], lastWatched: '' });
    const group = groups.get(key);
    group.items.push(item);
    if (touched(item) && String(item.updatedAt) > group.lastWatched) group.lastWatched = String(item.updatedAt);
  }
  const rows = [];
  for (const group of groups.values()) {
    const shows = new Map();
    for (const item of group.items) {
      const key = showKey(item);
      if (!shows.has(key)) shows.set(key, []);
      shows.get(key).push(item);
    }
    const cards = [];
    for (const [key, members] of shows) {
      if (skip.has(key)) continue;
      if (episodeNumber(members[0]) === null) { cards.push(...members.map(item => ({ item, seen: seen(item), at: '' }))); continue; }
      const watched = members.filter(touched).sort((a, b) => (later(a, b) ? -1 : 1))[0];
      const pick = watched ? (seen(watched) ? nextEpisode(members, watched) : watched)
        : members.slice().sort((a, b) => episodeNumber(a) - episodeNumber(b))[0];
      if (pick) cards.push({ item: pick, seen: false, at: watched ? String(watched.updatedAt) : '' });
    }
    cards.sort((a, b) => (a.seen - b.seen) || b.at.localeCompare(a.at) ||
      a.item.title.localeCompare(b.item.title, undefined, { numeric: true }));
    if (cards.length) rows.push({ key: group.key, title: group.title, lastWatched: group.lastWatched, items: cards.map(card => card.item) });
  }
  return rows.sort((a, b) => b.lastWatched.localeCompare(a.lastWatched) || a.title.localeCompare(b.title));
}

function present(item) {
  const card = {
    src: item.src,
    title: item.title,
    show: item.show,
    kind: item.kind,
    art: item.art,
    positionSeconds: item.positionSeconds || 0,
    durationSeconds: item.durationSeconds || 0,
    completed: item.completed === true,
    updatedAt: item.updatedAt || '',
    resume: !item.completed && item.positionSeconds > 5 ? Math.round(item.positionSeconds) : 0,
    season: item.season,
    episode: item.episode,
  };
  if (item.upNext) card.upNext = true;
  return card;
}

function toItem(video, saved) {
  const path = video.file || video.path || video.src;
  const entry = saved.get(path) || null;
  const film = isFilm(video);
  const parts = episodeParts({ title: video.title, path });
  const positionSeconds = Number.isFinite(entry?.positionSeconds) ? Math.max(0, entry.positionSeconds) : 0;
  const durationSeconds = Number.isFinite(entry?.durationSeconds) && entry.durationSeconds > 0
    ? entry.durationSeconds : (video.duration || 0);
  return {
    src: video.src,
    path,
    title: video.title || video.src,
    channel: video.channel || '',
    show: film && FILM_FOLDERS.has(video.channel) ? (video.title || showName(video.channel)) : showName(video.channel || video.title || ''),
    kind: film ? 'film' : 'episode',
    art: '/art?src=' + encodeURIComponent(video.src),
    positionSeconds,
    durationSeconds,
    completed: entry?.completed === true,
    updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : '',
    season: parts.season,
    episode: parts.episode,
  };
}

function groupShows(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.kind === 'film') continue;
    const key = item.channel || item.show || item.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const shows = [];
  for (const [key, episodes] of groups) {
    const sorted = episodes.slice().sort((a, b) => (episodeNumber(a) ?? 1e9) - (episodeNumber(b) ?? 1e9)
      || a.title.localeCompare(b.title, undefined, { numeric: true }));
    const resumed = sorted.filter(item => !item.completed && item.positionSeconds > 5)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const face = resumed || sorted[0];
    shows.push({
      key,
      title: sorted[0].show || showName(key),
      art: face.art || '',
      resume: resumed ? Math.round(resumed.positionSeconds) : 0,
      positionSeconds: face.positionSeconds || 0,
      durationSeconds: face.durationSeconds || 0,
      episodes: sorted.map(present),
    });
  }
  return shows.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

/** Library payload for one audience. `history` is a list or a store with list(). */
export function libraryView({ videos = [], history = [], viewers, rating = null, now = Date.now() } = {}) {
  const list = Array.isArray(videos) ? videos : [];
  const ids = viewerIds(viewers);
  const chosen = ratingOf(rating);
  const ceiling = ceilingFor(ids, chosen);
  const adults = grownOnly(ids, chosen);
  const ian = ids.length === 1 && ids[0] === 'dad' && adults;
  const items = list.filter(item => allowed(item, ids, ceiling, adults, ian)).map(item => toItem(item, historyMap(history)));
  const upNext = continueRow(items, now);
  const collections = collectionRows(items, new Set(upNext.map(showKey))).map(row => ({
    key: row.key,
    title: row.title,
    items: row.items.map(present),
  }));
  const films = items.filter(item => item.kind === 'film')
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
    .map(present);
  return {
    ceiling,
    upNext: upNext.map(present),
    collections,
    shows: groupShows(items),
    films,
    items: items.map(present),
  };
}
