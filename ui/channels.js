/* Desktop channel browser. The server owns the lineup, picks and rating ceiling. */
(() => {
  // The server that answered the last lineup: the M2, or this Mac's own as a fallback.
  const ORIGINS = ['http://iantodds-macbook-air.tail8cd07b.ts.net:8686', 'http://localhost:8686'];
  let origin = ORIGINS[0];
  const $ = id => document.getElementById(id);
  // Who's watching: the youngest in the room sets the default rating; the rating
  // switch overrides it either way until the audience changes. This Mac is a
  // grown-up's screen, so it opens on Mum & Dad and remembers the last choice.
  const WHO = [
    { id: 'sam', name: 'Sam', viewers: ['sam', 'jake', 'mum', 'dad'], rating: 'G' },
    { id: 'jake', name: 'Jake', viewers: ['jake', 'mum', 'dad'], rating: 'PG' },
    { id: 'adults', name: 'Mum & Dad', viewers: ['mum', 'dad'], rating: 'M' },
  ];
  const RATINGS = ['G', 'PG', 'M'];
  const AUDIENCE_KEY = 'onto.desktop.audience';
  let who = 'adults', rating = null;
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIENCE_KEY) || 'null');
    if (WHO.some(entry => entry.id === saved?.who)) { who = saved.who; rating = RATINGS.includes(saved.rating) ? saved.rating : null; }
  } catch { /* keep the default */ }
  let viewers = WHO.find(entry => entry.id === who).viewers;
  let defaultCeiling = null;
  let generation = 0, loaded = false, loading = false;
  const art = new Map();
  let selectedChannel;
  const personIcon = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="18" r="10"/><path d="M12 54c2-16 10-22 20-22s18 6 20 22"/></svg>';
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
  function card(channel) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'channel-card';
    button.dataset.channel = channel.id;
    const show = channel.now?.show || '—';
    button.title = `${channel.number} · ${channel.name} · ${show}`;
    button.setAttribute('aria-label', `Play channel ${channel.number}, ${channel.name}: ${show}`);
    const image = document.createElement('span'); image.className = 'channel-picture';
    const row = document.createElement('span'); row.className = 'channel-readout';
    for (const [name, value] of [['number', channel.number], ['name', channel.name], ['now', `▶ ${show}`]]) {
      const span = document.createElement('span'); span.className = `channel-${name}`; span.textContent = value; row.append(span);
    }
    button.append(image, row);
    button.onclick = () => tune(channel);
    // Small, bounded lineup: prepare all card art once, reuse on return to Channels.
    const ready = picture(channel.now?.art);
    if (ready) void ready.then(img => { if (img && button.isConnected) image.append(img.cloneNode()); });
    return button;
  }
  function choose(nextWho, nextRating) {
    who = nextWho; rating = nextRating;
    viewers = WHO.find(entry => entry.id === who).viewers;
    try { localStorage.setItem(AUDIENCE_KEY, JSON.stringify({ who, rating })); } catch { /* session only */ }
    stop(); art.clear(); void refresh(true);
  }
  function segment(group, value, label, title, onClick) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.value = value;
    button.title = title; button.setAttribute('aria-label', title);
    button.innerHTML = label; button.onclick = onClick;
    $(group).append(button);
  }
  function controls(home) {
    if (!$('channel-viewers').children.length) {
      for (const entry of WHO) {
        segment('channel-viewers', entry.id, `<span class="viewer-icon">${personIcon}</span><span></span>`, `Youngest watching: ${entry.name} · ${entry.rating}`,
          () => choose(entry.id, null));
        $('channel-viewers').lastChild.lastChild.textContent = entry.name;
      }
      for (const value of RATINGS) {
        segment('channel-rating', value, value, `Rated ${value}`,
          // Picking the people's own rating clears the override.
          () => { if (who) choose(who, value === defaultCeiling ? null : value); });
        $('channel-rating').lastChild.dataset.rating = value;
      }
    }
    defaultCeiling = home ? home.defaultCeiling ?? null : null;
    const ceiling = home ? home.ceiling : null;
    for (const button of $('channel-viewers').children) button.setAttribute('aria-pressed', String(button.dataset.value === who));
    for (const button of $('channel-rating').children) {
      button.setAttribute('aria-pressed', String(button.dataset.value === ceiling));
      button.classList.toggle('default', button.dataset.value === defaultCeiling);
      button.title = `Rated ${button.dataset.value}${button.dataset.value === defaultCeiling ? ' (default for who is watching)' : ''}`;
    }
  }
  async function refresh(changed = false) {
    if (!window.tv?.getTvHome) return;
    const request = ++generation;
    loading = true; state('↻', 'Loading channels');
    // A previous audience's picks must never remain actionable while changing viewers.
    if (changed) {
      loaded = false; $('channel-list').replaceChildren();
      controls(null);
      for (const button of $('channel-viewers').children) button.setAttribute('aria-pressed', String(button.dataset.value === who));
    }
    try {
      const home = await window.tv.getTvHome(viewers, rating);
      if (request !== generation) return;
      if (!ORIGINS.includes(home.origin)) throw new Error('Unexpected TV server.');
      if (home.origin !== origin) { art.clear(); origin = home.origin; }
      controls(home);
      // Keep the artwork cache bounded to the current lineup.
      const paths = new Set(home.channels.map(channel => channel.now?.art));
      for (const path of art.keys()) if (!paths.has(path)) art.delete(path);
      $('channel-list').replaceChildren(...home.channels.map(card));
      loaded = true;
      state(home.channels.length ? '' : '∅', home.channels.length ? '' : viewers.length ? 'No channels for these viewers' : 'Choose who is watching');
    } catch (error) {
      if (request !== generation) return;
      state('⚠', `Channels unavailable: ${error.message}. Use Refresh channels to retry.`);
    } finally { if (request === generation) loading = false; }
  }
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
  window.channelView = { refresh, stop, enter() { if (!loaded && !loading) void refresh(); } };
})();
