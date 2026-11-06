/* Onto the TV: Samsung Tizen 3 / Chromium 47 compatible browser code. */
(function () {
  'use strict';
  // Served by the Mac, the page talks to its own origin. Packaged as the TV app,
  // config.js supplies the Mac's likely addresses and the pairing token.
  var CONFIG = window.ONTO_CONFIG || {};
  var TOKEN = CONFIG.token || '';
  var PACKAGED = !(location.protocol === 'http:' || location.protocol === 'https:');
  var SERVER = PACKAGED ? '' : location.origin;
  // Guest mode: the invite-only phone app (src/guest-server.js) serves this page with
  // ONTO_CONFIG.guest. No viewer row, no games, uke or console; touch-first player.
  var GUEST = CONFIG.guest || null;
  if (GUEST) { document.body.classList.add('guest'); document.body.classList.add('desktop-embedded'); }

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232,
    CH_UP: 427, CH_DOWN: 428, SPACE: 32, SUBT: 0 };
  var ANTENNA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 28" focusable="false"><path d="M8 24 L40 4 L72 24" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var PERSON_SVG = '<svg class="person-off" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="18" r="10"/><path d="M12 54c2-16 10-22 20-22s18 6 20 22"/></svg><svg class="person-on" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor"><circle cx="32" cy="18" r="11"/><path d="M10 56c2-18 12-26 22-26s20 8 22 26z"/></svg>';
  var PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round" d="M11 6 L26 16 L11 26 Z"/></svg>';
  var GAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="20" width="172" height="74" rx="30"/><path d="M62 40v32M46 56h32"/><circle cx="138" cy="48" r="8" fill="currentColor" stroke="none"/><circle cx="160" cy="70" r="8" fill="currentColor" stroke="none"/></svg>';
  var UKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 230"><rect x="32" y="4" width="56" height="28" rx="7" fill="currentColor"/><rect x="51" y="26" width="18" height="62" fill="currentColor"/><ellipse cx="60" cy="108" rx="30" ry="28" fill="currentColor"/><ellipse cx="60" cy="160" rx="44" ry="40" fill="currentColor"/><circle cx="46" cy="18" r="3.5" fill="#0b1428"/><circle cx="56" cy="18" r="3.5" fill="#0b1428"/><circle cx="66" cy="18" r="3.5" fill="#0b1428"/><circle cx="76" cy="18" r="3.5" fill="#0b1428"/><circle cx="60" cy="162" r="11" fill="#0b1428"/></svg>';
  var CONSOLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="26" width="180" height="66" rx="33"/><path d="M56 44v30M41 59h30"/><path d="M128 59h24M140 47v24"/></svg>';
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
  var osdTimer = 0, gameState = null, tuneRequest = 0, tuneMark = 0, tuneTimer = 0;
  var navState = window.ontoNav.initial();
  var navTimer = 0, stripTimer = 0, optionOpen = false, optionRow = 0;
  var upNextTimer = 0, errorTimer = 0, sweepTimer = 0, seekPreview = null, resumeIndex = 0, sweepDir = 0;
  var upNextCard = null, seekCtrl = null, errorCtrl = null;
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
  // Watershed: 20:00-05:00 defaults to the adults (M); 05:00 brings everyone back (G).
  // A manual choice holds until the next switch.
  var NIGHT_VIEWERS = 'mum,dad';
  function band(d) { var h = (d || new Date()).getHours(); return (h >= 20 || h < 5) ? 'night' : 'day'; }
  // Native desktop handoff is explicit and session-only; it never changes TV defaults.
  var desktopQuery = /(?:^|[?&])desktop=1(?:&|$)/.test(location.search) && window.parent !== window;
  function desktopParam(name) {
    var match = new RegExp('(?:^|[?&])' + name + '=([^&]*)').exec(location.search);
    try { return match ? decodeURIComponent(match[1]) : ''; } catch (e) { return ''; }
  }
  var desktopChannel = desktopQuery ? desktopParam('channel') : '';
  if (desktopQuery) document.body.classList.add('desktop-embedded');
  function storedViewers() {
    if (GUEST) return null;   // the server applies the guest's own ceiling
    if (desktopQuery) return desktopParam('viewers');
    try {
      var now = band();
      if (localStorage.getItem('onto.viewers.band') !== now) {
        localStorage.setItem('onto.viewers.band', now);
        if (now === 'night') localStorage.setItem('onto.viewers', NIGHT_VIEWERS);
        else localStorage.removeItem('onto.viewers');
        localStorage.removeItem('onto.rating');
      }
      return localStorage.getItem('onto.viewers');
    } catch (e) { return null; }
  }
  // Profiles replace the old who's-watching segments: colours, layout and lineup audience.
  var PROFILES = [
    { id: 'ian', name: 'Ian', mark: 'I', viewers: 'dad', layout: 'now' },
    { id: 'fran', name: 'Fran', mark: 'F', viewers: 'mum', layout: 'guide' },
    { id: 'jake', name: 'Jake', mark: 'J', viewers: 'jake,mum,dad', layout: 'pictures' },
    { id: 'sam', name: 'Sam', mark: 'S', viewers: 'sam,jake,mum,dad', layout: 'pictures' },
    { id: 'all', name: 'Everyone', mark: '\u2605', viewers: 'sam,jake,mum,dad', layout: 'now' }
  ];
  var LAYOUTS = [
    { id: 'now', glyph: '\u25A3', title: 'Now on' },
    { id: 'guide', glyph: '\u2630', title: 'Guide' },
    { id: 'pictures', glyph: '\u25A6', title: 'Pictures' }
  ];
  var RATINGS = ['G', 'PG', 'M'];
  var profileId = 'all';
  var layoutStore = {};
  var pickerOpen = false;
  function profileById(id) {
    for (var p = 0; p < PROFILES.length; p++) if (PROFILES[p].id === id) return PROFILES[p];
    return PROFILES[0];
  }
  function profileFromViewers(viewers) {
    if (!viewers) return 'all';
    var ids = String(viewers).split(','), i;
    for (i = 0; i < ids.length; i++) if (!ids[i]) ids.splice(i--, 1);
    if (ids.length === 1 && ids[0] === 'dad') return 'ian';
    if (ids.length === 1 && ids[0] === 'mum') return 'fran';
    for (i = 0; i < ids.length; i++) if (ids[i] === 'sam') return ids.indexOf('jake') >= 0 ? 'all' : 'sam';
    for (i = 0; i < ids.length; i++) if (ids[i] === 'jake') return 'jake';
    if (ids.indexOf('mum') >= 0 && ids.indexOf('dad') >= 0) return 'ian';
    return 'all';
  }
  function loadLayoutStore() {
    try { layoutStore = JSON.parse(localStorage.getItem('onto.layouts') || '{}') || {}; } catch (e) { layoutStore = {}; }
    if (!layoutStore || typeof layoutStore !== 'object') layoutStore = {};
  }
  function saveLayoutStore() {
    try { localStorage.setItem('onto.layouts', JSON.stringify(layoutStore)); } catch (e) {}
  }
  function currentLayout() {
    var profile = profileById(profileId), pick = layoutStore[profileId];
    for (var i = 0; i < LAYOUTS.length; i++) if (LAYOUTS[i].id === pick) return pick;
    return profile.layout;
  }
  function layoutMode() { return GUEST ? 'now' : currentLayout(); }
  function syncProfileFromStorage() {
    if (GUEST || desktopQuery) return;
    var viewers = null;
    try { viewers = localStorage.getItem('onto.viewers'); } catch (e) {}
    var mapped = profileFromViewers(viewers);
    try {
      var saved = localStorage.getItem('onto.profile');
      if (saved && profileById(saved).id === saved && profileById(saved).viewers === viewers) {
        profileId = saved;
        return;
      }
    } catch (e2) {}
    profileId = mapped;
    persistProfile();
  }
  function persistProfile() {
    if (GUEST || desktopQuery) return;
    try { localStorage.setItem('onto.profile', profileId); } catch (e) {}
  }
  function paintBodyProfile() {
    var i, list = document.body.classList;
    for (i = 0; i < PROFILES.length; i++) list.remove('profile-' + PROFILES[i].id);
    if (!GUEST) list.add('profile-' + profileId);
  }
  function storedRating() {
    if (GUEST) return null;
    if (desktopQuery) return desktopParam('rating') || null;
    if (storedViewers() === null) return null;
    try { return localStorage.getItem('onto.rating'); } catch (e) { return null; }
  }
  var lastBand = band();
  function watchBand() {
    var now = band();
    if (now === lastBand) return;
    lastBand = now;
    if ($('player').hidden) loadHome();
  }
  function homePath() {
    var stored = storedViewers(), rating = storedRating();
    if (stored === null) return '/api/home';
    return '/api/home?viewers=' + q(stored) + (rating ? '&rating=' + q(rating) : '');
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
    if (!GUEST) {
      // The apps follow the channels and take the next numbers.
      var last = 0;
      for (var i = 0; i < cards.length; i++) if (cards[i].number > last) last = cards[i].number;
      cards.push({ id: 'games', number: last + 1, name: 'Games', app: 'games' });
      cards.push({ id: 'uke', number: last + 2, name: 'Uke', app: 'uke' });
      cards.push({ id: 'console', number: last + 3, name: 'Console', app: 'console' });
    }
    // The server orders the lineup for this audience; the app tiles follow it.
    return cards;
  }
  function selectedIds() {
    var ids = [], people = data.viewers || [];
    for (var i = 0; i < people.length; i++) if (people[i].on) ids.push(people[i].id);
    return ids;
  }
  function setAudience(viewers, rating) {
    // The embedded desktop player receives its audience explicitly from the
    // parent, so it never replaces that choice with the TV's local preference.
    if (GUEST || desktopQuery || !$('player').hidden) return;
    try {
      localStorage.setItem('onto.viewers', viewers);
      localStorage.setItem('onto.viewers.band', band());
      if (rating) localStorage.setItem('onto.rating', rating); else localStorage.removeItem('onto.rating');
    } catch (e) {}
    // Clear the old lineup before asking the server for the new ceiling, so a card
    // from the previous audience cannot be activated while the response is in flight.
    var ids = viewers.split(',');
    data.viewers = (data.viewers || FALLBACK_VIEWERS).map(function (person) {
      return { id: person.id, name: person.name, on: ids.indexOf(person.id) >= 0 };
    });
    data.channels = [];
    data.ceiling = null;
    // The new audience's default is unknown until the server answers; a stale one
    // would make a quick rating press clear the override instead of setting it.
    data.defaultCeiling = null;
    data.rating = rating || null;
    profileId = profileFromViewers(viewers);
    persistProfile();
    render();
    var keep = { row: focus.row, col: focus.col };
    loadHome().then(function () { focus = keep; moveFocus(0, 0); });
  }
  function chooseProfile(id) {
    var profile = profileById(id);
    profileId = profile.id;
    persistProfile();
    setAudience(profile.viewers, null);
  }
  function chooseLayout(id) {
    layoutStore[profileId] = id;
    saveLayoutStore();
    render();
  }
  function chooseRating(rating) {
    var viewers = selectedIds().join(',');
    if (!viewers) return;
    // Picking the people's own rating clears the override.
    setAudience(viewers, rating === data.defaultCeiling ? null : rating);
  }
  function loadArt(img, url) {
    if (!img || !url) return;
    var image = new Image();
    image.onload = function () {
      var apply = function () { if (document.documentElement.contains(img)) img.src = url; };
      if (image.decode) image.decode().then(apply, apply); else apply();
    };
    image.onerror = function () { img.style.visibility = 'hidden'; };
    image.src = url;
  }
  function antennaEl() {
    var el = document.createElement('span');
    el.className = 'antenna';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = ANTENNA_SVG;
    return el;
  }
  function segButton(kind, value, label, extraClass, on, col) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'viewer seg seg-' + kind + (extraClass ? ' ' + extraClass : '') + (on ? ' on' : '');
    button.tabIndex = -1;
    button.setAttribute('data-' + kind, value);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.innerHTML = label;
    button.addEventListener('click', function () {
      focus = { row: 0, col: col };
      moveFocus(0, 0);
      if (kind === 'layout') chooseLayout(value); else chooseRating(value);
    });
    return button;
  }
  function audienceControls(holder) {
    var profile = profileById(profileId), col = 0, i, layout = layoutMode();
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'viewer profile-chip';
    chip.tabIndex = -1;
    chip.setAttribute('data-profile', 'chip');
    chip.setAttribute('aria-label', 'Who\'s watching: ' + profile.name + '. Change');
    var avatar = document.createElement('span');
    avatar.className = 'profile-avatar';
    avatar.textContent = profile.mark;
    var label = document.createElement('span');
    label.className = 'profile-name';
    label.textContent = profile.name;
    chip.appendChild(avatar);
    chip.appendChild(label);
    chip.title = profile.name;
    chip.addEventListener('click', function () {
      focus = { row: 0, col: 0 };
      moveFocus(0, 0);
      openPicker();
    });
    holder.appendChild(chip);
    col++;
    var ratings = document.createElement('span');
    ratings.className = 'seg-group ratings';
    for (i = 0; i < RATINGS.length; i++) {
      var r = RATINGS[i], isDefault = r === data.defaultCeiling;
      var rb = segButton('rating', r, '', 'rate-' + r.toLowerCase() + (isDefault ? ' default' : ''), data.ceiling === r, col++);
      rb.textContent = r;
      rb.title = 'Rated ' + r + (isDefault ? ' (' + profile.name + '\'s rating)' : '');
      rb.setAttribute('aria-label', 'Rating ' + r + (isDefault ? ', default' : ''));
      ratings.appendChild(rb);
    }
    holder.appendChild(ratings);
    var layouts = document.createElement('span');
    layouts.className = 'seg-group layouts';
    for (i = 0; i < LAYOUTS.length; i++) {
      var lay = LAYOUTS[i];
      var lb = segButton('layout', lay.id, lay.glyph, '', layout === lay.id, col++);
      lb.title = lay.title;
      lb.setAttribute('aria-label', lay.title);
      lb.setAttribute('aria-pressed', layout === lay.id ? 'true' : 'false');
      layouts.appendChild(lb);
    }
    holder.appendChild(layouts);
  }
  function minutesLabel(now) { return now && now.minutes ? now.minutes + ' min' : ''; }
  function nextLabel(now) {
    if (!now || !now.next) return '';
    var line = 'Next \u00b7 ' + (now.next.show || '');
    if (now.next.title) line += ' \u00b7 ' + now.next.title;
    return line;
  }
  function paintHero(item) {
    var hero = $('hero'), mode = layoutMode();
    if (!item || item.app || mode === 'pictures') { hero.hidden = true; hero.textContent = ''; return; }
    hero.hidden = false;
    hero.className = mode === 'guide' ? 'hero-compact' : 'hero-full';
    hero.textContent = '';
    var artWrap = document.createElement('div');
    artWrap.className = 'hero-art-wrap';
    var img = document.createElement('img');
    img.className = 'hero-art';
    img.alt = '';
    artWrap.appendChild(img);
    if (item.now && item.now.art) loadArt(img, artUrl(item.now.art));
    var copy = document.createElement('div');
    copy.className = 'hero-copy';
    var channel = document.createElement('div');
    channel.className = 'hero-channel';
    channel.textContent = item.number + ' \u00b7 ' + item.name;
    copy.appendChild(channel);
    var show = document.createElement('div');
    show.className = 'hero-show';
    show.textContent = (item.now && item.now.show) || '\u2014';
    copy.appendChild(show);
    if (item.now && item.now.title) {
      var title = document.createElement('div');
      title.className = 'hero-title';
      title.textContent = item.now.title;
      copy.appendChild(title);
    }
    var mins = minutesLabel(item.now);
    if (mins) {
      var length = document.createElement('div');
      length.className = 'hero-length';
      length.textContent = mins;
      copy.appendChild(length);
    }
    var next = nextLabel(item.now);
    if (next) {
      var nextEl = document.createElement('div');
      nextEl.className = 'hero-next';
      nextEl.textContent = next;
      copy.appendChild(nextEl);
    }
    hero.appendChild(artWrap);
    hero.appendChild(copy);
  }
  function columnCount() {
    var mode = layoutMode();
    if (mode === 'guide') return 1;
    if (mode === 'pictures') {
      if (window.innerWidth <= 600) return 1;
      if (window.innerWidth <= 1100) return 2;
      return 4;
    }
    if (window.innerWidth <= 600) return 1;
    if (window.innerWidth <= 1100) return 2;
    if (window.innerWidth < 1600) return 4;
    return 6;
  }
  function channelButton(item, index) {
    var mode = layoutMode(), button = document.createElement('button');
    button.type = 'button';
    button.className = 'channel layout-' + mode + (item.app ? ' app-' + item.app : '');
    button.tabIndex = -1;
    button._item = item;
    var show = item.now && item.now.show;
    button.setAttribute('aria-label', item.number + ' ' + item.name + (show ? ', ' + show : ''));
    if (mode === 'guide') {
      button.appendChild(antennaEl());
      var gName = document.createElement('span');
      gName.className = 'guide-name';
      var gNum = document.createElement('span');
      gNum.className = 'num';
      gNum.textContent = String(item.number);
      var gLabel = document.createElement('span');
      gLabel.className = 'name';
      gLabel.textContent = item.name;
      gName.appendChild(gNum);
      gName.appendChild(gLabel);
      button.appendChild(gName);
      if (!item.app && show) {
        var gNow = document.createElement('span');
        gNow.className = 'guide-now';
        var gShow = document.createElement('span');
        gShow.className = 'guide-show';
        gShow.textContent = show;
        gNow.appendChild(gShow);
        if (item.now.title || item.now.minutes) {
          var gTitle = document.createElement('span');
          gTitle.className = 'guide-detail';
          var bits = [];
          if (item.now.title) bits.push(item.now.title);
          if (item.now.minutes) bits.push(item.now.minutes + ' min');
          gTitle.textContent = bits.join(' \u00b7 ');
          gNow.appendChild(gTitle);
        }
        button.appendChild(gNow);
        if (item.now.next) {
          var gNext = document.createElement('span');
          gNext.className = 'guide-next';
          gNext.textContent = (item.now.next.show || '') + (item.now.next.title ? ' \u00b7 ' + item.now.next.title : '');
          button.appendChild(gNext);
        }
      } else if (item.app) {
        var gApp = document.createElement('span');
        gApp.className = 'guide-app';
        gApp.textContent = item.name;
        button.appendChild(gApp);
      }
    } else if (mode === 'pictures') {
      button.appendChild(antennaEl());
      var bezelP = document.createElement('span');
      bezelP.className = 'bezel';
      if (item.app) {
        var glyphP = document.createElement('span');
        glyphP.className = 'app-glyph';
        glyphP.setAttribute('aria-hidden', 'true');
        glyphP.innerHTML = item.app === 'games' ? GAME_SVG : item.app === 'uke' ? UKE_SVG : CONSOLE_SVG;
        bezelP.appendChild(glyphP);
      } else if (item.now && item.now.art) {
        var imgP = document.createElement('img');
        imgP.className = 'art';
        imgP.alt = '';
        bezelP.appendChild(imgP);
        loadArt(imgP, artUrl(item.now.art));
      }
      var pill = document.createElement('span');
      pill.className = 'picture-label';
      pill.textContent = item.name;
      bezelP.appendChild(pill);
      button.appendChild(bezelP);
    } else {
      button.appendChild(antennaEl());
      var bezel = document.createElement('span');
      bezel.className = 'bezel';
      if (item.app === 'games' || item.app === 'uke' || item.app === 'console') {
        var glyph = document.createElement('span');
        glyph.className = 'app-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.innerHTML = item.app === 'games' ? GAME_SVG : item.app === 'uke' ? UKE_SVG : CONSOLE_SVG;
        bezel.appendChild(glyph);
      }
      if (item.now && item.now.art) {
        var img = document.createElement('img');
        img.className = 'art';
        img.alt = '';
        bezel.appendChild(img);
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
        now.title = show;
        var mark = document.createElement('span');
        mark.className = 'mini-play';
        mark.setAttribute('aria-hidden', 'true');
        mark.innerHTML = PLAY_SVG;
        var title = document.createElement('span');
        title.className = 'now-title';
        title.textContent = show;
        now.appendChild(mark);
        now.appendChild(title);
        copy.appendChild(now);
      }
      bezel.appendChild(copy);
      button.appendChild(bezel);
    }
    button.addEventListener('click', function () {
      var topRows = rows.length && rows[0].kind === 'viewers' ? 1 : 0;
      focus = { row: Math.floor(index / columnCount()) + topRows, col: index % columnCount() };
      moveFocus(0, 0);
      activate(item);
    });
    return button;
  }
  function ensurePickerPeople() {
    var people = $('picker-people');
    if (people.children.length) return;
    for (var i = 0; i < PROFILES.length; i++) {
      (function (person) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'picker-person viewer';
        b.tabIndex = -1;
        b.setAttribute('data-profile', person.id);
        var av = document.createElement('span');
        av.className = 'picker-avatar';
        av.textContent = person.mark;
        var nm = document.createElement('span');
        nm.className = 'picker-name';
        nm.textContent = person.name;
        b.appendChild(av);
        b.appendChild(nm);
        b.title = person.name;
        b.setAttribute('aria-label', person.name);
        b.addEventListener('click', function () { chooseProfile(person.id); closePicker(); });
        people.appendChild(b);
      })(PROFILES[i]);
    }
  }
  function openPicker() {
    if (GUEST) return;
    ensurePickerPeople();
    pickerOpen = true;
    $('picker').hidden = false;
    var pick = $('picker-people').querySelector('[data-profile="' + profileId + '"]');
    if (pick) {
      var focused = document.querySelectorAll('.focused');
      for (var i = 0; i < focused.length; i++) focused[i].classList.remove('focused');
      pick.classList.add('focused');
      try { pick.focus(); } catch (e) {}
    }
  }
  function closePicker() {
    pickerOpen = false;
    $('picker').hidden = true;
    moveFocus(0, 0);
  }
  function pickerKey(key) {
    if (!pickerOpen) return false;
    var people = $('picker-people').children, at = -1, i;
    for (i = 0; i < people.length; i++) if (people[i] === document.activeElement || people[i].classList.contains('focused')) at = i;
    if (at < 0) at = 0;
    if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) { closePicker(); return true; }
    if (key === KEY.ENTER) {
      if (people[at]) chooseProfile(people[at].getAttribute('data-profile'));
      closePicker();
      return true;
    }
    if (key === KEY.LEFT) at = (at + people.length - 1) % people.length;
    else if (key === KEY.RIGHT) at = (at + 1) % people.length;
    else return true;
    for (i = 0; i < people.length; i++) people[i].classList.remove('focused');
    people[at].classList.add('focused');
    try { people[at].focus(); } catch (e2) {}
    return true;
  }
  window.addEventListener('resize', function () { if (!$('home').hidden) render(); });
  function render() {
    var people = (data.viewers && data.viewers.length) ? data.viewers : FALLBACK_VIEWERS;
    data.viewers = people;
    var viewers = $('viewers');
    viewers.innerHTML = '';
    if (GUEST) {
      var who = document.createElement('span');
      who.className = 'guest-name';
      who.textContent = GUEST.name || '';
      viewers.appendChild(who);
    } else {
      syncProfileFromStorage();
      paintBodyProfile();
      audienceControls(viewers);
    }
    var badge = $('ceiling');
    // The rating switch shows the ceiling at home; guests keep the plain badge.
    if (data.ceiling && GUEST) {
      badge.hidden = false;
      badge.className = 'rating rating-' + String(data.ceiling).toLowerCase().replace('-', '');
      badge.title = 'Rating ' + data.ceiling;
      badge.innerHTML = '';
      badge.appendChild(antennaEl());
      var letters = document.createElement('span');
      letters.className = 'rating-letters';
      letters.textContent = data.ceiling;
      badge.appendChild(letters);
    } else {
      badge.hidden = true;
      badge.textContent = '';
      badge.className = 'rating';
    }
    paintClock();
    var cards = gridCards();
    var holder = $('channels');
    holder.className = 'layout-' + layoutMode();
    holder.innerHTML = '';
    for (var c = 0; c < cards.length; c++) holder.appendChild(channelButton(cards[c], c));
    var firstChannel = null;
    for (var fc = 0; fc < cards.length; fc++) if (!cards[fc].app) { firstChannel = cards[fc]; break; }
    paintHero(firstChannel);
    rows = [];
    if (viewers.children.length && !GUEST) {
      var controls = viewers.querySelectorAll('.viewer');
      rows.push({ kind: 'viewers', els: controls });
    }
    for (var start = 0; start < holder.children.length; start += columnCount()) {
      var slice = [];
      for (var n = start; n < holder.children.length && n < start + columnCount(); n++) slice.push(holder.children[n]);
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
    if (row.kind === 'channels') {
      var holder = $('channels'), box = el.getBoundingClientRect(), area = holder.getBoundingClientRect();
      var padTop = 36, padBottom = 40;
      if (box.top < area.top + padTop) holder.scrollTop -= area.top + padTop - box.top;
      if (box.bottom > area.bottom - padBottom) holder.scrollTop += box.bottom - area.bottom + padBottom;
      if (el._item && !el._item.app) paintHero(el._item);
    }
  }
  function activate(item) {
    if (!item) return;
    if (item.app === 'games') return openGames();
    if (item.app === 'console') return openConsole();
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
    if (row.kind === 'viewers') {
      if (el.getAttribute('data-profile') === 'chip') return openPicker();
      if (el.getAttribute('data-layout')) return chooseLayout(el.getAttribute('data-layout'));
      return chooseRating(el.getAttribute('data-rating'));
    }
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
      if (desktopChannel) {
        var requestedChannel = desktopChannel;
        desktopChannel = '';
        for (var c = 0; c < data.channels.length; c++) {
          if (data.channels[c].id === requestedChannel) { startChannel(data.channels[c]); return; }
        }
        window.parent.postMessage({ type: 'onto:desktop-home' }, '*');
      }
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

  // ---------- console games (RetroArch on the Mac behind the TV) ----------
  var consoleState = null;
  function openConsole() {
    if (play) { watchEvent('stop'); saveProgress(false); play = null; media.stop(); }
    status('Loading console games…');
    api('/api/console/games').then(function (result) {
      var games = (result && result.games) || [];
      if (!games.length) { status('No console games on the ROM drive yet.'); return; }
      status('');
      consoleState = { games: games, index: 0 };
      paintConsole();
      diag('console_open', { page: 'console', games: games.length });
    }, function (error) { fail(error); });
  }
  function closeConsole() {
    consoleState = null;
    $('console').hidden = true;
    $('home').hidden = false;
    moveFocus(0, 0);
    diag('console_close', { page: 'home', state: 'ready' });
  }
  function paintConsole() {
    var state = consoleState;
    if (!state) return;
    var list = $('console-list');
    list.textContent = '';
    for (var i = 0; i < state.games.length; i++) {
      var game = state.games[i];
      var item = document.createElement('li');
      item.className = 'console-game' + (i === state.index ? ' focused' : '');
      item.textContent = game.name;
      item.setAttribute('data-system', game.system);
      list.appendChild(item);
    }
    var focused = list.children[state.index];
    if (focused && focused.scrollIntoView) focused.scrollIntoView({ block: 'nearest' });
  }
  function launchConsole(game) {
    if (!game) return;
    post('/api/console/launch', { system: game.system, file: game.file })
      .then(function () { diag('console_launch', { page: 'console', game: game.name, system: game.system }); },
        function (error) { fail(error); });
  }
  function consoleKey(key) {
    var state = consoleState;
    if (!state) return false;
    var columns = 1, count = state.games.length;
    if (key === KEY.UP) state.index = (state.index - columns + count) % count;
    else if (key === KEY.DOWN) state.index = (state.index + columns) % count;
    else if (key === KEY.ENTER) { launchConsole(state.games[state.index]); return true; }
    else if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) { closeConsole(); return true; }
    else return false;
    paintConsole();
    return true;
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
      if (!ok) { $('setup-message').textContent = 'No answer from ' + value; return; }
      SERVER = value;
      try { localStorage.setItem('onto.server', SERVER); } catch (e) {}
      $('setup').hidden = true;
      $('setup-message').textContent = '';
      loadHome();
    });
  });
  function fail(error) { status(error.message); }

  // ---------- playback ----------
  var media = window.ontoPlayer(video, $('av'));
  if (media.engine === 'avplay') document.body.classList.add('avplay');
  if (window.ontoPlayerExtras) {
    window.ontoPlayerExtras.install(document);
    upNextCard = window.ontoPlayerExtras.upNext();
    seekCtrl = window.ontoPlayerExtras.seek();
    errorCtrl = window.ontoPlayerExtras.errorLine();
  }

  function playerOverlay() {
    return !!(play && (play.resumePending || play.errorOn)) || (upNextCard && upNextCard.active());
  }
  function showOsd() {
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { if (!media.paused() && !playerOverlay()) osd.classList.add('hidden'); }, OSD_MS);
  }
  function updateOsd() {
    if (!play || !play.item) return;
    var duration = media.duration() || play.item.duration || 0;
    var channel = play.channel;
    paintChannel(channel);
    $('osd-show').textContent = play.item.show || '';
    $('osd-episode').textContent = '';
    $('osd-show').title = play.item.title || play.item.show || '';
    $('osd-play').setAttribute('aria-label', media.paused() ? 'Play' : 'Pause');
    var shown = seekPreview != null ? seekPreview : media.time();
    $('osd-elapsed').textContent = clock(shown);
    $('osd-elapsed').classList.toggle('is-preview', seekPreview != null);
    $('osd-duration').textContent = clock(duration);
    $('osd-fill').style.width = duration ? Math.min(100, 100 * media.time() / duration) + '%' : '0';
    var seekMark = $('osd-seek');
    if (seekMark) {
      if (seekPreview == null || !duration) seekMark.hidden = true;
      else { seekMark.hidden = false; seekMark.style.left = Math.min(100, 100 * seekPreview / duration) + '%'; }
    }
    paintTrackToggles();
    if (media.paused()) $('osd-play').classList.add('is-paused');
    else $('osd-play').classList.remove('is-paused');
    $('osd-next').hidden = play.mode === 'single';
  }
  function paintChannel(channel) {
    var digits = $('osd-num-digits'), name = $('osd-chname');
    if (!digits || !name) return;
    var number = channel && channel.number != null && channel.number !== '' ? String(channel.number) : '';
    var label = channel ? (channel.name || channel.label || '') : '';
    digits.textContent = number;
    name.textContent = (number ? ' ' : '') + label;
  }
  // Snow, then the corner number. A newer change cancels the previous number.
  function showTuning(channel) {
    var mark = ++tuneMark;
    var flash = $('tune-flash'), bug = $('tune-num'), digits = $('tune-digits');
    if (!flash || !bug || !digits) return;
    digits.textContent = channel && channel.number != null && channel.number !== '' ? String(channel.number) : '';
    bug.hidden = true;
    flash.hidden = false;
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(function () {
      if (mark !== tuneMark) return;
      flash.hidden = true;
      if (!digits.textContent) return;
      bug.hidden = false;
      tuneTimer = setTimeout(function () {
        if (mark !== tuneMark) return;
        bug.hidden = true;
      }, 2000);
    }, 200);
  }
  function hideTuning() {
    tuneMark++;
    clearTimeout(tuneTimer);
    var flash = $('tune-flash'), bug = $('tune-num');
    if (flash) flash.hidden = true;
    if (bug) bug.hidden = true;
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
    if (play.resumePending && play.item) return play.item.resume || 0;
    if (play.airing === 'show') return media.time();
    if (typeof play.showTime === 'number') return play.showTime;
    return play.item ? (play.item.resume || 0) : 0;
  }
  function showAdChip(n, total) {
    var chip = $('ad-chip'), label = $('ad-label');
    chip.hidden = false;
    if (label) label.textContent = 'Ad ' + n + '/' + total;
    else chip.textContent = 'Ad ' + n + '/' + total;
  }
  function hideAdChip() { var chip = $('ad-chip'); if (chip) chip.hidden = true; }
  function hideIntro() {
    var button = $('skip-intro');
    if (!button) return;
    button.hidden = true;
    button.classList.remove('focused');
  }
  function setSkipLabel(text) {
    var button = $('skip-intro'), spans, i, node;
    if (!button) return;
    spans = button.getElementsByTagName('span');
    for (i = 0; i < spans.length; i++) {
      node = spans[i];
      if (node.className.indexOf('glyph') === -1) node.textContent = text;
    }
    button.setAttribute('aria-label', text);
    button.classList.add('focused');
  }
  function hideUpNext() {
    clearTimeout(upNextTimer);
    var box = $('up-next');
    if (box) box.hidden = true;
  }
  function hideResume() { var box = $('resume-choice'); if (box) box.hidden = true; }
  function hideError() {
    clearTimeout(errorTimer);
    var box = $('play-error');
    if (box) box.hidden = true;
    osd.classList.remove('has-error');
  }
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
    var audioLabel = audio.length ? audio[Math.max(0, play && play.audioIndex || 0) % audio.length].label : 'Default';
    if (play && audio.length) play.audioIndex = Math.max(0, play.audioIndex || 0) % audio.length;
    $('opt-audio').textContent = audioLabel;
    $('opt-ads').textContent = adsMode() === 'skip' ? 'Skip' : 'Play';
    paintTrackToggles();
    var rows = document.querySelectorAll('#options .opt');
    for (i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('focused', i === optionRow);
      var value = rows[i].querySelector('.v');
      rows[i].setAttribute('aria-label', rows[i].querySelector('.k').textContent + ' ' + (value ? value.textContent : ''));
    }
  }
  function paintTrackToggles() {
    var ccBtn = $('osd-cc'), audioBtn = $('osd-audio'), subs, choice, label, i, audio, audioLabel;
    if (!ccBtn || !audioBtn || !play) return;
    subs = textChoices();
    choice = resolveSubs(subsChoice());
    label = 'Off';
    for (i = 0; i < subs.length; i++) if (subs[i].id === choice) label = subs[i].label;
    ccBtn.hidden = !subs.length;
    $('osd-cc-value').textContent = label;
    ccBtn.setAttribute('aria-label', 'Subtitles ' + label);
    audio = audioChoices();
    audioBtn.hidden = audio.length < 2;
    audioLabel = audio.length ? audio[Math.max(0, play.audioIndex || 0) % audio.length].label : '';
    $('osd-audio-value').textContent = audioLabel;
    audioBtn.setAttribute('aria-label', 'Audio ' + audioLabel);
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
  function skipCredits() {
    if (!play || !play.pendingCredits) return;
    play.skipUntil = play.pendingCredits.end;
    media.seek(play.pendingCredits.end);
    play.pendingCredits = null;
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
    if (outro && !play.rollingCredits) {
      play.rollingCredits = true;
      if (!(window.ontoPlayerExtras && window.ontoPlayerExtras.isSerial(play.item))) { next('ended'); return; }
    }
    if (intro) {
      if (sessionIntro[channelId]) { play.skipUntil = intro.end; media.seek(intro.end); return; }
      play.pendingIntro = intro;
      play.pendingCredits = null;
      setSkipLabel('Skip intro');
      if (!optionOpen) $('skip-intro').hidden = false;
    } else if (outro && window.ontoPlayerExtras && window.ontoPlayerExtras.isSerial(play.item) && !(upNextCard && upNextCard.active())) {
      play.pendingCredits = outro;
      setSkipLabel('Skip credits');
      if (!optionOpen && (!$('up-next') || $('up-next').hidden)) $('skip-intro').hidden = false;
    } else if (play.pendingIntro) {
      sessionIntro[channelId] = true;
      play.pendingIntro = null;
      hideIntro();
    } else if (play.pendingCredits) {
      play.pendingCredits = null;
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
  function durationNow() { return media.duration() || (play && play.item && play.item.duration) || 0; }
  function applySeek(target) {
    seekPreview = null;
    if (seekCtrl) seekCtrl.clear();
    media.seek(target);
    if (play && play.airing === 'show') play.showTime = target;
    if (play) play.ignoreUntil = Date.now() + 1200;
    if (watchTracker) watchTracker.rebase(target, Date.now());
    updateOsd();
    showOsd();
  }
  function previewSeekSteps(delta) {
    var duration = durationNow(), dir, steps, at, i;
    if (!seekCtrl || !delta) { seekPreview = null; updateOsd(); return; }
    seekCtrl.clear();
    dir = delta < 0 ? -1 : 1;
    steps = Math.abs(delta);
    at = media.time();
    for (i = 0; i < steps; i++) at = seekCtrl.tap(media.time(), duration, dir);
    seekPreview = at;
    updateOsd();
    showOsd();
  }
  function commitSeekSteps(delta) {
    var target = seekPreview;
    if (!play) return;
    if (target == null && delta && seekCtrl) {
      var duration = durationNow(), dir = delta < 0 ? -1 : 1, i, at = media.time();
      seekCtrl.clear();
      for (i = 0; i < Math.abs(delta); i++) at = seekCtrl.tap(media.time(), duration, dir);
      target = at;
    }
    if (target == null) return;
    applySeek(target);
  }
  function stepSweep() {
    if (!play || !seekCtrl || !sweepDir) return;
    applySeek(seekCtrl.hold(media.time(), durationNow(), sweepDir));
  }
  function holdSeek(key) {
    clearInterval(sweepTimer);
    sweepDir = key === 'left' ? -1 : 1;
    stepSweep();
    sweepTimer = setInterval(stepSweep, 350);
  }
  function applyNav(actions) {
    var i, action;
    for (i = 0; i < actions.length; i++) {
      action = actions[i];
      if (action.type === 'queue') previewSeekSteps(action.delta);
      else if (action.type === 'commit') commitSeekSteps(action.delta);
      else if (action.type === 'skip-break') skipBreak();
      else if (action.type === 'hold') {
        if (action.key === 'left' || action.key === 'right') holdSeek(action.key);
        else if (action.key === 'play') next('skip');
        else if (action.key === 'ok') openOptions();
      } else if (action.type === 'tap') {
        if (action.key === 'ok') {
          if (upNextCard && upNextCard.active()) acceptUpNext();
          else if (!$('skip-intro').hidden && play && play.pendingIntro) skipIntro();
          else if (!$('skip-intro').hidden && play && play.pendingCredits) skipCredits();
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
    var i;
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
    play.pendingCredits = null;
    play.inRecorded = null;
    play.advanced = false;
    play.upNextAsked = false;
    play.upNextLabel = '';
    play.upNextDismissed = false;
    play.resumePending = false;
    play.errorOn = false;
    if (upNextCard) upNextCard.reset();
    seekPreview = null;
    clearInterval(sweepTimer);
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
    if (GUEST && $('player').hidden && !guestEntry) { guestEntry = true; try { history.pushState({ ontoPlayer: 1 }, ''); } catch (e) {} }
    $('player').hidden = false;
    document.body.classList.add('playing');
    hideAdChip();
    hideIntro();
    hideUpNext();
    hideResume();
    hideError();
    closeOptions();
    $('jump-strip').hidden = true;
    lastPlayingDiagnostic = 0;
    if (!restoring && window.ontoPlayerExtras && window.ontoPlayerExtras.resumeOffer(item.resume || 0)) {
      showResumePrompt(item);
      return;
    }
    startQueued(item);
  }
  function startQueued(item) {
    var i, preroll = [];
    play.resumePending = false;
    play.errorOn = false;
    hideResume();
    hideError();
    mediaState = 'loading'; lastProgressAt = 0; previousMediaTime = item.resume || 0;
    diag('play_request', { page: 'player', engine: media.engine, state: 'loading', position: item.resume || 0, duration: item.duration || 0, paused: false });
    for (i = 0; i < play.queue.length; i++) {
      if (play.queue[i].kind !== 'ad') break;
      preroll.push(play.queue[i]);
    }
    if (preroll.length && adsMode() !== 'skip') startBreak(preroll, 'preroll');
    else playShowAt(item.resume || 0);
  }
  function showResumePrompt(item) {
    var resumeBtn = $('resume-play'), startBtn = $('resume-start');
    play.resumePending = true;
    resumeIndex = 0;
    if (resumeBtn) resumeBtn.textContent = window.ontoPlayerExtras.resumeLabel(item.resume || 0);
    if (resumeBtn) resumeBtn.classList.add('focused');
    if (startBtn) startBtn.classList.remove('focused');
    if ($('resume-choice')) $('resume-choice').hidden = false;
    updateOsd();
    showOsd();
    if (resumeBtn) resumeBtn.focus();
  }
  function focusResume(direction) {
    var resumeBtn = $('resume-play'), startBtn = $('resume-start');
    resumeIndex = window.ontoPlayerExtras.resumeMove(resumeIndex, direction);
    if (resumeBtn) resumeBtn.classList.toggle('focused', resumeIndex === 0);
    if (startBtn) startBtn.classList.toggle('focused', resumeIndex === 1);
    if (resumeIndex === 0 && resumeBtn) resumeBtn.focus();
    if (resumeIndex === 1 && startBtn) startBtn.focus();
  }
  function acceptResume() {
    var item = play && play.item;
    if (!item) return;
    play.resumePending = false;
    hideResume();
    if (window.ontoPlayerExtras.resumeAction(resumeIndex) === 'start') {
      item.resume = 0;
      play.visitStart = 0;
      play.showTime = 0;
    }
    startQueued(item);
  }
  function showUpNext(label) {
    var box = $('up-next'), text = $('up-next-label'), count = $('up-next-count'), button = $('up-next-play');
    if (!upNextCard || !upNextCard.arm()) return;
    if (text) text.textContent = label;
    if (count) count.textContent = String(upNextCard.read());
    if (button) {
      button.className = 'focused';
      button.setAttribute('aria-label', label + ' ' + upNextCard.read());
      button.title = 'Plays the next episode. Back cancels.';
      button.focus();
    }
    if (box) box.hidden = false;
    hideIntro();
    clearTimeout(upNextTimer);
    upNextTimer = setTimeout(upNextTick, 1000);
  }
  function upNextTick() {
    var action, count;
    if (!play || !upNextCard || !upNextCard.active()) return;
    action = upNextCard.tick();
    count = $('up-next-count');
    if (count) count.textContent = String(upNextCard.read());
    if (action === 'play') acceptUpNext();
    else upNextTimer = setTimeout(upNextTick, 1000);
  }
  function acceptUpNext() {
    if (upNextCard && upNextCard.active()) upNextCard.ok();
    finishEpisode();
  }
  function cancelUpNext() {
    if (upNextCard && upNextCard.active()) upNextCard.back();
    if (play) play.upNextDismissed = true;
    hideUpNext();
    showOsd();
  }
  function finishEpisode() {
    if (!play || play.advanced) return;
    play.advanced = true;
    hideUpNext();
    next('ended');
  }
  function considerUpNext() {
    var duration, segments, src, body, viewers, rating;
    if (!play || !play.item || !upNextCard || play.resumePending || play.errorOn || play.airing !== 'show') return;
    if (play.upNextDismissed || play.advanced) return;
    if (!window.ontoPlayerExtras || !window.ontoPlayerExtras.isSerial(play.item)) return;
    if (!play.channel) return;
    duration = media.duration() || play.item.duration || 0;
    segments = (play.scenes && play.scenes.segments) || [];
    if (!media.ended() && !window.ontoPlayerExtras.upNextDue(media.time(), duration, segments)) return;
    if (play.upNextLabel) { showUpNext(play.upNextLabel); return; }
    if (play.upNextAsked) return;
    play.upNextAsked = true;
    src = play.item.src;
    body = { channel: play.channel.id, current: src, peek: true };
    viewers = storedViewers();
    rating = storedRating();
    if (viewers !== null) body.viewers = viewers;
    if (rating) body.rating = rating;
    post('/api/next', body).then(function (item) {
      if (!play || play.advanced || play.upNextDismissed || !play.item || play.item.src !== src) return;
      play.upNextLabel = window.ontoPlayerExtras.offerUpNext(play.item, item) || '';
      if (play.upNextLabel) showUpNext(play.upNextLabel);
      else if (media.ended()) finishEpisode();
    }).catch(function () {
      if (!play || play.advanced || !play.item || play.item.src !== src) return;
      if (media.ended()) finishEpisode();
    });
  }
  function showStreamError(kind) {
    var box = $('play-error'), label = $('play-error-next'), retry = $('play-retry');
    if (!play || !errorCtrl) return;
    play.errorOn = true;
    play.errorKind = kind || 'media';
    play.resumePending = false;
    hideResume();
    if (upNextCard && upNextCard.active()) upNextCard.back();
    hideUpNext();
    osd.classList.add('has-error');
    errorCtrl.arm();
    if (label) label.textContent = errorCtrl.text();
    if (box) box.hidden = false;
    if (retry) retry.focus();
    showOsd();
    clearTimeout(errorTimer);
    errorTimer = setTimeout(errorTick, 1000);
  }
  function errorTick() {
    var action, label;
    if (!play || !play.errorOn || !errorCtrl) return;
    action = errorCtrl.tick(play.mode === 'channel');
    label = $('play-error-next');
    if (label) label.textContent = errorCtrl.text();
    if (action === 'wait') errorTimer = setTimeout(errorTick, 1000);
    else if (action === 'next' && play.channel) startChannel(play.channel, play.item, 'error');
  }
  function retryPlayback() {
    if (!play || !play.item) return;
    clearTimeout(errorTimer);
    if (play.errorKind === 'tune' && play.channel) {
      play.errorOn = false;
      hideError();
      if (errorCtrl) errorCtrl.retry();
      startChannel(play.channel, play.item, 'error');
      return;
    }
    play.errorOn = false;
    hideError();
    if (errorCtrl) errorCtrl.retry();
    startQueued(play.item);
  }

  function startChannel(channel, fromItem, reason) {
    var request = ++tuneRequest;
    var previousId = play && play.channel ? play.channel.id : '';
    if (play && play.item && (!fromItem || play.channel !== channel)) watchEvent('stop');
    if (play && play.item && play.channel && play.channel.id !== channel.id) rememberShow();
    if (!previousId || previousId !== channel.id) showTuning(channel);
    play = play && play.channel === channel ? play : { mode: 'channel', channel: channel };
    paintChannel(channel);
    var body = { channel: channel.id };
    var viewers = storedViewers(), rating = storedRating();
    if (viewers !== null) body.viewers = viewers;
    if (rating) body.rating = rating;
    if (fromItem) {
      body.current = fromItem.src;
      body.reason = reason;
      body.time = Math.floor(playbackPosition());
      body.watched = Math.floor(Math.max(0, play.watchedSeconds || 0));
      body.duration = Math.floor(fromItem.duration || (play.airing === 'show' ? media.duration() : 0) || 0);
    }
    return post('/api/next', body).then(function (item) { if (request === tuneRequest) load(item); }).catch(function (error) { if (request !== tuneRequest) return; if (play) { showStreamError('tune'); return; } stopPlayback(); fail(error); });
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
    hideTuning();
    clearTimeout(navTimer);
    clearTimeout(stripTimer);
    clearTimeout(upNextTimer);
    clearTimeout(errorTimer);
    clearInterval(sweepTimer);
    seekPreview = null;
    navState = window.ontoNav.initial();
    closeOptions();
    hideAdChip();
    hideIntro();
    hideUpNext();
    hideResume();
    hideError();
    var strip = $('jump-strip');
    if (strip) { strip.hidden = true; strip.innerHTML = ''; }
    if (play && play.item && play.airing !== 'ad' && !media.ended()) { watchEvent('stop'); saveProgress(false); }
    if (desktopQuery) window.parent.postMessage({ type: 'onto:desktop-home' }, '*');
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
    if (play && play.resumePending) return;
    if (play && play.airing === 'show') followSegments();
    if (play && play.airing === 'show') considerUpNext();
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
    if (upNextCard && upNextCard.active()) return;
    if (play && play.upNextDismissed) { showOsd(); return; }
    if (play && window.ontoPlayerExtras && window.ontoPlayerExtras.isSerial(play.item)) { considerUpNext(); return; }
    next('ended');
  });
  media.on('error', function () {
    if (!play) return;
    if (play.airing === 'ad') return advanceAd();
    mediaState = 'error';
    diag('play_error', { page: 'player', engine: media.engine || 'video', state: 'error', errorCode: 'media' });
    watchEvent('error');
    // Stay on the channel. Retry reloads this file; after 5 s the channel moves on.
    showStreamError('media');
  });
  media.on('pause', function () { mediaState = media.paused() ? 'paused' : 'loading'; if (media.paused()) { watchEvent('pause'); diag('pause', diagnosticSample()); } updateOsd(); showOsd(); });
  // On a phone the first tap brings up the controls; a tap with them showing pauses.
  video.addEventListener('click', function () {
    if (GUEST && osd.classList.contains('hidden')) { showOsd(); return; }
    togglePause();
  });
  // Tap or click the progress bar to jump there.
  $('osd-track').addEventListener('click', function (event) {
    if (!play || play.airing === 'ad') return;
    var box = this.getBoundingClientRect(), duration = media.duration() || (play.item && play.item.duration) || 0;
    if (!box.width || !duration) return;
    media.seek(Math.max(0, Math.min(duration - 1, duration * (event.clientX - box.left) / box.width)));
    updateOsd();
    showOsd();
  });
  // Guest back: the on-screen button and the phone's own back gesture both return to channels.
  var guestEntry = false;
  function guestBack() {
    if (guestEntry) { history.back(); return; }
    stopPlayback();
  }
  $('osd-back').addEventListener('click', guestBack);
  window.addEventListener('popstate', function () {
    if (!GUEST) return;
    guestEntry = false;
    if (!$('player').hidden) stopPlayback();
  });
  $('osd-play').addEventListener('click', togglePause);
  $('osd-prev-scene').addEventListener('click', function () { commitJump(-1); });
  $('osd-next-scene').addEventListener('click', function () { commitJump(1); });
  $('osd-options').addEventListener('click', openOptions);
  $('osd-next').addEventListener('click', function () { next('skip'); });
  $('skip-intro').addEventListener('click', function () {
    if (play && play.pendingCredits && !play.pendingIntro) skipCredits();
    else skipIntro();
  });
  if ($('up-next-play')) $('up-next-play').addEventListener('click', acceptUpNext);
  if ($('resume-play')) $('resume-play').addEventListener('click', function () { resumeIndex = 0; acceptResume(); });
  if ($('resume-start')) $('resume-start').addEventListener('click', function () { resumeIndex = 1; acceptResume(); });
  if ($('play-retry')) $('play-retry').addEventListener('click', retryPlayback);
  if ($('osd-cc')) $('osd-cc').addEventListener('click', function () { cycleSubs(); paintOptions(); updateOsd(); });
  if ($('osd-audio')) $('osd-audio').addEventListener('click', function () { cycleAudio(); paintOptions(); updateOsd(); });
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

  var digitBuffer = '', digitTimer = null;
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
    if (consoleState) { if (consoleKey(key)) event.preventDefault(); return; }
    if (pickerOpen) { if (pickerKey(key)) event.preventDefault(); return; }
    if (!$('setup').hidden) return;
    if (key >= 48 && key <= 57) {
      // Digits tune like a TV: wait briefly for a second digit when one could follow.
      clearTimeout(digitTimer);
      digitBuffer += String(key - 48);
      var typed = Number(digitBuffer), longer = false, cardsNow = gridCards();
      for (var d = 0; d < cardsNow.length; d++) {
        var n = String(cardsNow[d].number);
        if (n.length > digitBuffer.length && n.indexOf(digitBuffer) === 0) longer = true;
      }
      if (longer) { digitTimer = setTimeout(function () { var v = Number(digitBuffer); digitBuffer = ''; tuneNumber(v); }, 1200); }
      else { digitBuffer = ''; tuneNumber(typed); }
      event.preventDefault();
      return;
    }
    var playing = !$('player').hidden;
    if (!playing && play && (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE)) { stopPlayback(); event.preventDefault(); return; }
    if (playing) {
      if (upNextCard && upNextCard.active() && (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE)) { cancelUpNext(); event.preventDefault(); return; }
      if (optionOpen && (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE)) { closeOptions(); event.preventDefault(); return; }
      if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE || key === KEY.STOP) { stopPlayback(); event.preventDefault(); return; }
      if (play && play.resumePending) {
        var resumeName = navKey(key);
        if (resumeName === 'left') { focusResume(-1); event.preventDefault(); return; }
        if (resumeName === 'right') { focusResume(1); event.preventDefault(); return; }
        if (resumeName === 'ok') { acceptResume(); event.preventDefault(); return; }
        if (resumeName !== 'up' && resumeName !== 'down') { event.preventDefault(); return; }
      }
      if (play && play.errorOn) {
        if (navKey(key) === 'ok') retryPlayback();
        event.preventDefault();
        return;
      }
      if (upNextCard && upNextCard.active() && navKey(key) === 'ok') { acceptUpNext(); event.preventDefault(); return; }
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
    if (consoleState) return;
    clearInterval(sweepTimer);
    sweepDir = 0;
    var name = navKey(event.keyCode);
    if (!name) return;
    if (play && play.errorOn) return;
    if (play && play.resumePending && name !== 'up' && name !== 'down') return;
    if (upNextCard && upNextCard.active() && name === 'ok') return;
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

  loadLayoutStore();
  syncProfileFromStorage();
  paintBodyProfile();
  paintClock();
  setInterval(paintClock, 1000);
  setInterval(watchBand, 30000);
  loadHome();
})();
