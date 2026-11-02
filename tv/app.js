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
    CH_UP: 427, CH_DOWN: 428, SPACE: 32, SUBT: 0 };
  var GAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 96" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path fill="currentColor" fill-opacity="0.16" d="M34 42c0-10 8-16 18-16h16c6 0 8 5 16 5s10-5 16-5h16c10 0 18 6 18 16v6c8 2 14 10 14 18 0 12-10 20-22 20-8 0-12-6-16-12H58c-4 6-8 12-16 12-12 0-22-8-22-20 0-8 6-16 14-18z"/><path d="M62 48v18M53 57h18"/><circle cx="112" cy="52" r="5" fill="currentColor" stroke="none"/><circle cx="128" cy="64" r="5" fill="currentColor" stroke="none"/></svg>';
  var UKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 180" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path fill="currentColor" fill-opacity="0.16" d="M50 86c-22 0-34 12-30 26 4 2 6 4 6 8s-2 6-6 8c-4 14 8 28 30 28s34-14 30-28c-4-2-6-4-6-8s2-6 6-8c4-14-8-26-30-26z"/><circle cx="50" cy="128" r="8"/><path d="M43 86V34h14v52"/><rect x="30" y="12" width="40" height="18" rx="3" fill="currentColor" fill-opacity="0.16"/><circle cx="38" cy="21" r="2.4" fill="currentColor" stroke="none"/><circle cx="46" cy="21" r="2.4" fill="currentColor" stroke="none"/><circle cx="54" cy="21" r="2.4" fill="currentColor" stroke="none"/><circle cx="62" cy="21" r="2.4" fill="currentColor" stroke="none"/><path d="M46 34v90M50 34v94M54 34v90"/></svg>';
  var SAVE_EVERY = 15000, OSD_MS = 4000;
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
  var navState = window.ontoNav.initial();
  var navTimer = 0, stripTimer = 0, optionOpen = false, optionRow = 0;
  var sessionIntro = {}, showStack = [];
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
    cards.sort(function (a, b) { return a.number - b.number; });
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
    if (item.app === 'games' || item.app === 'uke') {
      button.className = 'channel app-' + item.app;
      var glyph = document.createElement('span');
      glyph.className = 'app-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = item.app === 'games' ? GAME_SVG : UKE_SVG;
      button.appendChild(glyph);
    }
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

  function subsUrl(src, name) {
    return SERVER + '/subs?src=' + q(src) + '&name=' + q(name) + (TOKEN ? '&t=' + q(TOKEN) : '');
  }
  function adsMode() {
    var id = play && play.channel && play.channel.id;
    if (!id) return 'play';
    try { return localStorage.getItem('onto.ads.' + id) === 'skip' ? 'skip' : 'play'; } catch (e) { return 'play'; }
  }
  function setAdsMode(mode) {
    var id = play && play.channel && play.channel.id;
    if (!id) return;
    try { localStorage.setItem('onto.ads.' + id, mode); } catch (e) {}
  }
  function viewerStorageKey() { return selectedIds().slice().sort().join(','); }
  function subsChoice() {
    try { return localStorage.getItem('onto.subs.' + viewerStorageKey()) || 'off'; } catch (e) { return 'off'; }
  }
  function setSubsChoice(value) {
    try { localStorage.setItem('onto.subs.' + viewerStorageKey(), value); } catch (e) {}
  }
  function playbackPosition() {
    if (!play) return 0;
    if (play.airing === 'show') return media.time();
    if (typeof play.showTime === 'number') return play.showTime;
    return play.item ? (play.item.resume || 0) : 0;
  }
  function showAdChip(n, total) {
    var chip = $('ad-chip');
    chip.hidden = false;
    chip.textContent = 'Ad ' + n + '/' + total;
  }
  function hideAdChip() { var chip = $('ad-chip'); if (chip) chip.hidden = true; }
  function hideIntro() { var button = $('skip-intro'); if (button) button.hidden = true; }
  function rememberShow() {
    if (!play || !play.item || !play.channel) return;
    var channelId = play.channel.id;
    var last = showStack.length ? showStack[showStack.length - 1] : null;
    if (last && last.item && last.item.src === play.item.src && last.channelId === channelId) return;
    showStack.push({ channelId: channelId, item: play.item, time: typeof play.showTime === 'number' ? play.showTime : (play.item.resume || 0) });
    if (showStack.length > 30) showStack.shift();
  }
  function textChoices() {
    var list = [], i, tracks, sidecars = (play && play.sidecars) || [];
    for (i = 0; i < sidecars.length; i++) list.push({ id: 'file:' + sidecars[i].id, label: sidecars[i].label || sidecars[i].id });
    tracks = media.tracks ? media.tracks() : { text: [] };
    for (i = 0; i < (tracks.text || []).length; i++) {
    var embedded = true, j;
      for (j = 0; j < sidecars.length; j++) if (sidecars[j].id === tracks.text[i].label) embedded = false;
      if (!embedded) continue;
      list.push({ id: 'track:' + tracks.text[i].index, label: tracks.text[i].label || String(i + 1) });
    }
    return list;
  }
  function resolveSubs(choice) {
    var options = textChoices(), i;
    if (!choice || choice === 'off') return 'off';
    for (i = 0; i < options.length; i++) if (options[i].id === choice) return choice;
    return options.length ? options[0].id : 'off';
  }
  function applySavedSubs() {
    if (!media.selectText) return;
    var choice = resolveSubs(subsChoice());
    if (choice.indexOf('track:') === 0) { media.selectText(Number(choice.slice(6))); return; }
    if (choice.indexOf('file:') === 0) {
      var name = choice.slice(5), found = -1, list = video.textTracks, i;
      if (list) for (i = 0; i < list.length; i++) if (list[i].label === name) found = i;
      media.selectText(found);
      return;
    }
    media.selectText(-1);
  }
  function audioChoices() {
    var tracks = media.tracks ? media.tracks() : { audio: [] };
    return tracks.audio || [];
  }
  function paintOptions() {
    var subs = textChoices();
    var choice = resolveSubs(subsChoice());
    var label = 'Off', i;
    for (i = 0; i < subs.length; i++) if (subs[i].id === choice) label = subs[i].label;
    $('opt-subs').textContent = label;
    var audio = audioChoices();
    var audioLabel = audio.length ? audio[Math.max(0, play && play.audioIndex || 0) % audio.length].label : '';
    if (play && audio.length) play.audioIndex = Math.max(0, play.audioIndex || 0) % audio.length;
    $('opt-audio').textContent = audioLabel;
    $('opt-ads').textContent = adsMode() === 'skip' ? 'Skip' : 'Play';
    var rows = document.querySelectorAll('#options .opt');
    for (i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('focused', i === optionRow);
      var value = rows[i].querySelector('.v');
      rows[i].setAttribute('aria-label', rows[i].querySelector('.k').textContent + ' ' + (value ? value.textContent : ''));
    }
  }
  function closeOptions() { optionOpen = false; var panel = $('options'); if (panel) panel.hidden = true; }
  function openOptions() {
    optionOpen = true;
    optionRow = 0;
    paintOptions();
    $('options').hidden = false;
    $('jump-strip').hidden = true;
    hideIntro();
  }
  function cycleSubs() {
    var options = textChoices(), ids = ['off'], i, at;
    for (i = 0; i < options.length; i++) ids.push(options[i].id);
    at = ids.indexOf(subsChoice());
    if (at < 0) at = 0;
    setSubsChoice(ids[(at + 1) % ids.length]);
    applySavedSubs();
  }
  function cycleAudio() {
    var audio = audioChoices();
    if (!audio.length || !play) return;
    play.audioIndex = ((play.audioIndex || 0) + 1) % audio.length;
    if (media.selectAudio) media.selectAudio(audio[play.audioIndex].index);
  }
  function cycleAds() {
    var mode = adsMode() === 'skip' ? 'play' : 'skip';
    setAdsMode(mode);
    if (mode === 'skip') skipBreak();
  }
  function loadScenes(src) {
    api('/api/scenes?src=' + q(src)).then(function (body) {
      if (!play || !play.item || play.item.src !== src) return;
      play.scenes = body || { cuts: [], thumbs: [], segments: [] };
    }).catch(function () {});
  }
  function mountSidecars(src) {
    var old = video.querySelectorAll('track[data-sidecar]'), i, tracks, choice;
    for (i = old.length - 1; i >= 0; i--) old[i].parentNode.removeChild(old[i]);
    if (!play || media.engine === 'avplay') return;
    tracks = play.sidecars || [];
    choice = resolveSubs(subsChoice());
    for (i = 0; i < tracks.length; i++) {
      var el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = tracks[i].id;
      el.srclang = tracks[i].lang || 'und';
      el.setAttribute('data-sidecar', '1');
      el.src = subsUrl(src, tracks[i].id);
      if (choice === 'file:' + tracks[i].id) el.default = true;
      el.addEventListener('load', applySavedSubs);
      video.appendChild(el);
    }
  }
  function loadSidecars(src) {
    api('/api/subs?src=' + q(src)).then(function (body) {
      if (!play || !play.item || play.item.src !== src) return;
      play.sidecars = (body && body.tracks) || [];
      mountSidecars(src);
      applySavedSubs();
      if (optionOpen) paintOptions();
    }).catch(function () {});
  }
  function hideStripSoon() {
    clearTimeout(stripTimer);
    stripTimer = setTimeout(function () { var strip = $('jump-strip'); if (strip) strip.hidden = true; }, 1000);
  }
  function showStrip(target, sticky) {
    var strip = $('jump-strip');
    var scenes = play && play.scenes;
    var cuts = scenes && scenes.cuts || [];
    var thumbs = scenes && scenes.thumbs || [];
    var points = window.ontoNav.scenePoints(cuts, media.duration() || (play.item && play.item.duration) || 0);
    var best = 0, bestDist = 1e15, i, from, to, img;
    strip.innerHTML = '';
    if (thumbs.length < 2 || points.length < 2) { strip.hidden = true; return; }
    for (i = 0; i < points.length; i++) {
      var dist = Math.abs(points[i] - target);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    from = Math.max(0, best - 3);
    to = Math.min(points.length, from + 7);
    from = Math.max(0, to - 7);
    for (i = from; i < to; i++) {
      if (!thumbs[i]) continue;
      img = document.createElement('img');
      img.alt = '';
      img.src = artUrl(thumbs[i]);
      if (i === best) img.className = 'on';
      strip.appendChild(img);
    }
    if (!strip.children.length) { strip.hidden = true; return; }
    strip.hidden = false;
    clearTimeout(stripTimer);
    if (!sticky) hideStripSoon();
  }
  function jumpTarget(delta) {
    var time = media.time();
    var duration = media.duration() || (play && play.item && play.item.duration) || 0;
    var cuts = (play && play.airing === 'show' && play.scenes && play.scenes.cuts) || [];
    return window.ontoNav.sceneTarget(time, duration, cuts, delta);
  }
  function previewJump(delta) { if (play) showStrip(jumpTarget(delta), true); }
  function commitJump(delta) {
    if (!play || !delta) { hideStripSoon(); return; }
    var target = jumpTarget(delta);
    media.seek(target);
    if (play.airing === 'show') play.showTime = target;
    play.ignoreUntil = Date.now() + 1200;
    if (watchTracker) watchTracker.rebase(target, Date.now());
    showStrip(target, false);
    showOsd();
  }
  function playShowAt(at) {
    var i, breaks;
    play.airing = 'show';
    play.phase = 'show';
    play.inRecorded = null;
    hideAdChip();
    breaks = play.breaks || [];
    for (i = 0; i < breaks.length; i++) if (breaks[i].at <= (at || 0) + 1) breaks[i].done = true;
    if (!play.started) {
      play.started = true;
      watchEvent('start');
      loadScenes(play.item.src);
      loadSidecars(play.item.src);
    }
    play.ignoreUntil = Date.now() + 1200;
    previousMediaTime = at || 0;
    media.load(fileUrl('media', play.item.src), at || 0);
    updateOsd();
    showOsd();
  }
  function playAd(index) {
    var ad = play.breakAds && play.breakAds[index];
    play.breakIndex = index;
    if (!ad) return advanceAd();
    play.airing = 'ad';
    showAdChip(index + 1, play.breakAds.length);
    media.load(fileUrl('media', ad.src), 0);
    showOsd();
  }
  function advanceAd() {
    var nextIndex, at;
    if (!play || !play.breakAds) return;
    nextIndex = play.breakIndex + 1;
    if (nextIndex < play.breakAds.length) return playAd(nextIndex);
    at = play.phase === 'mid' ? (play.resumeAt || play.showTime || 0) : ((play.item && play.item.resume) || 0);
    playShowAt(at);
  }
  function startBreak(ads, phase) {
    play.phase = phase;
    play.breakAds = ads;
    play.breakIndex = 0;
    hideIntro();
    playAd(0);
  }
  function skipBreak() {
    var end;
    if (!play) return;
    if (play.airing === 'ad') {
      play.breakIndex = play.breakAds ? play.breakAds.length : 0;
      advanceAd();
      return;
    }
    if (play.inRecorded) {
      end = play.inRecorded.end;
      play.skipUntil = end;
      play.inRecorded = null;
      hideAdChip();
      media.seek(end);
      showOsd();
    }
  }
  function skipIntro() {
    var channelId;
    if (!play || !play.pendingIntro) return;
    channelId = play.channel ? play.channel.id : '';
    sessionIntro[channelId] = true;
    play.skipUntil = play.pendingIntro.end;
    media.seek(play.pendingIntro.end);
    play.pendingIntro = null;
    hideIntro();
    showOsd();
  }
  function followSegments() {
    var t, segments, intro, outro, recorded, i, seg, channelId, ads, n, breaks;
    if (!play || play.airing !== 'show') return;
    t = media.time();
    if (play.skipUntil) {
      if (t < play.skipUntil - 0.4) return;
      play.skipUntil = 0;
    }
    segments = (play.scenes && play.scenes.segments) || [];
    intro = null; outro = null; recorded = null;
    for (i = 0; i < segments.length; i++) {
      seg = segments[i];
      if (t < seg.start || t >= seg.end) continue;
      if (seg.kind === 'intro') intro = seg;
      else if (seg.kind === 'outro' || seg.kind === 'credits') outro = seg;
      else if (seg.kind === 'ad') recorded = seg;
    }
    channelId = play.channel ? play.channel.id : '';
    if (outro && !play.rollingCredits) { play.rollingCredits = true; next('ended'); return; }
    if (intro) {
      if (sessionIntro[channelId]) { play.skipUntil = intro.end; media.seek(intro.end); return; }
      play.pendingIntro = intro;
      if (!optionOpen) $('skip-intro').hidden = false;
    } else if (play.pendingIntro) {
      sessionIntro[channelId] = true;
      play.pendingIntro = null;
      hideIntro();
    }
    if (recorded && adsMode() === 'skip') {
      play.skipUntil = recorded.end;
      play.inRecorded = null;
      hideAdChip();
      media.seek(recorded.end);
      return;
    }
    if (recorded) {
      ads = [];
      n = 1;
      for (i = 0; i < segments.length; i++) if (segments[i].kind === 'ad') ads.push(segments[i]);
      for (i = 0; i < ads.length; i++) if (ads[i].start === recorded.start) n = i + 1;
      play.inRecorded = recorded;
      showAdChip(n, ads.length);
    } else if (play.inRecorded) {
      play.inRecorded = null;
      hideAdChip();
    }
    breaks = play.breaks || [];
    for (i = 0; i < breaks.length; i++) {
      if (breaks[i].done) continue;
      if (t + 0.5 >= breaks[i].at) {
        breaks[i].done = true;
        if (adsMode() === 'skip' || !breaks[i].ads || !breaks[i].ads.length) continue;
        play.resumeAt = t;
        startBreak(breaks[i].ads, 'mid');
        return;
      }
    }
  }
  function previousShow() {
    var channelId, previous, entry;
    if (!play || !play.channel) return;
    channelId = play.channel.id;
    previous = null;
    while (showStack.length) {
      entry = showStack.pop();
      if (entry.channelId === channelId) { previous = entry; break; }
    }
    if (!previous) {
      if (play.airing === 'show') { media.seek(0); showOsd(); }
      return;
    }
    previous.item.resume = previous.time || 0;
    load(previous.item, true);
  }
  function inAd() { return !!(play && (play.airing === 'ad' || play.inRecorded)); }
  function applyNav(actions) {
    var i, action;
    for (i = 0; i < actions.length; i++) {
      action = actions[i];
      if (action.type === 'queue') previewJump(action.delta);
      else if (action.type === 'commit') commitJump(action.delta);
      else if (action.type === 'skip-break') skipBreak();
      else if (action.type === 'hold') {
        if (action.key === 'left') previousShow();
        else if (action.key === 'right' || action.key === 'play') next('skip');
        else if (action.key === 'ok') openOptions();
      } else if (action.type === 'tap') {
        if (action.key === 'ok') {
          if (!$('skip-intro').hidden && play && play.pendingIntro) skipIntro();
          else togglePause();
        } else if (action.key === 'up') stepChannel(1);
        else if (action.key === 'down') stepChannel(-1);
        else if (action.key === 'play') { media.play(); watchEvent('resume'); showOsd(); }
        else if (action.key === 'subt') { cycleSubs(); if (optionOpen) paintOptions(); }
      }
    }
  }
  function onNav(event) {
    var result = window.ontoNav.step(navState, event);
    navState = result.state;
    if (!optionOpen) applyNav(result.actions);
    clearTimeout(navTimer);
    if (result.wakeAt) {
      navTimer = setTimeout(function () { onNav({ type: 'tick', time: Date.now(), ad: inAd() }); }, Math.max(0, result.wakeAt - Date.now()));
    }
  }
  function navKey(code) {
    if (code === KEY.LEFT || code === KEY.RW) return 'left';
    if (code === KEY.RIGHT || code === KEY.FF) return 'right';
    if (code === KEY.UP || code === KEY.CH_UP) return 'up';
    if (code === KEY.DOWN || code === KEY.CH_DOWN) return 'down';
    if (code === KEY.ENTER || code === KEY.PLAYPAUSE || code === KEY.SPACE) return 'ok';
    if (code === KEY.PLAY) return 'play';
    if (KEY.SUBT && code === KEY.SUBT) return 'subt';
    return '';
  }
  function handleOptionKey(name) {
    if (name === 'up') optionRow = Math.max(0, optionRow - 1);
    else if (name === 'down') optionRow = Math.min(2, optionRow + 1);
    else if (name === 'ok') {
      if (optionRow === 0) cycleSubs();
      else if (optionRow === 1) cycleAudio();
      else cycleAds();
    } else if (name === 'subt') { optionRow = 0; cycleSubs(); }
    else return;
    paintOptions();
  }
  function load(item, restoring) {
    var i, preroll;
    if (!restoring) rememberShow();
    watchSession = 'tv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    watchSequence = 0;
    watchTracker = window.ontoWatchTracker ? window.ontoWatchTracker() : null;
    play.item = item;
    play.visitStart = item.resume || 0;
    play.lastSave = Date.now();
    play.started = false;
    play.airing = 'show';
    play.rollingCredits = false;
    play.pendingIntro = null;
    play.inRecorded = null;
    play.skipUntil = 0;
    play.scenes = null;
    play.sidecars = [];
    play.audioIndex = 0;
    play.breaks = [];
    play.queue = item.queue || [];
    play.showTime = item.resume || 0;
    play.watchedSeconds = 0;
    for (i = 0; i < play.queue.length; i++) {
      if (play.queue[i].kind === 'show' && play.queue[i].breaks) play.breaks = play.queue[i].breaks;
    }
    $('home').hidden = true;
    $('player').hidden = false;
    document.body.classList.add('playing');
    hideAdChip();
    hideIntro();
    closeOptions();
    $('jump-strip').hidden = true;
    lastPlayingDiagnostic = 0;
    mediaState = 'loading'; lastProgressAt = 0; previousMediaTime = item.resume || 0;
    diag('play_request', { page: 'player', engine: media.engine, state: 'loading', position: item.resume || 0, duration: item.duration || 0, paused: false });
    preroll = [];
    for (i = 0; i < play.queue.length; i++) {
      if (play.queue[i].kind !== 'ad') break;
      preroll.push(play.queue[i]);
    }
    if (preroll.length && adsMode() !== 'skip') startBreak(preroll, 'preroll');
    else playShowAt(item.resume || 0);
  }

  function startChannel(channel, fromItem, reason) {
    var request = ++tuneRequest;
    if (play && play.item && (!fromItem || play.channel !== channel)) watchEvent('stop');
    if (play && play.item && play.channel && play.channel.id !== channel.id) rememberShow();
    play = play && play.channel === channel ? play : { mode: 'channel', channel: channel };
    var body = { channel: channel.id };
    var viewers = storedViewers();
    if (viewers !== null) body.viewers = viewers;
    if (fromItem) {
      body.current = fromItem.src;
      body.reason = reason;
      body.time = Math.floor(playbackPosition());
      body.watched = Math.floor(Math.max(0, play.watchedSeconds || 0));
      body.duration = Math.floor(fromItem.duration || (play.airing === 'show' ? media.duration() : 0) || 0);
    }
    return post('/api/next', body).then(function (item) { if (request === tuneRequest) load(item); }).catch(function (error) { if (request !== tuneRequest) return; stopPlayback(); fail(error); });
  }

  function saveProgress(completed) {
    if (!play || !play.item || play.airing === 'ad') return;
    play.lastSave = Date.now();
    post('/api/progress', { src: play.item.src, positionSeconds: completed ? 0 : playbackPosition(),
      durationSeconds: play.item.duration || media.duration(), completed: !!completed }).catch(function () {});
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
    clearTimeout(navTimer);
    clearTimeout(stripTimer);
    navState = window.ontoNav.initial();
    closeOptions();
    hideAdChip();
    hideIntro();
    var strip = $('jump-strip');
    if (strip) { strip.hidden = true; strip.innerHTML = ''; }
    if (play && play.item && play.airing !== 'ad' && !media.ended()) { watchEvent('stop'); saveProgress(false); }
    play = null; mediaState = 'ready';
    media.stop();
    document.body.classList.remove('playing');
    $('player').hidden = true;
    $('home').hidden = false;
    loadHome();
  }

  function togglePause() {
    if (media.paused()) { media.play(); watchEvent('resume'); } else media.pause();
    updateOsd();
    showOsd();
  }

  media.on('time', function () {
    if (play && play.airing === 'show') followSegments();
    updateOsd();
    if (!play || play.airing !== 'show') return;
    var at = media.time();
    play.showTime = at;
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
  media.on('ended', function () {
    mediaState = 'playing';
    diag('ended', diagnosticSample());
    if (play && play.airing === 'ad') return advanceAd();
    next('ended');
  });
  media.on('error', function () {
    if (!play) return;
    if (play.airing === 'ad') return advanceAd();
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
  $('skip-intro').addEventListener('click', skipIntro);
  var optionButtons = document.querySelectorAll('#options .opt');
  for (var optionIndex = 0; optionIndex < optionButtons.length; optionIndex++) {
    (function (index) {
      optionButtons[index].addEventListener('click', function () {
        optionRow = index;
        if (index === 0) cycleSubs();
        else if (index === 1) cycleAudio();
        else cycleAds();
        paintOptions();
      });
    })(optionIndex);
  }
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
      if (optionOpen && (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE)) { closeOptions(); event.preventDefault(); return; }
      if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE || key === KEY.STOP) { stopPlayback(); event.preventDefault(); return; }
      if (key === KEY.PAUSE) { media.pause(); showOsd(); event.preventDefault(); return; }
      if (key === KEY.NEXT) { next('skip'); event.preventDefault(); return; }
      if (key === KEY.PREV) { previousShow(); event.preventDefault(); return; }
      var name = navKey(key);
      if (!name) return;
      if (optionOpen) { handleOptionKey(name); event.preventDefault(); return; }
      onNav({ type: 'down', key: name, time: Date.now(), ad: inAd() });
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
  document.addEventListener('keyup', function (event) {
    if ($('player').hidden) return;
    if (window.ontoUke && window.ontoUke.isOpen()) return;
    if (window.ontoGames && window.ontoGames.isOpen()) return;
    var name = navKey(event.keyCode);
    if (!name) return;
    onNav({ type: 'up', key: name, time: Date.now(), ad: inAd() });
  });

  // Media keys reach the app only once registered (Tizen). SUBT is mapped when the TV exposes it.
  if (window.tizen && tizen.tvinputdevice) {
    var remoteKeys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'MediaTrackNext', 'MediaTrackPrevious', 'ChannelUp', 'ChannelDown',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    var supported = [];
    try { supported = tizen.tvinputdevice.getSupportedKeys() || []; } catch (e) { supported = []; }
    for (var subtIndex = 0; subtIndex < supported.length; subtIndex++) {
      var subtName = supported[subtIndex] && supported[subtIndex].name;
      if (subtName && /caption|subtitle|subt/i.test(subtName)) {
        remoteKeys.push(subtName);
        KEY.SUBT = supported[subtIndex].code;
      }
    }
    remoteKeys.forEach(function (name) {
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
