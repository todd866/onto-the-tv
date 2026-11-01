/* Onto the TV: Samsung Tizen 3 / Chromium 47 compatible browser code. */
(function () {
  'use strict';
  // Served by the Mac, the page talks to its own origin. Packaged as the TV app,
  // config.js supplies the Mac's likely addresses and the pairing token.
  var CONFIG = window.ONTO_CONFIG || {};
  var TOKEN = CONFIG.token || '';
  var PACKAGED = !(location.protocol === 'http:' || location.protocol === 'https:');
  var SERVER = PACKAGED ? '' : location.origin;

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232,
    CH_UP: 427, CH_DOWN: 428, SPACE: 32 };
  var ICONS = { '2': '🧸', '6': '🚀', christmas: '🎄', movies: '🍿', grown: '🎬', music: '🎵', all: '🔀' };
  var SEEK = 30, SAVE_EVERY = 15000, OSD_MS = 4000;

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video'), osd = $('osd');
  var data = { channels: [], continueWatching: [], shows: [] };
  var rows = [];            // [{ el, items, kind }]
  var focus = { row: 0, col: 0 };
  var page = null;          // null for home, or the channel whose shows are open
  var openShow = null;      // { name, episodes } while the shows row lists one show's episodes
  var showCache = Object.create(null), cacheOrder = [], initialHome = true;
  var artCache = Object.create(null), artOrder = [];
  // The Mac mini or Air running the TV offers YouTube and the TV's own tuner; a browser does not.
  var SHELL = window.ontoShell || null;
  var play = null;          // { mode: 'channel'|'show'|'single', channel, list, index, item, visitStart, lastSave }
  var osdTimer = 0, gameState = null, tuneRequest = 0;
  var lastPlayingDiagnostic = 0;
  var mediaState = 'starting', lastProgressAt = 0, previousMediaTime = 0;
  var watchTracker = null, watchDelivery = null;
  var watchSession = 'tv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  var watchSequence = 0;

  // The parent may install this bridge before the TV page loads. Keep telemetry
  // fire-and-forget and send only bounded playback state, never media identity.
  function diag(event, fields) {
    var bridge = window.ontoDiagnostics;
    if (bridge && typeof bridge.emit === 'function') {
      try { bridge.emit(event, fields || {}); } catch (e) {}
    }
  }
  function diagnosticSample() {
    if (gameState) return { page: 'games', game: gameState.game, state: gameState.state, engine: 'video', paused: gameState.state === 'paused', position: 0, duration: 0 };
    if (!media) return { page: 'home', engine: 'video', state: 'starting' };
    var paused = !play || media.paused();
    var state = mediaState;
    if (state === 'playing' && Date.now() - lastProgressAt > 15000) state = 'buffering';
    return { page: !$('setup').hidden ? 'setup' : play ? 'player' : 'home', engine: media.engine || 'video', position: play ? media.time() : 0,
      duration: play ? media.duration() : 0, paused: paused, hidden: document.hidden,
      state: play ? (state === 'loading' || state === 'error' ? state : paused ? 'paused' : state) : mediaState };
  }
  if (!window.ontoDiagnostics) window.ontoDiagnostics = {};
  if (typeof window.ontoDiagnostics.sample === 'function') window.ontoDiagnostics.sample(diagnosticSample);


  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (TOKEN) options.headers['X-Onto-Token'] = TOKEN;
    return fetch(SERVER + path, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) { var error = new Error(body.error || ('Server error ' + response.status)); error.status = response.status; throw error; }
        return body;
      });
    });
  }
  function q(value) { return encodeURIComponent(value); }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function watchChannel() { return play && play.channel ? String(play.channel.id) : 'all'; }
  function ensureWatchDelivery() {
    if (!watchDelivery) {
      var scope = 2166136261, material = TOKEN + '|' + (CONFIG.servers || []).join('|');
      for (var i = 0; i < material.length; i++) scope = ((scope ^ material.charCodeAt(i)) * 16777619) >>> 0;
      var storage; try { storage = window.localStorage; } catch (_) { storage = {getItem:function(){return null;},setItem:function(){}}; }
      watchDelivery = window.ontoWatchDelivery(function (item) {
        return Promise.race([post('/api/watch', item), new Promise(function (_, reject) { setTimeout(function () { reject(new Error('Watch delivery timed out')); }, 10000); })]);
      }, storage, String(scope), null, function (code) { diag('watch_delivery_error', {errorCode:code}); });
    }
    return watchDelivery;
  }
  function watchEvent(reason) {
    if (!play || !play.item) return;
    var watched = Math.max(0, Number(play.watchedSeconds) || 0);
    var body = { src: play.item.src, channel: watchChannel(), audience: watchChannel(), sessionId: watchSession,
      sequence: watchSequence++, reason: reason, observedAt: new Date().toISOString(), watchedSeconds: Math.round(watched), durationSeconds: Math.floor(media.duration() || play.item.duration || 0) };
    ensureWatchDelivery();
    if (!watchDelivery.enqueue(body)) diag('watch_delivery_error', {errorCode:'watch-buffer-or-storage-unavailable'});
  }
  function fileUrl(kind, src) { return SERVER + '/' + kind + '?src=' + q(src) + (TOKEN ? '&t=' + TOKEN : ''); }
  function clock(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function status(text) { $('status').textContent = text || ''; }

  // ---------- home ----------
  function tile(item, kind) {
    var el = document.createElement('div');
    el.className = 'tile ' + kind;
    el.setAttribute('role', 'button');
    el.tabIndex = -1;
    el.setAttribute('aria-label', item.name || item.title || item.label || 'Play');
    var art = document.createElement('div');
    art.className = 'art';
    art.setAttribute('data-initial', (item.name || item.title || item.label || 'O').slice(0, 1));
    var label = document.createElement('div');
    label.className = 'label';
    var name = document.createElement('span');
    name.className = 'name';
    var count = document.createElement('span');
    count.className = 'count';
    if (kind === 'launch') {
      el.className += ' tint-' + (item.app || item.id);
      if (item.app === 'youtube') art.innerHTML = '<b class="yt-mark"></b>';
      else art.textContent = item.app ? '▶' : String(data.channels.filter(function (channel) { return channel.id !== 'all'; }).indexOf(item) + 1);
      name.textContent = item.label;
    } else if (kind === 'shuffle') {
      art.textContent = ICONS.all;
      name.textContent = 'Play channel';
      count.textContent = item.count;
    } else if (kind === 'live') {
      art.innerHTML = '<span class="lcn"></span><span class="on-air">LIVE</span>';
      art.firstChild.textContent = item.lcn;
      name.textContent = item.name;
    } else if (kind === 'show') {
      el._artSrc = item.src;
      name.textContent = item.name;
      count.textContent = item.count;
    } else {
      el._artSrc = item.src;
      name.textContent = item.title;
      if (item.duration) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = item.resume ? clock(item.duration - item.resume) + ' left' : clock(item.duration);
        art.appendChild(badge);
      }
      if (item.resume && item.duration) {
        var bar = document.createElement('div'), fill = document.createElement('div');
        bar.className = 'progress';
        fill.style.width = Math.min(100, 100 * item.resume / item.duration) + '%';
        bar.appendChild(fill);
        art.appendChild(bar);
      }
    }
    label.appendChild(name);
    label.appendChild(count);
    el.appendChild(art);
    el.appendChild(label);
    return el;
  }

  function fill(el, items, kind) {
    el.innerHTML = '';
    items.forEach(function (item, col) {
      // A channel's own tile at the head of its shows plays the whole channel.
      var t = tile(item, kind === 'show' && item === page ? 'shuffle' : kind);
      // The TV's own browser drives pages with a pointer: a click focuses and opens.
      t.addEventListener('click', function () {
        for (var r = 0; r < rows.length; r++) if (rows[r].el === el) focus.row = r;
        focus.col = col;
        moveFocus(0, 0);
        select();
      });
      el.appendChild(t);
    });
    preloadAround(items, 0, el);
  }
  function preloadAround(items, index, container) {
    if (!container) return;
    var end = Math.min(items.length, index + Math.ceil(window.innerWidth / 280) + 1);
    for (var i = Math.max(0, index - 1); i < end; i++) prepareArt(container.children[i]);
  }
  function prepareArt(tile) {
    if (!tile || !tile._artSrc) return;
    var url = fileUrl('art', tile._artSrc), art = tile.querySelector('.art');
    function apply(loaded) { if (loaded === false) return; art.classList.add('ready'); art.style.backgroundImage = 'url("' + url + '")'; }
    if (artCache[url]) { artCache[url].then(apply); return; }
    var pending = new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        if (image.decode) image.decode().then(resolve, resolve); else resolve();
      };
      image.onerror = function () { delete artCache[url]; resolve(false); };
      image.src = url;
    });
    artCache[url] = pending; artOrder.push(url);
    if (artOrder.length > 32) delete artCache[artOrder.shift()];
    pending.then(apply);
  }

  // Home: what to watch, what to finish, what is on air. A channel: its shows.
  function launchItems() {
    var items = data.channels.filter(function (channel) { return channel.id !== 'all'; });
    if (SHELL && SHELL.youtube) {
      items.splice(Math.min(2, items.length), 0, { app: 'youtube', label: 'YouTube' });
    }
    items.push({ app: 'uke', label: 'Uke' });
    items.push({ app: 'games', label: 'Games' });
    return items;
  }
  function onChannel(item) { return !page || (item.channels || []).indexOf(page.id) >= 0; }
  function render() {
    var live = (SHELL && SHELL.live) || [];
    var resume = openShow ? [] : data.continueWatching.filter(onChannel);
    if (page) $('home').insertBefore($('shows-row'), $('continue-row'));
    else $('home').insertBefore($('continue-row'), $('shows-row'));
    rows = [];
    $('feature').hidden = !!openShow || !!page;
    $('brand').hidden = !!openShow || !!page;
    $('page-title').hidden = !page;
    $('page-title').textContent = page ? page.label : '';
    $('launch-row').hidden = !!page || !!openShow;
    $('shows-row').hidden = !!openShow;
    $('live-row').hidden = !!page || !live.length;
    if (openShow) {
      $('shows-title').textContent = openShow.name;
      $('shows-row').hidden = false;
      rows.push({ el: $('shows'), items: openShow.episodes, kind: 'episode' });
      fill($('shows'), openShow.episodes, 'episode');
    } else if (!page) {
      rows.push({ el: $('launch'), items: launchItems(), kind: 'launch' });
      fill($('launch'), rows[0].items, 'launch');
      $('shows-title').textContent = 'Browse shows';
      fill($('shows'), data.shows, 'show');
      rows.push({ el: $('shows'), items: data.shows, kind: 'show' });
    } else {
      $('shows-title').textContent = 'Browse shows';
      var shows = [page].concat(data.shows.filter(onChannel));
      rows.push({ el: $('shows'), items: shows, kind: 'show' });
      fill($('shows'), shows, 'show');
    }
    $('continue-row').hidden = !resume.length;
    fill($('continue'), resume, 'episode');
    if (resume.length) rows.splice(1, 0, { el: $('continue'), items: resume, kind: 'continue' });
    if (!page && live.length) {
      fill($('live'), live, 'live');
      rows.push({ el: $('live'), items: live, kind: 'live' });
    }
    rows = rows.filter(function (row) { return row.items.length; });
    if (initialHome && !page && !openShow) { focus.row = 0; initialHome = false; }
    focus.row = Math.max(0, Math.min(focus.row, rows.length - 1));
    moveFocus(0, 0);
    diag('rendered', { page: 'home', state: 'ready' });
  }
  function openPage(channel) {
    page = channel;
    openShow = null;
    focus = { row: 0, col: 0 };
    render();
  }
  function goBack() {
    if (openShow) {
      var name = openShow.name;
      openShow = null;
      render();
      var showRow = rows.filter(function (row) { return row.kind === 'show'; })[0];
      if (showRow) { focus.row = rows.indexOf(showRow); focus.col = Math.max(0, showRow.items.map(function (show) { return show.name; }).indexOf(name)); }
      moveFocus(0, 0);
      return true;
    }
    if (page) {
      var id = page.id;
      page = null;
      focus = { row: 0, col: 0 };
      render();
      var browse = rows.filter(function (row) { return row.kind === 'launch'; })[0];
      if (browse) { focus.row = rows.indexOf(browse); focus.col = Math.max(0, browse.items.map(function (item) { return item.id; }).indexOf(id)); }
      moveFocus(0, 0);
      return true;
    }
    return false;
  }

  function caption(row, item) {
    if (!item) return '';
    if (row.kind === 'launch') return item.app ? item.label : item.label + ' · OK to watch · continuous play';
    if (row.kind === 'live') return 'Channel ' + item.lcn + ' · ' + item.name;
    if (row.kind === 'show' && item === page) return 'Shuffle ' + page.label + ' · ' + page.count + ' videos';
    if (row.kind === 'show') return item.name + ' · ' + item.count + ' videos';
    var parts = [item.show, item.title];
    if (item.resume) parts.push(clock(item.resume) + ' of ' + clock(item.duration));
    else if (item.duration) parts.push(clock(item.duration));
    return parts.filter(Boolean).join(' · ');
  }

  function moveFocus(dRow, dCol) {
    if (!rows.length) return;
    var previous = rows[focus.row];
    focus.row = Math.max(0, Math.min(rows.length - 1, focus.row + dRow));
    var row = rows[focus.row];
    if (dRow && previous !== row) focus.col = Math.min(focus.col, row.items.length - 1);
    focus.col = Math.max(0, Math.min(row.items.length - 1, focus.col + dCol));
    updateFeature(row, row.items[focus.col]);
    status(caption(row, row.items[focus.col]));
    var tiles = document.querySelectorAll('.tile.focused');
    for (var i = 0; i < tiles.length; i++) tiles[i].classList.remove('focused');
    var el = row.el.children[focus.col];
    if (el) {
      el.classList.add('focused');
      if (row.kind === 'show' || row.kind === 'continue' || row.kind === 'episode') preloadAround(row.items, focus.col, row.el);
      // Scroll both axes for remote focus, without assuming a 1920px panel.
      var box = el.getBoundingClientRect(), viewport = row.el.getBoundingClientRect();
      if (box.left < viewport.left + 10) row.el.scrollLeft -= viewport.left + 10 - box.left;
      if (box.right > viewport.right - 10) row.el.scrollLeft += box.right - viewport.right + 10;
      var home = $('home'), bounds = home.getBoundingClientRect();
      if (box.top < bounds.top + 12) home.scrollTop -= bounds.top + 12 - box.top;
      var reserve = Math.max(32, $('status').offsetHeight + 20);
      if (box.bottom > bounds.bottom - reserve) home.scrollTop += box.bottom - bounds.bottom + reserve;

    }
  }

  function updateFeature(row, item) {
    if (!item || !$('feature') || $('feature').hidden) return;
    var source = item.src, title = item.name || item.title || item.label;
    var kind = row.kind === 'continue' ? 'Continue watching' : row.kind === 'show' ? 'Smart shuffle' : 'Smart channels';
    var meta = row.kind === 'continue' ? (item.show || '') + (item.resume ? ' · ' + clock(item.duration - item.resume) + ' left' : '') : row.kind === 'show' ? item.count + ' episodes' : 'A continuous mix of shows';
    if (row.kind === 'launch') {
      var representative = data.shows.filter(function (show) { return (show.channels || []).indexOf(item.id) >= 0; })[0];
      source = representative && representative.src;
      if (item.app === 'uke') { kind = 'Play music'; meta = 'Songs and chords'; }
      if (item.app === 'games') { kind = 'Play together'; meta = 'Remote games · couch racing'; }
    }
    $('feature-kind').textContent = kind; $('feature-title').textContent = title;
    $('feature-meta').textContent = meta;
    $('feature-action').textContent = row.kind === 'continue' ? '▶  Resume channel' : row.kind === 'launch' && !item.app ? '▶  Watch channel' : 'OK  ' + (row.kind === 'show' ? 'Browse episodes' : 'Open');
    $('feature-art').style.backgroundImage = source ? 'url("' + fileUrl('art', source) + '")' : 'none';
  }

  function select() {
    var row = rows[focus.row], item = row && row.items[focus.col];
    if (!item) return;
    if (row.kind === 'launch') {
      if (item.app === 'games') return openGames();
      if (item.app === 'uke') { tuneRequest++; if (play) { watchEvent('stop'); saveProgress(false); play = null; media.stop(); } return window.ontoUke.open(SERVER, function () { moveFocus(0, 0); }); }
      return item.app ? SHELL.open(item.app) : startChannel(item);
    }
    if (row.kind === 'live') return SHELL.watchLive(item.lcn);
    if (row.kind === 'show' && item === page) return startChannel(page);
    if (row.kind === 'show') {
      status('Loading ' + item.name + '…');
      if (showCache[item.name]) {
        openShow = { name: item.name, episodes: showCache[item.name] };
        focus = { row: 0, col: 0 }; render(); return;
      }
      return api('/api/show?name=' + q(item.name)).then(function (episodes) {
        showCache[item.name] = episodes; cacheOrder.push(item.name);
        if (cacheOrder.length > 8) delete showCache[cacheOrder.shift()];
        openShow = { name: item.name, episodes: episodes };
        focus = { row: 0, col: 0 };
        render();
      }).catch(fail);
    }
    if (row.kind === 'episode') return startList('show', openShow.episodes, focus.col);
    if (row.kind === 'continue') return startList('single', [item], 0);
  }

  function loadHome() {
    mediaState = 'connecting';
    status('Connecting to ' + (SERVER || 'the Mac') + '…');
    return api('/api/home').then(function (home) {
      data = home; ensureWatchDelivery().drain(); mediaState = 'ready';
      showCache = Object.create(null); cacheOrder = [];
      var bridge = window.ontoDiagnostics;
      if (bridge && typeof bridge.connect === 'function') { try { bridge.connect(SERVER); } catch (e) {} }
      diag('connected', { page: 'home', state: 'ready' });
      render();
    }).catch(function (error) {
      mediaState = 'offline';
      diag('offline', { page: 'home', state: 'offline' });
      if (PACKAGED) return findServer();
      fail(error);
    });
  }

  function openGames() {
    tuneRequest++;
    if (play) { watchEvent('stop'); saveProgress(false); play = null; media.stop(); }
    $('home').hidden = true;
    window.ontoGames.open(function () {
      window.ontoGameBridge.close(); gameState = null;
      $('home').hidden = false; diag('game_close', { page: 'home', state: 'ready' });
      moveFocus(0, 0);
    }, function (state) {
      gameState = state;
      window.ontoGameBridge.update(SERVER, TOKEN, state);
      diag('game_state', { page: 'games', game: state.game, state: state.state });
    });
    diag('game_open', { page: 'games', game: 'menu', state: 'ready' });
  }

  // ---------- finding the Mac (packaged app only) ----------
  function probe(base) {
    return new Promise(function (resolve) {
      var done = false, timer = setTimeout(function () { done = true; resolve(false); }, 2500);
      fetch(base + '/api/health', { headers: { 'X-Onto-Token': TOKEN } }).then(function (response) {
        if (!done) { clearTimeout(timer); resolve(response.ok); }
      }).catch(function () { if (!done) { clearTimeout(timer); resolve(false); } });
    });
  }
  function findServer() {
    var saved = '';
    try { saved = localStorage.getItem('onto.server') || ''; } catch (e) {}
    var candidates = (CONFIG.servers || []).concat([saved]).filter(Boolean);
    status('Looking for the Mac…');
    var tryNext = function (i) {
      if (i >= candidates.length) return askForServer();
      return probe(candidates[i]).then(function (ok) {
        if (!ok) return tryNext(i + 1);
        SERVER = candidates[i];
        try { localStorage.setItem('onto.server', SERVER); } catch (e) {}
        return loadHome();
      });
    };
    return tryNext(0);
  }
  function askForServer() {
    mediaState = 'offline';
    diag('offline', { page: 'setup', state: 'offline' });
    var box = $('setup'), input = $('setup-address');
    box.hidden = false;
    input.value = (SERVER || (CONFIG.servers || [])[0] || 'http://192.168.').replace(/^http:\/\//, '');
    input.focus();
    status('');
  }
  $('setup-address').addEventListener('keydown', function (event) {
    if (event.keyCode !== KEY.ENTER && event.keyCode !== 65376) return;   // 65376: Tizen IME Done
    event.stopPropagation();
    var value = 'http://' + this.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!/:\d+$/.test(value)) value += ':' + (CONFIG.port || 8686);
    $('setup-message').textContent = 'Trying ' + value + '…';
    probe(value).then(function (ok) {
      if (!ok) { $('setup-message').textContent = '⚠ No answer from ' + value; return; }
      SERVER = value;
      try { localStorage.setItem('onto.server', SERVER); } catch (e) {}
      $('setup').hidden = true;
      $('setup-message').textContent = '';
      loadHome();
    });
  });
  function fail(error) { status('⚠ ' + error.message); }

  // ---------- playback ----------
  var media = window.ontoPlayer(video, $('av'));
  if (media.engine === 'avplay') document.body.classList.add('avplay');

  function showOsd() {
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { if (!media.paused()) osd.classList.add('hidden'); }, OSD_MS);
  }
  function updateOsd() {
    if (!play || !play.item) return;
    var duration = media.duration() || play.item.duration || 0;
    $('osd-show').textContent = play.item.show;
    $('osd-episode').textContent = play.item.title;
    $('osd-channel').textContent = play.channel ? play.channel.label : '';
    $('osd-elapsed').textContent = clock(media.time());
    $('osd-duration').textContent = clock(duration);
    $('osd-fill').style.width = duration ? Math.min(100, 100 * media.time() / duration) + '%' : '0';
    $('osd-play').textContent = media.paused() ? '▶' : '⏸';
    $('osd-next').hidden = play.mode === 'single';
  }

  function load(item) {
    watchSession = 'tv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    watchSequence = 0;
    watchTracker = window.ontoWatchTracker ? window.ontoWatchTracker() : null;
    play.item = item;
    play.visitStart = item.resume || 0;
    play.lastSave = Date.now();
    $('home').hidden = true;
    $('player').hidden = false;
    document.body.classList.add('playing');
    lastPlayingDiagnostic = 0;
    mediaState = 'loading'; lastProgressAt = 0; previousMediaTime = item.resume || 0;
    diag('play_request', { page: 'player', engine: media.engine, state: 'loading', position: item.resume || 0, duration: item.duration || 0, paused: false });
    play.watchedSeconds = 0;
    watchEvent('start');
    media.load(fileUrl('media', item.src), item.resume || 0);
    updateOsd();
    showOsd();
  }

  function startChannel(channel, fromItem, reason) {
    var request = ++tuneRequest;
    if (play && play.item && (!fromItem || play.channel !== channel)) watchEvent('stop');
    play = play && play.channel === channel ? play : { mode: 'channel', channel: channel };
    var body = { channel: channel.id };
    if (fromItem) {
      body.current = fromItem.src;
      body.reason = reason;
      body.time = Math.floor(media.time());
      body.watched = Math.floor(Math.max(0, play.watchedSeconds || 0));
      body.duration = Math.floor(media.duration() || fromItem.duration || 0);
    }
    return post('/api/next', body).then(function (item) { if (request === tuneRequest) load(item); }).catch(function (error) { if (request !== tuneRequest) return; stopPlayback(); fail(error); });
  }

  function startList(mode, list, index) {
    tuneRequest++;
    if (play && play.item) watchEvent('stop');
    var item = list[index], memberships = item.channels || [];
    // A chosen episode seeds the same audience picker as a channel. Never
    // widen an inferred kids' channel to Everything merely to keep playing.
    var channel = page && page.id !== 'all' && memberships.indexOf(page.id) >= 0 ? page : null;
    if (!channel) {
      var preferred = ['2', '6', 'grown', 'music'];
      for (var i = 0; i < preferred.length && !channel; i++) {
        if (memberships.indexOf(preferred[i]) < 0) continue;
        channel = data.channels.filter(function (entry) { return entry.id === preferred[i]; })[0];
      }
    }
    play = channel ? { mode: 'channel', channel: channel } : { mode: mode, list: list, index: index };
    load(item);
  }

  function saveProgress(completed) {
    if (!play || !play.item) return;
    play.lastSave = Date.now();
    post('/api/progress', { src: play.item.src, positionSeconds: completed ? 0 : media.time(),
      durationSeconds: media.duration(), completed: !!completed }).catch(function () {});
  }

  function next(reason) {
    if (!play) return;
    var current = play.item;
    watchEvent(reason === 'ended' ? 'ended' : 'skip');
    saveProgress(reason === 'ended');
    if (play.mode === 'channel') return startChannel(play.channel, current, reason);
    if (play.mode === 'show' && play.index + 1 < play.list.length) {
      play.index += 1;
      return load(play.list[play.index]);
    }
    stopPlayback();
  }

  function stopPlayback() {
    tuneRequest++;
    if (play && play.item && !media.ended()) { watchEvent('stop'); saveProgress(false); }
    play = null; mediaState = 'ready';
    media.stop();
    document.body.classList.remove('playing');
    $('player').hidden = true;
    $('home').hidden = false;
    loadHome();
  }

  function seek(seconds) {
    var duration = media.duration();
    if (!duration) return;
    media.seek(Math.max(0, Math.min(duration - 1, media.time() + seconds)));
    if (play) { play.ignoreUntil = Date.now() + 1200; if (watchTracker) watchTracker.rebase(media.time(), Date.now()); }
    showOsd();
  }
  function togglePause() {
    if (media.paused()) { media.play(); watchEvent('resume'); } else media.pause();
    updateOsd();
    showOsd();
  }

  media.on('time', function () {
    updateOsd();
    var at = media.time();
    if (play && play.ignoreUntil && Date.now() < play.ignoreUntil) { previousMediaTime = at; if (watchTracker) watchTracker.rebase(at, Date.now()); return; }
    var delta = play && watchTracker ? watchTracker.sample(at, !media.paused() && !document.hidden, Date.now()) : 0;
    if (play && !media.paused() && at > previousMediaTime + 0.05) {
      play.watchedSeconds = (play.watchedSeconds || 0) + delta;
      mediaState = 'playing'; lastProgressAt = Date.now();
    }
    if (play && !media.paused() && mediaState === 'playing' && at > previousMediaTime + 0.05 && Date.now() - lastPlayingDiagnostic > 15000) {
      lastPlayingDiagnostic = Date.now();
      diag('playing', diagnosticSample());
    }
    previousMediaTime = at;
    if (play && Date.now() - play.lastSave > SAVE_EVERY) { saveProgress(false); watchEvent('progress'); }
  });
  media.on('ended', function () { mediaState = 'playing'; diag('ended', diagnosticSample()); next('ended'); });
  media.on('error', function () {
    if (!play) return;
    mediaState = 'error';
    diag('play_error', { page: 'player', engine: media.engine || 'video', state: 'error', errorCode: 'media' });
    status('⚠ Could not play ' + (play.item ? play.item.title : 'that video'));
    watchEvent('error');
    // A file the TV cannot decode teaches nothing; channels move on, single files return home.
    if (play.mode === 'channel') startChannel(play.channel, null); else stopPlayback();
  });
  media.on('pause', function () { mediaState = media.paused() ? 'paused' : 'loading'; if (media.paused()) { watchEvent('pause'); diag('pause', diagnosticSample()); } updateOsd(); showOsd(); });
  video.addEventListener('click', togglePause);
  $('osd-next').addEventListener('click', function () { next('skip'); });
  window.addEventListener('pagehide', function () { if (play) watchEvent('stop'); });
  document.addEventListener('visibilitychange', function () { if (!play) return; watchEvent(document.hidden || media.paused() ? 'pause' : 'resume'); });

  window.ontoTVAction = function (action) {
    if (action === 'uke-open' || action === 'uke-phone') {
      tuneRequest++;
      if (play) { watchEvent('stop'); saveProgress(false); play=null; media.stop(); }
      if (window.ontoGames && window.ontoGames.isOpen()) window.ontoGames.close();
      window.ontoUke.open(SERVER,function () { moveFocus(0,0); });
    }
    return window.ontoUke.command(action);
  };

  // ---------- keys ----------
  document.addEventListener('keydown', function (event) {
    var key = event.keyCode;
    if (window.ontoUke && window.ontoUke.isOpen()) { if (window.ontoUke.key(key)) event.preventDefault(); return; }
    if (window.ontoGames && window.ontoGames.isOpen()) {
      event.preventDefault();
      if (!event.repeat && window.ontoGames.handleKey(key, 1)) {
        diag('game_input', { page: 'games', input: key >= 48 && key <= 57 ? 'number' : key >= 37 && key <= 40 ? 'arrows' : key === 13 ? 'ok' : 'back' });
      }
      return;
    }
    if (!$('setup').hidden) return;
    // Number keys tune directly; game input is handled above.
    if (key >= 49 && key <= 57 && !openShow) {
      var channels = data.channels.filter(function (channel) { return channel.id !== 'all'; });
      if (channels[key - 49]) { if (play) saveProgress(false); startChannel(channels[key - 49]); event.preventDefault(); return; }
    }
    var playing = !$('player').hidden;
    if (!playing && play && (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE)) { stopPlayback(); event.preventDefault(); return; }
    if (playing) {
      if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE || key === KEY.STOP) stopPlayback();
      else if (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) togglePause();
      else if (key === KEY.PLAY) { media.play(); watchEvent('resume'); showOsd(); }
      else if (key === KEY.PAUSE) { media.pause(); showOsd(); }
      else if (key === KEY.LEFT || key === KEY.RW) seek(-SEEK);
      else if (key === KEY.RIGHT || key === KEY.FF) seek(SEEK);
      else if (key === KEY.NEXT || key === KEY.CH_UP || key === KEY.DOWN) next('skip');
      else if (key === KEY.PREV || key === KEY.CH_DOWN) { media.seek(0); showOsd(); }
      else if (key === KEY.UP) showOsd();
      else return;
    } else {
      if (key === KEY.LEFT) moveFocus(0, -1);
      else if (key === KEY.RIGHT) moveFocus(0, 1);
      else if (key === KEY.UP) moveFocus(-1, 0);
      else if (key === KEY.DOWN) moveFocus(1, 0);
      else if (key === KEY.ENTER) select();
      else if ((key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) && goBack()) {
        // went up a level
      } else if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) { focus = { row: 0, col: 0 }; $('home').scrollTop = 0; moveFocus(0, 0); }
      else return;
    }
    event.preventDefault();
  });

  // Media keys reach the app only once registered (Tizen).
  if (window.tizen && tizen.tvinputdevice) {
    ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'MediaTrackNext', 'MediaTrackPrevious', 'ChannelUp', 'ChannelDown',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (name) {
      try { tizen.tvinputdevice.registerKey(name); } catch (e) {}
    });
  }
  // Leaving the app (Home button) saves the place.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && play) { saveProgress(false); media.pause(); }
  });

  // The shell reports what it is doing to the TV (tuning, a TV that will not answer).
  window.ontoNotice = status;
  // The shell's Home button: whatever is on, come back to the home screen.
  window.ontoHome = function () {
    if (window.ontoUke && window.ontoUke.isOpen()) window.ontoUke.close();
    if (window.ontoGames && window.ontoGames.isOpen()) window.ontoGames.close();
    if (play) stopPlayback();
    page = null;
    openShow = null;
    focus = { row: 0, col: 0 };
    render();
  };

  $('feature-action').addEventListener('click', select);
  loadHome();
})();
