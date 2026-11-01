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
  var SEEK = 30, SAVE_EVERY = 15000, OSD_MS = 4000;
  var FALLBACK_VIEWERS = [
    { id: 'sam', name: 'Sam', on: true }, { id: 'jake', name: 'Jake', on: true },
    { id: 'mum', name: 'Mum', on: true }, { id: 'dad', name: 'Dad', on: true }
  ];

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video'), osd = $('osd');
  var data = { channels: [], viewers: [], ceiling: null };
  var rows = [];
  var focus = { row: 0, col: 0 };
  var homeRequest = 0;
  var play = null;          // { mode: 'channel', channel, item, visitStart, lastSave }
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
  function storedViewers() {
    try { return localStorage.getItem('onto.viewers'); } catch (e) { return null; }
  }
  function homePath() {
    var stored = storedViewers();
    if (stored === null) return '/api/home';
    return '/api/home?viewers=' + q(stored);
  }
  function artUrl(path) {
    if (!path) return '';
    var url = path.indexOf('http') === 0 ? path : SERVER + path;
    if (TOKEN) url += (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + q(TOKEN);
    return url;
  }
  function paintClock() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    var clockEl = $('clock');
    clockEl.textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    clockEl.setAttribute('title', d.toDateString());
  }
  function gridCards() {
    var cards = (data.channels || []).slice();
    cards.push({ id: 'games', number: 6, name: 'Games', app: 'games' });
    cards.push({ id: 'uke', number: 7, name: 'Uke', app: 'uke' });
    return cards;
  }
  function selectedIds() {
    var ids = [], people = data.viewers || [];
    for (var i = 0; i < people.length; i++) if (people[i].on) ids.push(people[i].id);
    return ids;
  }
  function toggleViewer(id) {
    var ids = selectedIds(), at = ids.indexOf(id);
    if (at >= 0) ids.splice(at, 1); else ids.push(id);
    var ordered = [], people = data.viewers || [];
    for (var i = 0; i < people.length; i++) if (ids.indexOf(people[i].id) >= 0) ordered.push(people[i].id);
    try { localStorage.setItem('onto.viewers', ordered.join(',')); } catch (e) {}
    var keep = { row: focus.row, col: focus.col };
    loadHome().then(function () { focus = keep; moveFocus(0, 0); });
  }
  function loadArt(img, url) {
    if (!img || !url) return;
    var image = new Image();
    image.onload = function () {
      var apply = function () { if (img.isConnected) img.src = url; };
      if (image.decode) image.decode().then(apply, apply); else apply();
    };
    image.onerror = function () { img.style.visibility = 'hidden'; };
    image.src = url;
  }
  function viewerButton(person, col) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'viewer' + (person.on ? ' on' : '');
    button.tabIndex = -1;
    button.setAttribute('data-id', person.id);
    button.setAttribute('aria-pressed', person.on ? 'true' : 'false');
    button.setAttribute('aria-label', person.name + (person.on ? ', watching' : ', not watching'));
    var tick = document.createElement('span');
    tick.className = 'tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.textContent = '✓';
    var name = document.createElement('span');
    name.className = 'who';
    name.textContent = person.name;
    button.appendChild(tick);
    button.appendChild(name);
    button.addEventListener('click', function () {
      focus = { row: 0, col: col };
      moveFocus(0, 0);
      toggleViewer(person.id);
    });
    return button;
  }
  function channelButton(item, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'channel';
    button.tabIndex = -1;
    button._item = item;
    var show = item.now && item.now.show;
    button.setAttribute('aria-label', item.number + ' ' + item.name + (show ? ', ' + show : ''));
    if (item.now && item.now.art) {
      var img = document.createElement('img');
      img.className = 'art';
      img.alt = '';
      button.appendChild(img);
      loadArt(img, artUrl(item.now.art));
    }
    var copy = document.createElement('span');
    copy.className = 'channel-copy';
    var line = document.createElement('span');
    line.className = 'channel-line';
    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(item.number);
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    line.appendChild(num);
    line.appendChild(name);
    copy.appendChild(line);
    if (show) {
      var now = document.createElement('span');
      now.className = 'now';
      now.textContent = '▶ ' + show;
      now.title = show;
      copy.appendChild(now);
    }
    button.appendChild(copy);
    button.addEventListener('click', function () {
      var row = Math.floor(index / 4) + (rows.length && rows[0].kind === 'viewers' ? 1 : 0);
      focus = { row: row, col: index % 4 };
      moveFocus(0, 0);
      activate(item);
    });
    return button;
  }
  function render() {
    var people = (data.viewers && data.viewers.length) ? data.viewers : FALLBACK_VIEWERS;
    data.viewers = people;
    var viewers = $('viewers');
    viewers.innerHTML = '';
    for (var i = 0; i < people.length; i++) viewers.appendChild(viewerButton(people[i], i));
    var badge = $('ceiling');
    if (data.ceiling) {
      badge.hidden = false;
      badge.textContent = data.ceiling;
      badge.className = 'rating rating-' + String(data.ceiling).toLowerCase().replace('-', '');
      badge.title = 'Rating ' + data.ceiling;
    } else {
      badge.hidden = true;
      badge.textContent = '';
      badge.className = 'rating';
    }
    paintClock();
    var cards = gridCards();
    var holder = $('channels');
    holder.innerHTML = '';
    for (var c = 0; c < cards.length; c++) holder.appendChild(channelButton(cards[c], c));
    rows = [];
    if (viewers.children.length) rows.push({ kind: 'viewers', els: viewers.children });
    for (var start = 0; start < holder.children.length; start += 4) {
      var slice = [];
      for (var n = start; n < holder.children.length && n < start + 4; n++) slice.push(holder.children[n]);
      rows.push({ kind: 'channels', els: slice });
    }
    if (!rows.length) return;
    if (focus.row > rows.length - 1) focus.row = rows.length - 1;
    moveFocus(0, 0);
    diag('rendered', { page: 'home', state: 'ready' });
  }
  function moveFocus(dRow, dCol) {
    if (!rows.length) return;
    var previous = rows[focus.row] || rows[0];
    if (!rows[focus.row]) focus.row = 0;
    focus.row = Math.max(0, Math.min(rows.length - 1, focus.row + dRow));
    var row = rows[focus.row];
    if (dRow && previous !== row) focus.col = Math.min(focus.col, row.els.length - 1);
    focus.col = Math.max(0, Math.min(row.els.length - 1, focus.col + dCol));
    var focused = document.querySelectorAll('.focused');
    for (var i = 0; i < focused.length; i++) focused[i].classList.remove('focused');
    var el = row.els[focus.col];
    if (!el) return;
    el.classList.add('focused');
    try { el.focus(); } catch (e) {}
  }
  function activate(item) {
    if (!item) return;
    if (item.app === 'games') return openGames();
    if (item.app === 'uke') {
      tuneRequest++;
      if (play) { watchEvent('stop'); saveProgress(false); play = null; media.stop(); }
      return window.ontoUke.open(SERVER, function () { moveFocus(0, 0); });
    }
    startChannel(item);
  }
  function select() {
    var row = rows[focus.row], el = row && row.els[focus.col];
    if (!el) return;
    if (row.kind === 'viewers') return toggleViewer(el.getAttribute('data-id'));
    activate(el._item);
  }
  function loadHome() {
    mediaState = 'connecting';
    var request = ++homeRequest;
    return api(homePath()).then(function (home) {
      if (request !== homeRequest) return;
      data = home || {};
      if (!data.channels) data.channels = [];
      if (!data.viewers || !data.viewers.length) data.viewers = FALLBACK_VIEWERS;
      ensureWatchDelivery().drain();
      mediaState = 'ready';
      status('');
      var bridge = window.ontoDiagnostics;
      if (bridge && typeof bridge.connect === 'function') { try { bridge.connect(SERVER); } catch (e) {} }
      diag('connected', { page: 'home', state: 'ready' });
      render();
    }).catch(function (error) {
      if (request !== homeRequest) return;
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
    var channel = play.channel;
    $('osd-channel').textContent = channel ? ((channel.number ? channel.number + ' ' : '') + (channel.name || channel.label || '')) : '';
    $('osd-show').textContent = play.item.show || '';
    $('osd-episode').textContent = play.item.title && play.item.title !== play.item.show ? play.item.title : '';
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
    var viewers = storedViewers();
    if (viewers !== null) body.viewers = viewers;
    if (fromItem) {
      body.current = fromItem.src;
      body.reason = reason;
      body.time = Math.floor(media.time());
      body.watched = Math.floor(Math.max(0, play.watchedSeconds || 0));
      body.duration = Math.floor(media.duration() || fromItem.duration || 0);
    }
    return post('/api/next', body).then(function (item) { if (request === tuneRequest) load(item); }).catch(function (error) { if (request !== tuneRequest) return; stopPlayback(); fail(error); });
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

  function tuneNumber(number) {
    var cards = gridCards();
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].number !== number) continue;
      if (play && !cards[i].app) saveProgress(false);
      activate(cards[i]);
      return true;
    }
    return false;
  }
  function stepChannel(direction) {
    var list = (data.channels || []).slice().sort(function (a, b) { return a.number - b.number; });
    if (!play || !play.channel || list.length < 2) { showOsd(); return; }
    var index = 0;
    for (var i = 0; i < list.length; i++) if (list[i].id === play.channel.id) index = i;
    var nextIndex = (index + direction + list.length) % list.length;
    if (list[nextIndex].id === play.channel.id) { showOsd(); return; }
    saveProgress(false);
    startChannel(list[nextIndex]);
  }

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
    if (key >= 49 && key <= 57) {
      if (tuneNumber(key - 48)) { event.preventDefault(); return; }
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
      else if (key === KEY.UP || key === KEY.CH_UP) { if (!event.repeat) stepChannel(1); }
      else if (key === KEY.DOWN || key === KEY.CH_DOWN) { if (!event.repeat) stepChannel(-1); }
      else if (key === KEY.NEXT) next('skip');
      else if (key === KEY.PREV) { media.seek(0); showOsd(); }
      else return;
    } else {
      if (key === KEY.LEFT) moveFocus(0, -1);
      else if (key === KEY.RIGHT) moveFocus(0, 1);
      else if (key === KEY.UP) moveFocus(-1, 0);
      else if (key === KEY.DOWN) moveFocus(1, 0);
      else if (key === KEY.ENTER) select();
      else if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) { focus = { row: 0, col: 0 }; moveFocus(0, 0); }
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
    focus = { row: 0, col: 0 };
    render();
  };

  paintClock();
  setInterval(paintClock, 1000);
  loadHome();
})();
