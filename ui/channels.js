/* Desktop channel browser. The server owns the lineup, picks and rating ceiling. */
(() => {
  // The server that answered the last lineup: the M2, or this Mac's own as a fallback.
  // The M2 on the home network, the M2 over the tailnet, then this Mac's own server (src/tv-home-client.js).
  const ORIGINS = ['http://192.168.20.20:8686', 'https://iantodds-macbook-air.tail8cd07b.ts.net:8443', 'http://localhost:8686'];
  let origin = ORIGINS[0];
  const $ = id => document.getElementById(id);
  // Who's watching is a profile: a person (or Everyone) with their own colours, rating,
  // channels and layout. The youngest in the audience sets the default rating; the switch
  // overrides it either way until the profile changes. This Mac opens on Ian.
  const PROFILES = [
    { id: 'ian', name: 'Ian', mark: 'I', viewers: ['dad'], layout: 'now' },
    { id: 'fran', name: 'Fran', mark: 'F', viewers: ['mum'], layout: 'guide' },
    { id: 'jake', name: 'Jake', mark: 'J', viewers: ['jake', 'mum', 'dad'], layout: 'pictures' },
    { id: 'sam', name: 'Sam', mark: 'S', viewers: ['sam', 'mum', 'dad'], layout: 'pictures' },
    { id: 'all', name: 'Everyone', mark: '★', viewers: ['sam', 'jake', 'mum', 'dad'], layout: 'now' },
  ];
  const RATINGS = ['G', 'PG', 'M'];
  const LAYOUTS = [['now', '▣', 'Now on'], ['guide', '☰', 'Guide'], ['pictures', '▦', 'Pictures']];
  const KEY = 'onto.desktop.profile';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  let profile = PROFILES.find(p => p.id === saved.profile) || PROFILES[0];
  let rating = RATINGS.includes(saved.rating) ? saved.rating : null;
  const layouts = saved.layouts && typeof saved.layouts === 'object' ? saved.layouts : {};
  let viewers = profile.viewers;
  let defaultCeiling = null, lineup = [];
  let generation = 0, loaded = false, loading = false;
  const art = new Map();
  let selectedChannel;
  const layoutOf = () => (LAYOUTS.some(([id]) => id === layouts[profile.id]) ? layouts[profile.id] : profile.layout);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ profile: profile.id, rating, layouts })); } catch { /* session only */ } };

  function returnFocus() {
    const cards = [...$('channel-list').querySelectorAll('button')];
    (cards.find(el => el.dataset.channel === selectedChannel) || cards[0])?.focus();
  }
  function state(symbol, description, retry = 'Channels unavailable · Retry') {
    $('channel-state').textContent = symbol;
    $('channel-feedback').textContent = symbol === '⚠' ? retry : symbol === '∅' ? description : '';
    $('channel-feedback').hidden = !['⚠', '∅'].includes(symbol);
    $('channel-feedback').disabled = symbol !== '⚠';
    $('channel-state').title = description;
    $('channel-state').setAttribute('aria-label', description);
  }
  // Play on TV: the lounge TV's own app tunes the channel, or plays the episode a found show opens on.
  // Nothing plays here; the card wears the TV mark once the TV has taken it.
  async function onTv(channel, button) {
    if (!window.tv?.sendToTv || button.dataset.tv === 'sending') return;
    selectedChannel = channel.id;
    button.dataset.tv = 'sending';
    window.appMessage?.('');
    try {
      if (channel.play) await window.tv.sendToTv(origin, 'play', channel.play.src, channel.play.resume || null);
      else await window.tv.sendToTv(origin, 'tune', channel.id);
      button.dataset.tv = 'on';
      setTimeout(() => { if (button.dataset.tv === 'on') delete button.dataset.tv; }, 6000);
    } catch (error) {
      delete button.dataset.tv;
      window.appMessage?.(String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    }
  }
  // Tuning: the pressed channel's own card fills the stage in the frame of the click. The player loads
  // behind it and says when it has a picture (or that the server refused); only then does it show.
  const TUNE_WAIT_MS = 12000, PICTURE_WAIT_MS = 30000, HELLO_WAIT_MS = 600;
  let tuned = null, tuneTimer = 0, helloTimer = 0, playerSaysHello = false, tuneCount = 0;
  function endTuning() {
    clearTimeout(tuneTimer); clearTimeout(helloTimer);
    $('channel-tuning').hidden = true;
  }
  function tuneFault(detail) {
    if (!tuned || $('channel-tuning').hidden) return;
    clearTimeout(tuneTimer);
    $('channel-tuning').classList.add('is-fault');
    $('tuning-retry').hidden = false;
    $('tuning-retry').title = detail;
    $('tuning-retry').setAttribute('aria-label', `${tuned.name} unavailable: ${detail} Retry`);
    $('tuning-retry').focus();
  }
  function stop() {
    endTuning(); tuned = null;
    if (!$('channel-player').hidden) {
      $('channel-player').src = 'about:blank';
      $('channel-player').hidden = true;
      $('channel-home').hidden = false;
      $('channel-back').hidden = true;
    }
  }
  function tune(channel) {
    selectedChannel = channel.id; tuned = channel; playerSaysHello = false; channel.queueSent = false;
    const url = new URL('/', origin);
    url.searchParams.set('desktop', '1');
    // Each tune is numbered and the player says the number back: a message still in flight from the
    // page before (its "playing", its "home") must not lift this card or close this tune.
    url.searchParams.set('n', String(++tuneCount));
    url.searchParams.set('viewers', viewers.join(','));
    if (rating) url.searchParams.set('rating', rating);
    if (channel.play) {
      // A named episode from Find a show; the rest of the show follows once it is up.
      url.searchParams.set('play', channel.play.src);
      url.searchParams.set('title', channel.play.title);
      url.searchParams.set('show', channel.name);
      if (channel.play.resume) url.searchParams.set('at', String(channel.play.resume));
    } else url.searchParams.set('channel', channel.id);
    $('tuning-number').textContent = channel.number;
    $('tuning-name').textContent = channel.name;
    $('tuning-show').textContent = channel.now?.show ? `▶ ${channel.now.show}` : '';
    $('tuning-picture').replaceChildren();
    withArt($('tuning-picture'), channel.now?.art);
    $('channel-tuning').classList.remove('is-fault');
    $('tuning-retry').hidden = true;
    $('channel-tuning').hidden = false;
    $('channel-player').src = url.href;
    $('channel-player').hidden = false;
    $('channel-home').hidden = true;
    $('channel-back').hidden = false;
    $('channel-back').focus();
    clearTimeout(tuneTimer); clearTimeout(helloTimer);
    tuneTimer = setTimeout(() => tuneFault('No answer from the TV server.'), TUNE_WAIT_MS);
  }
  // A player page from before 15 Nov 2026 reports nothing: show it as soon as it has loaded.
  $('channel-player').addEventListener('load', () => {
    if (!tuned || $('channel-tuning').hidden) return;
    clearTimeout(helloTimer);
    helloTimer = setTimeout(() => { if (!playerSaysHello) endTuning(); }, HELLO_WAIT_MS);
  });
  $('tuning-retry').onclick = () => { if (tuned) tune(tuned); };
  function picture(path) {
    // Only the server's artwork route is usable, never a supplied external URL.
    if (typeof path !== 'string' || !path.startsWith('/art?')) return null;
    if (!art.has(path)) {
      const image = new Image(); image.alt = ''; image.decoding = 'async';
      image.src = origin + path;
      const ready = image.decode().then(() => image).catch(() => { art.delete(path); return null; });
      art.set(path, ready);
    }
    return art.get(path);
  }
  function span(className, text) { const el = document.createElement('span'); el.className = className; el.textContent = text; return el; }
  function withArt(holder, path) {
    const ready = picture(path);
    if (ready) void ready.then(img => { if (img && holder.isConnected) holder.replaceChildren(img.cloneNode()); });
  }
  const minutes = now => (now?.minutes ? `${now.minutes} min` : '');
  const nextLine = now => (now?.next ? `Next · ${now.next.show}${now.next.title ? ' · ' + now.next.title : ''}` : '');

  // The "now on" panel: the focused or hovered channel, large.
  function hero(channel) {
    const panel = $('channel-hero');
    if (!channel || layoutOf() === 'pictures') { panel.hidden = true; return; }
    panel.hidden = false;
    const image = span('hero-picture', '');
    const copy = span('hero-copy', '');
    const found = Boolean(channel.play);
    copy.append(span('hero-channel', found ? `${channel.episodes} ${channel.episodes === 1 ? 'episode' : 'episodes'}` : `${channel.number} · ${channel.name}`),
      span('hero-show', found ? channel.name : channel.now?.show || '—'));
    const detail = found ? channel.now.show : channel.now?.title;
    if (detail) copy.append(span('hero-title', detail));
    if (channel.now?.minutes) copy.append(span('hero-length', minutes(channel.now)));
    if (channel.now?.next) copy.append(span('hero-next', nextLine(channel.now)));
    panel.replaceChildren(image, copy);
    withArt(image, channel.now?.art);
  }
  function card(channel) {
    const layout = layoutOf();
    const button = document.createElement('button'); button.type = 'button'; button.className = `channel-card layout-${layout}`;
    button.dataset.channel = channel.id;
    const found = Boolean(channel.play);
    const show = channel.now?.show || (found ? '' : '—');
    button.title = [found ? channel.name : `${channel.number} · ${channel.name}`, show, channel.now?.title, minutes(channel.now), nextLine(channel.now)].filter(Boolean).join('\n');
    button.setAttribute('aria-label', found ? `Play ${channel.name}${show ? ': ' + show : ''}`
      : `Play channel ${channel.number}, ${channel.name}: ${show}${channel.now?.title ? ', ' + channel.now.title : ''}`);
    const image = span('channel-picture', '');
    if (layout === 'guide') {
      const name = span('guide-channel', ''); name.append(span('channel-number', channel.number), span('channel-name', channel.name));
      const now = span('guide-now', ''); now.append(span('guide-show', show || channel.name), span('guide-title', [channel.now?.title, minutes(channel.now)].filter(Boolean).join(' · ')));
      const next = span('guide-next', channel.now?.next ? `${channel.now.next.show}${channel.now.next.title ? ' · ' + channel.now.next.title : ''}` : '');
      button.append(image, name, now, next);
    } else if (layout === 'pictures') {
      button.append(image, span('picture-label', channel.name));
    } else {
      const row = span('channel-readout', '');
      row.append(span('channel-number', channel.number), span('channel-name', channel.name), span('channel-now', show ? `▶ ${show}` : ''));
      button.append(image, row);
    }
    button.onclick = () => (window.playOnTarget?.() === 'tv' ? onTv(channel, button) : tune(channel));
    button.addEventListener('focus', () => hero(channel));
    button.addEventListener('mouseenter', () => hero(channel));
    withArt(image, channel.now?.art);
    return button;
  }
  function segment(group, value, label, title, onClick) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.value = value;
    button.title = title; button.setAttribute('aria-label', title);
    button.textContent = label; button.onclick = onClick;
    $(group).append(button);
    return button;
  }
  function paintProfile() {
    $('local-view').dataset.profile = profile.id;
    $('channel-avatar').textContent = profile.mark;
    $('channel-who').textContent = profile.name;
    $('channel-profile').setAttribute('aria-label', `Who's watching: ${profile.name}. Change`);
    for (const button of $('channel-layout').children) button.setAttribute('aria-pressed', String(button.dataset.value === layoutOf()));
    $('channel-list').className = `layout-${layoutOf()}`;
  }
  function controls(home) {
    if (!$('channel-rating').children.length) {
      for (const value of RATINGS) {
        segment('channel-rating', value, value, `Rated ${value}`,
          // Picking the profile's own rating clears the override.
          () => { rating = value === defaultCeiling ? null : value; save(); stop(); void refresh(true); }).dataset.rating = value;
      }
      for (const [id, glyph, name] of LAYOUTS) {
        segment('channel-layout', id, glyph, name, () => { layouts[profile.id] = id; save(); paintProfile(); render(); });
      }
    }
    defaultCeiling = home ? home.defaultCeiling ?? null : null;
    const ceiling = home ? home.ceiling : null;
    for (const button of $('channel-rating').children) {
      button.setAttribute('aria-pressed', String(button.dataset.value === ceiling));
      button.classList.toggle('default', button.dataset.value === defaultCeiling);
      button.title = `Rated ${button.dataset.value}${button.dataset.value === defaultCeiling ? ` (${profile.name}'s rating)` : ''}`;
    }
    paintProfile();
  }
  function choose(next) {
    profile = next; viewers = profile.viewers; rating = null; save();
    $('channel-picker').hidden = true;
    stop(); art.clear(); void refresh(true);
    $('channel-profile').focus();
  }
  function picker() {
    const people = $('channel-picker-people');
    if (!people.children.length) {
      for (const person of PROFILES) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'picker-person'; button.dataset.profile = person.id;
        button.append(span('avatar', person.mark), span('picker-name', person.name));
        button.onclick = () => choose(person);
        people.append(button);
      }
    }
    $('channel-picker').hidden = false;
    people.querySelector(`[data-profile="${profile.id}"]`)?.focus();
  }
  // Find a show: this audience's shows from the same server, filtered here as each letter lands.
  let shows = null, showsFor = '', showsAsked = '', query = '';
  const audienceKey = () => `${viewers.join(',')}|${rating || ''}`;
  async function loadShows(again = false) {
    const key = audienceKey();
    if (!window.tv?.getTvShows || (shows && showsFor === key) || (showsAsked === key && !again)) return;
    showsAsked = key;
    if (query) state('↻', 'Loading shows');
    try {
      const result = await window.tv.getTvShows(viewers, rating);
      if (audienceKey() !== key) return;
      if (!ORIGINS.includes(result.origin)) throw new Error('Unexpected TV server.');
      if (result.origin !== origin) { art.clear(); origin = result.origin; }
      shows = result.shows; showsFor = key;
    } catch (error) {
      if (audienceKey() !== key) return;
      showsAsked = '';
      if (query) state('⚠', `Shows unavailable: ${error.message}`, 'Shows unavailable · Retry');
      return;
    }
    if (query) render();
  }
  // The episode a show opens on: the one last left part-way, else the first not finished.
  function opening(show) {
    const left = show.episodes.filter(item => item.resume).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return left || show.episodes.find(item => !item.completed) || show.episodes[0];
  }
  function showTile(show, first) {
    const at = show.episodes.indexOf(first);
    const rest = [...show.episodes.slice(at + 1), ...show.episodes.slice(0, at)];
    return { id: `show:${show.title}`, number: '', name: show.title, episodes: show.episodes.length,
      now: { show: first.title === show.title ? '' : first.title, title: '', minutes: first.minutes, art: first.art || show.art,
        next: rest[0] ? { show: rest[0].title, title: '' } : null },
      play: first, queue: rest.slice(0, 60).map(item => ({ src: item.src, title: item.title })) };
  }
  function matches() {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const has = value => { const lower = value.toLocaleLowerCase(); return words.every(word => lower.includes(word)); };
    const ranked = [[], [], []];
    // Another audience's shows are never offered while this one's are on their way.
    for (const show of (showsFor === audienceKey() && shows) || []) {
      if (has(show.title)) ranked[show.title.toLocaleLowerCase().startsWith(words[0]) ? 0 : 1].push(showTile(show, opening(show)));
      else {
        // A show whose name does not match still answers for an episode that does.
        const named = show.episodes.find(item => has(item.title));
        if (named) ranked[2].push(showTile(show, named));
      }
    }
    return ranked.flat().slice(0, 60);
  }
  function tiles() { return query ? matches() : lineup; }
  function render() {
    const list = tiles();
    $('channel-list').replaceChildren(...list.map(card));
    hero(list[0]);
    if (!query) return;
    if (!shows || showsFor !== audienceKey()) { if ($('channel-state').textContent !== '⚠') state('↻', 'Loading shows'); }
    else state(list.length ? '' : '∅', list.length ? '' : 'No show by that name');
  }
  async function refresh(changed = false) {
    if (!window.tv?.getTvHome) return;
    const request = ++generation;
    loading = true; state('↻', 'Loading channels');
    // A previous audience's picks must never remain actionable while changing viewers.
    if (changed) { loaded = false; lineup = []; $('channel-list').replaceChildren(); $('channel-hero').hidden = true; controls(null); }
    try {
      const home = await window.tv.getTvHome(viewers, rating);
      if (request !== generation) return;
      if (!ORIGINS.includes(home.origin)) throw new Error('Unexpected TV server.');
      if (home.origin !== origin) { art.clear(); origin = home.origin; }
      controls(home);
      // Keep the artwork cache bounded to the current lineup.
      const paths = new Set(home.channels.map(channel => channel.now?.art));
      for (const path of art.keys()) if (!paths.has(path)) art.delete(path);
      lineup = home.channels;
      loaded = true;
      render();
      if (!query) state(home.channels.length ? '' : '∅', home.channels.length ? '' : 'No channels for this rating');
      // The shows are fetched behind the lineup, so the first letter typed already has its answer.
      void loadShows();
    } catch (error) {
      if (request !== generation) return;
      state('⚠', `Channels unavailable: ${error.message}. Use Refresh channels to retry.`);
    } finally { if (request === generation) loading = false; }
  }
  $('channel-profile').onclick = picker;
  $('channel-picker').addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('channel-picker').hidden = true; $('channel-profile').focus(); return; }
    const people = [...$('channel-picker-people').children], at = people.indexOf(document.activeElement);
    if (at < 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault(); people[(at + (event.key === 'ArrowRight' ? 1 : people.length - 1)) % people.length].focus();
    }
  });
  $('channel-refresh').onclick = () => { stop(); shows = null; showsAsked = ''; void refresh(); };
  $('channel-back').onclick = () => { stop(); returnFocus(); };
  $('channel-feedback').onclick = () => { stop(); if (query && loaded) void loadShows(true); else void refresh(); };
  $('channel-search').addEventListener('focus', () => void loadShows());
  $('channel-search').addEventListener('input', () => {
    const next = $('channel-search').value.trim();
    if (next === query) return;
    const was = query; query = next;
    stop();
    if (query) void loadShows();
    render();
    if (was && !query) state(lineup.length ? '' : '∅', lineup.length ? '' : 'No channels for this rating');
  });
  $('channel-search').addEventListener('keydown', event => {
    const first = $('channel-list').querySelector('button');
    if (!first || !query) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); first.focus(); }
    if (event.key === 'Enter') { event.preventDefault(); first.click(); }
  });
  $('channel-list').addEventListener('keydown', event => {
    const cards = [...$('channel-list').querySelectorAll('button')];
    const current = cards.indexOf(document.activeElement);
    if (current < 0 || event.altKey || event.metaKey || event.ctrlKey) return;
    const columns = getComputedStyle($('channel-list')).gridTemplateColumns.split(' ').length;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    let index;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = cards.length - 1;
    else if (event.key in moves) index = Math.max(0, Math.min(cards.length - 1, current + moves[event.key]));
    else return;
    event.preventDefault(); cards[index].focus();
  });
  window.addEventListener('message', event => {
    if (event.origin !== origin || event.source !== $('channel-player').contentWindow) return;
    const type = event.data?.type;
    if (event.data?.n && event.data.n !== String(tuneCount)) return;
    if (type === 'onto:desktop-home') { stop(); returnFocus(); }
    if (type === 'onto:desktop-hello') playerSaysHello = true;
    // The rest of a found show goes to the player once it has the episode.
    if ((type === 'onto:desktop-loading' || type === 'onto:desktop-playing') && tuned?.queue?.length && !tuned.queueSent) {
      tuned.queueSent = true;
      event.source.postMessage({ type: 'onto:desktop-queue', queue: tuned.queue }, origin);
    }
    if (type === 'onto:desktop-loading' && !$('channel-tuning').hidden && !$('channel-tuning').classList.contains('is-fault')) {
      // The server answered and the episode is loading: the card waits for the picture, and if none has
      // come in half a minute the player is shown as it is, with its own retry line.
      clearTimeout(tuneTimer);
      tuneTimer = setTimeout(endTuning, PICTURE_WAIT_MS);
    }
    if (type === 'onto:desktop-playing' && !$('channel-tuning').hidden) {
      endTuning();
      // Keys now belong to the player: Space pauses instead of pressing Back.
      try { $('channel-player').contentWindow.focus(); } catch { /* stays on Back */ }
    }
    if (type === 'onto:desktop-error') {
      const status = Number(event.data.status) || 0;
      tuneFault(status === 403 ? 'The TV server refused this app (403).' : status < 0 ? 'The picture did not start.' : status ? `The TV server answered ${status}.` : 'No answer from the TV server.');
    }
  });
  paintProfile();
  window.channelView = { refresh, stop, enter() { if (!loaded && !loading) void refresh(); } };
})();
