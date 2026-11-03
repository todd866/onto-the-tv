/* Desktop channel browser. The server owns the lineup, picks and rating ceiling. */
(() => {
  const origin = 'http://localhost:8686';
  const $ = id => document.getElementById(id);
  let viewers; // Omitted means the server's safe, whole-family default.
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
  function controls(home) {
    if (!$('channel-viewers').children.length) {
      for (const person of home.viewers) {
        const label = document.createElement('label');
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = person.id;
        input.setAttribute('aria-label', person.name);
        label.title = person.id === 'sam' ? 'Sam · G' : person.id === 'jake' ? 'Jake · PG' : `${person.name} · unrestricted`;
        const icon = document.createElement('span'); icon.className = 'viewer-icon'; icon.innerHTML = personIcon;
        label.append(input, icon, document.createTextNode(person.name));
        input.onchange = () => {
          viewers = [...$('channel-viewers').querySelectorAll('input:checked')].map(el => el.value);
          stop(); art.clear(); void refresh(true);
        };
        $('channel-viewers').append(label);
      }
    }
    for (const input of $('channel-viewers').querySelectorAll('input')) input.checked = home.viewers.some(p => p.id === input.value && p.on);
    viewers = home.viewers.filter(p => p.on).map(p => p.id);
    $('channel-ceiling').textContent = home.ceiling || '—';
    $('channel-ceiling').dataset.rating = home.ceiling || '';
    $('channel-ceiling').title = home.ceiling ? `Rating ceiling: ${home.ceiling}` : 'No viewers selected';
    $('channel-ceiling').setAttribute('aria-label', $('channel-ceiling').title);
  }
  async function refresh(changed = false) {
    if (!window.tv?.getTvHome) return;
    const request = ++generation;
    loading = true; state('↻', 'Loading channels');
    // A previous audience's picks must never remain actionable while changing viewers.
    if (changed) {
      loaded = false; $('channel-list').replaceChildren();
      $('channel-ceiling').textContent = '—'; $('channel-ceiling').dataset.rating = '';
      $('channel-ceiling').title = 'Rating ceiling pending';
      $('channel-ceiling').setAttribute('aria-label', 'Rating ceiling pending');
    }
    try {
      const home = await window.tv.getTvHome(viewers);
      if (request !== generation) return;
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
