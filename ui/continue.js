// Library home ranking. Classic script: app.js uses the globals; tests load it
// through node:vm.
//
// - Up next: one card per show. An episode within its credits counts as seen,
//   so the card moves on to the next episode instead of re-offering the end of
//   the last one. Stale (3 weeks) or barely-started (<60 s, surfing) plays drop out.
// - Collection rows: the library's top folders (grown-ups, family-films, …),
//   ordered by what was watched most recently, so the household member at the
//   Mac sees their own collection first. Shows collapse to one card each.
(function (root) {
  const STALE_MS = 21 * 24 * 3600 * 1000;
  const EPISODE = /\bS(\d{1,2})E(\d{1,3})\b/i;
  const folder = path => path.slice(0, path.lastIndexOf('/'));
  const fileName = path => path.slice(path.lastIndexOf('/') + 1);
  const episodeNumber = item => {
    const match = EPISODE.exec(item.title || '') || EPISODE.exec(fileName(item.path));
    return match ? Number(match[1]) * 1000 + Number(match[2]) : null;
  };
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

  function continueRow(items, now = Date.now()) {
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
    const marker = item.path.indexOf('/Movies/');
    if (marker >= 0) {
      const rest = item.path.slice(marker + 8);
      if (rest.includes('/')) return rest.slice(0, rest.indexOf('/'));
    }
    return item.kind === 'film' ? 'films' : 'other';
  }
  const label = key => key.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());

  /** Collection rows, most recently watched collection first; [{ key, title, items }]. */
  function collectionRows(items, skip = new Set()) {
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
          : members.sort((a, b) => episodeNumber(a) - episodeNumber(b))[0];
        if (pick) cards.push({ item: { ...pick, title: pick.title }, seen: false, at: watched ? String(watched.updatedAt) : '' });
      }
      // Unseen first; within that, recently watched shows, then title order.
      cards.sort((a, b) => (a.seen - b.seen) || b.at.localeCompare(a.at) ||
        a.item.title.localeCompare(b.item.title, undefined, { numeric: true }));
      if (cards.length) rows.push({ key: group.key, title: group.title, lastWatched: group.lastWatched, items: cards.map(card => card.item) });
    }
    return rows.sort((a, b) => b.lastWatched.localeCompare(a.lastWatched) || a.title.localeCompare(b.title));
  }

  /**
   * Finished things that could be cleared: a show whose latest-watched episode
   * is seen with nothing unseen after it, or a seen film. Newest first.
   * [{ key, title, paths, episodes, watchedAt }]
   */
  function watchedList(items) {
    const groups = new Map();
    for (const item of items) {
      // Kids rewatch favourites; their collections are never offered for clearing.
      if (/kids|family/i.test(collectionOf(item))) continue;
      const key = showKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const list = [];
    for (const [key, members] of groups) {
      const watched = members.filter(touched).sort((a, b) => (later(a, b) ? -1 : 1))[0];
      if (!watched || !seen(watched)) continue;
      const isShow = episodeNumber(watched) !== null;
      if (isShow && nextEpisode(members, watched)) continue;
      list.push({ key, title: isShow ? fileName(key) : watched.title, paths: members.map(item => item.path),
        episodes: isShow ? members.length : 0, watchedAt: String(watched.updatedAt) });
    }
    return list.sort((a, b) => b.watchedAt.localeCompare(a.watchedAt));
  }

  root.watchedList = watchedList;
  root.continueRow = continueRow;
  root.collectionRows = collectionRows;
  root.libraryShowKey = showKey;
})(globalThis);
