/* Desktop channel browser. The server owns the lineup, picks and rating ceiling. */
(() => {
  // The server that answered the last lineup: the M2, or this Mac's own as a fallback.
  const ORIGINS = ['https://iantodds-macbook-air.tail8cd07b.ts.net:8443', 'http://localhost:8686'];
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
  function state(symbol, description) {
    $('channel-state').textContent = symbol;
    $('channel-feedback').textContent = symbol === '⚠' ? 'Channels unavailable · Retry' : symbol === '∅' ? description : '';
    $('channel-feedback').hidden = !['⚠', '∅'].includes(symbol);
    $('channel-feedback').disabled = symbol !== '⚠';
    $('channel-state').title = description;
    $('channel-state').setAttribute('aria-label', description);
  }
  function stop() {
    if (!$('channel-player').hidden) {
      $('channel-player').src = 'about:blank';
      $('channel-player').hidden = true;
      $('channel-home').hidden = false;
      $('channel-back').hidden = true;
    }
  }
  function tune(channel) {
    selectedChannel = channel.id;
    const url = new URL('/', origin);
    url.searchParams.set('desktop', '1');
    url.searchParams.set('viewers', viewers.join(','));
    if (rating) url.searchParams.set('rating', rating);
    url.searchParams.set('channel', channel.id);
    $('channel-player').src = url.href;
    $('channel-player').hidden = false;
    $('channel-home').hidden = true;
    $('channel-back').hidden = false;
    $('channel-back').focus();
  }
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
    copy.append(span('hero-channel', `${channel.number} · ${channel.name}`), span('hero-show', channel.now?.show || '—'));
    if (channel.now?.title) copy.append(span('hero-title', channel.now.title));
    if (channel.now?.minutes) copy.append(span('hero-length', minutes(channel.now)));
    if (channel.now?.next) copy.append(span('hero-next', nextLine(channel.now)));
    panel.replaceChildren(image, copy);
    withArt(image, channel.now?.art);
  }
  function card(channel) {
    const layout = layoutOf();
    const button = document.createElement('button'); button.type = 'button'; button.className = `channel-card layout-${layout}`;
    button.dataset.channel = channel.id;
    const show = channel.now?.show || '—';
    button.title = [`${channel.number} · ${channel.name}`, show, channel.now?.title, minutes(channel.now), nextLine(channel.now)].filter(Boolean).join('\n');
    button.setAttribute('aria-label', `Play channel ${channel.number}, ${channel.name}: ${show}${channel.now?.title ? ', ' + channel.now.title : ''}`);
    const image = span('channel-picture', '');
    if (layout === 'guide') {
      const name = span('guide-channel', ''); name.append(span('channel-number', channel.number), span('channel-name', channel.name));
      const now = span('guide-now', ''); now.append(span('guide-show', show), span('guide-title', [channel.now?.title, minutes(channel.now)].filter(Boolean).join(' · ')));
      const next = span('guide-next', channel.now?.next ? `${channel.now.next.show}${channel.now.next.title ? ' · ' + channel.now.next.title : ''}` : '');
      button.append(image, name, now, next);
    } else if (layout === 'pictures') {
      button.append(image, span('picture-label', channel.name));
    } else {
      const row = span('channel-readout', '');
      row.append(span('channel-number', channel.number), span('channel-name', channel.name), span('channel-now', `▶ ${show}`));
      button.append(image, row);
    }
    button.onclick = () => tune(channel);
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
  function render() {
    $('channel-list').replaceChildren(...lineup.map(card));
    hero(lineup[0]);
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
      render();
      loaded = true;
      state(home.channels.length ? '' : '∅', home.channels.length ? '' : 'No channels for this rating');
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
  $('channel-refresh').onclick = () => { stop(); void refresh(); };
  $('channel-back').onclick = () => { stop(); returnFocus(); };
  $('channel-feedback').onclick = () => { stop(); void refresh(); };
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
    if (event.origin === origin && event.source === $('channel-player').contentWindow && event.data?.type === 'onto:desktop-home') { stop(); returnFocus(); }
  });
  paintProfile();
  window.channelView = { refresh, stop, enter() { if (!loaded && !loading) void refresh(); } };
})();
