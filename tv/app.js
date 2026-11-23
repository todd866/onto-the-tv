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
    CH_UP: 427, CH_DOWN: 428, SPACE: 32, SUBT: 0, INFO: 457 };
  var ANTENNA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 28" focusable="false"><path d="M8 24 L40 4 L72 24" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var PERSON_SVG = '<svg class="person-off" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="18" r="10"/><path d="M12 54c2-16 10-22 20-22s18 6 20 22"/></svg><svg class="person-on" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor"><circle cx="32" cy="18" r="11"/><path d="M10 56c2-18 12-26 22-26s20 8 22 26z"/></svg>';
  var PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round" d="M11 6 L26 16 L11 26 Z"/></svg>';
  var GAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="20" width="172" height="74" rx="30"/><path d="M62 40v32M46 56h32"/><circle cx="138" cy="48" r="8" fill="currentColor" stroke="none"/><circle cx="160" cy="70" r="8" fill="currentColor" stroke="none"/></svg>';
  var UKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 230"><rect x="32" y="4" width="56" height="28" rx="7" fill="currentColor"/><rect x="51" y="26" width="18" height="62" fill="currentColor"/><ellipse cx="60" cy="108" rx="30" ry="28" fill="currentColor"/><ellipse cx="60" cy="160" rx="44" ry="40" fill="currentColor"/><circle cx="46" cy="18" r="3.5" fill="#0b1428"/><circle cx="56" cy="18" r="3.5" fill="#0b1428"/><circle cx="66" cy="18" r="3.5" fill="#0b1428"/><circle cx="76" cy="18" r="3.5" fill="#0b1428"/><circle cx="60" cy="162" r="11" fill="#0b1428"/></svg>';
  var CONSOLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="26" width="180" height="66" rx="33"/><path d="M56 44v30M41 59h30"/><path d="M128 59h24M140 47v24"/></svg>';
  function appGlyph(id) {
    if (id === 'games') return GAME_SVG;
    if (id === 'uke') return UKE_SVG;
    if (id === 'console') return CONSOLE_SVG;
    var extra = window.ontoAppGlyphs && window.ontoAppGlyphs[id];
    return extra || '';
  }
  var SAVE_EVERY = 15000, OSD_MS = 4000;
  // Who watches comes from the server's household (GET /api/household), cached for the next start. Until it
  // answers, a generic household stands in; no name or id of a real one is written here.
  var HOUSEHOLD = {
    viewers: [{ id: 'kid1', name: 'Robin', ceiling: 'G', role: 'youngest' }, { id: 'kid2', name: 'Max', ceiling: 'PG', role: 'older' },
      { id: 'adult2', name: 'Jordan', ceiling: null, role: 'adultB' }, { id: 'adult1', name: 'Casey', ceiling: null, role: 'adultA' }],
    profiles: [
      { id: 'adult1', name: 'Casey', mark: 'C', viewers: ['adult1'], layout: 'now', theme: 'amber' },
      { id: 'adult2', name: 'Jordan', mark: 'J', viewers: ['adult2'], layout: 'guide', theme: 'rose' },
      { id: 'kid2', name: 'Max', mark: 'M', viewers: ['kid2', 'adult2', 'adult1'], layout: 'tube', theme: 'lime' },
      { id: 'kid1', name: 'Robin', mark: 'R', viewers: ['kid1', 'kid2', 'adult2', 'adult1'], layout: 'pictures', theme: 'coral' },
      { id: 'all', name: 'Everyone', mark: '\u2605', viewers: ['kid1', 'kid2', 'adult2', 'adult1'], layout: 'now', theme: 'teal' }
    ]
  };
  var FALLBACK_VIEWERS = [];

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video'), osd = $('osd');
  var data = { channels: [], viewers: [], ceiling: null };
  var rows = [];
  var focus = { row: 0, col: 0 };
  var nowPage = 0;
  var nowAllCards = [];
  var homeRequest = 0;
  var play = null;          // { mode: 'channel', channel, item, visitStart, lastSave }
  var osdTimer = 0, gameState = null, tuneRequest = 0, tuneMark = 0, tuneTimer = 0;
  var navState = window.ontoNav.initial();
  var navTimer = 0, stripTimer = 0, optionOpen = false, optionRow = 0;
  var upNextTimer = 0, errorTimer = 0, sweepTimer = 0, seekPreview = null, resumeIndex = 0, sweepDir = 0;
  var upNextCard = null, seekCtrl = null, errorCtrl = null;
  var sessionIntro = {}, showStack = [];
  var watchBack = window.ontoWatchBack ? window.ontoWatchBack.create() : null;
  var channelArm = window.ontoChannelArm ? window.ontoChannelArm.create() : null;
  var armTimer = 0, armedRequest = 0, prefetchTimer = 0, continueOpen = false, continueIndex = 0;
  var overlayFocus = '', transportIndex = 1, scrub = null, directionsShown = null, arrowHoldRepeats = 0;
  var pressedKeys = window.ontoRemoteMap.pressedKeys();
  var homeCache = {}, channelPrefetch = {};
  try {
    if (watchBack) {
      var savedBack = JSON.parse(localStorage.getItem('onto.back.v1') || 'null');
      if (savedBack) watchBack.load(savedBack);
    }
  } catch (eBack) {}
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
  function answer(started, input) {
    var stamp = started || Date.now();
    var report = function () {
      var ms = Date.now() - stamp;
      if (ms < 0 || ms > 60000) return;
      diag('key_latency', { latencyMs: ms, input: input || 'arrows' });
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(function () { window.requestAnimationFrame(report); });
    else setTimeout(report, 32);
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


  // A browser on another device that has not paired gets 401 (server enforce mode): send it to the pairing page
  // once. Never inside the Mac app's frame (its requests carry the token) or the packaged TV app.
  var pairSent = false;
  function needsPairing(status) {
    if (status !== 401 || PACKAGED || GUEST || pairSent) return;
    try { if (window.top !== window) return; } catch (e) { return; }
    pairSent = true;
    location.href = '/pair.html?next=' + q(location.pathname + location.search);
  }
  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (TOKEN) options.headers['X-Onto-Token'] = TOKEN;
    // Same-origin pages are paired by an HttpOnly cookie; older fetch() omits cookies unless asked.
    if (!PACKAGED && !options.credentials) options.credentials = 'same-origin';
    return fetch(SERVER + path, options).then(function (response) {
      needsPairing(response.status);
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
    try { return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : ''; } catch (e) { return ''; }
  }
  var desktopChannel = desktopQuery ? desktopParam('channel') : '';
  // Find a show in the Mac app: one named episode instead of a channel.
  var desktopPlay = desktopQuery ? desktopParam('play') : '';
  if (desktopQuery) { document.body.classList.add('desktop-embedded'); document.body.classList.add('desktop-frame'); }
  // The Mac app owns browsing and faults: its window shows this page only once something plays.
  // hello tells it this copy reports playing and errors (an older copy does neither).
  function tellDesktop(type, status) {
    if (!desktopQuery) return;
    // n names the tune this page was opened for, so the app can ignore a message from the one before.
    try { window.parent.postMessage({ type: type, status: status || 0, n: desktopParam('n') }, '*'); } catch (e) {}
  }
  tellDesktop('onto:desktop-hello');
  // The TV's own Library is a ten-foot screen; in the Mac window the app's Find a show does that job.
  if (desktopQuery) (function () {
    var own = document.querySelector('#options [data-opt="library"]');
    if (own && own.parentNode) own.parentNode.removeChild(own);
  }());
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
  // Profiles replace the old who's-watching segments: colours (theme), layout and lineup audience.
  var PROFILES = [], ROLE_IDS = {}, householdReal = false;
  function useHousehold(household, real) {
    var list = [], i, p, ids;
    if (!household || !household.viewers || !household.viewers.length || !household.profiles || !household.profiles.length) return false;
    for (i = 0; i < household.profiles.length; i++) {
      p = household.profiles[i];
      ids = p && p.viewers && p.viewers.join ? p.viewers.join(',') : '';
      if (!p || !p.id || !ids) continue;
      list.push({ id: String(p.id), name: String(p.name || p.id), mark: String(p.mark || ''), viewers: ids, layout: p.layout || 'now', theme: p.theme || 'default' });
    }
    if (!list.length) return false;
    PROFILES = list;
    householdReal = real !== false;
    ROLE_IDS = {};
    FALLBACK_VIEWERS = [];
    for (i = 0; i < household.viewers.length; i++) {
      p = household.viewers[i];
      if (!p || !p.id) continue;
      if (p.role) ROLE_IDS[p.role] = p.id;
      FALLBACK_VIEWERS.push({ id: String(p.id), name: String(p.name || p.id), on: true });
    }
    return true;
  }
  (function () {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('onto.household') || 'null'); } catch (e) { cached = null; }
    if (!useHousehold(cached)) useHousehold(HOUSEHOLD, false);
  }());
  var LAYOUTS = [
    { id: 'now', glyph: '\u25A3', title: 'Now on' },
    { id: 'guide', glyph: '\u2630', title: 'Guide' },
    { id: 'pictures', glyph: '\u25A6', title: 'Pictures' },
    { id: 'tube', glyph: '\u25A4', title: 'Tube' }
  ];
  var RATINGS = ['G', 'PG', 'M'];
  var profileId = 'all';
  var layoutStore = {};
  var pickerOpen = false;
  function profileById(id) {
    for (var p = 0; p < PROFILES.length; p++) if (PROFILES[p].id === id) return PROFILES[p];
    return PROFILES[0];
  }
  // The profile an old who's-watching choice maps to, by role: a grown-up alone is theirs; the youngest without the
  // older child is the youngest's; both children is everyone; the older child is theirs; the grown-ups together
  // are the first grown-up's.
  function profileOf(id, fallback) {
    for (var p = 0; p < PROFILES.length; p++) if (PROFILES[p].id === id) return id;
    return fallback;
  }
  function profileFromViewers(viewers) {
    if (!viewers) return 'all';
    var ids = String(viewers).split(','), i, has = function (role) { return !!ROLE_IDS[role] && ids.indexOf(ROLE_IDS[role]) >= 0; };
    for (i = 0; i < ids.length; i++) if (!ids[i]) ids.splice(i--, 1);
    if (ids.length === 1 && ids[0] === ROLE_IDS.adultA) return profileOf(ROLE_IDS.adultA, 'all');
    if (ids.length === 1 && ids[0] === ROLE_IDS.adultB) return profileOf(ROLE_IDS.adultB, 'all');
    if (has('youngest')) return has('older') ? 'all' : profileOf(ROLE_IDS.youngest, 'all');
    if (has('older')) return profileOf(ROLE_IDS.older, 'all');
    if (has('adultA') && has('adultB')) return profileOf(ROLE_IDS.adultA, 'all');
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
    // Until the real household is known (first start after an update), keep the saved choice untouched.
    if (!householdReal) {
      try { profileId = localStorage.getItem('onto.profile') || 'all'; } catch (e0) { profileId = 'all'; }
      return;
    }
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
    if (GUEST || desktopQuery || !householdReal) return;
    try { localStorage.setItem('onto.profile', profileId); } catch (e) {}
  }
  var THEMES = ['default', 'amber', 'rose', 'lime', 'coral', 'teal'];
  function paintBodyProfile() {
    var i, list = document.body.classList;
    for (i = 0; i < THEMES.length; i++) list.remove('theme-' + THEMES[i]);
    if (!GUEST) list.add('theme-' + (profileById(profileId).theme || 'default'));
  }
  // The real household, from the server (names never ship in a static file). Applied once it answers; a change
  // since the cached copy rebuilds the picker and repaints.
  function loadHousehold() {
    if (GUEST) return;
    api('/api/household').then(function (household) {
      var text = JSON.stringify(household), before = null;
      try { before = localStorage.getItem('onto.household'); localStorage.setItem('onto.household', text); } catch (e) {}
      if (text === before || !useHousehold(household)) return;
      var people = $('picker-people');
      if (people) people.textContent = '';
      syncProfileFromStorage();
      paintBodyProfile();
      if (data.channels && data.channels.length) render();
    }, function () {});
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
      if (window.ontoLibraryCard) cards.push(window.ontoLibraryCard(last));
    }
    // The server orders the lineup for this audience; the app tiles follow it.
    return cards;
  }
  function nowLayoutActive() { return layoutMode() === 'now' && !GUEST; }
  function nowResumeEntries() {
    var entries = resumeEntries(), have = {}, r;
    for (r = 0; r < entries.length; r++) have[entries[r].src] = true;
    if (!GUEST) entries = entries.concat(likedEntries(have));
    return entries;
  }
  function buildNowAllCards() {
    var entries = nowResumeEntries(), cards = [], i;
    for (i = 0; i < entries.length; i++) cards.push({ _resumeEntry: entries[i] });
    return cards.concat(gridCards());
  }
  function nowCols() { return columnCount(); }
  function nowPageCount() { return Math.max(1, Math.ceil(nowAllCards.length / nowCols())); }
  function paintNowPager() {
    var el = $('now-pager');
    if (!nowLayoutActive()) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    var cur = nowPage + 1, total = nowPageCount();
    el.innerHTML = 'page <b>' + cur + '</b> / ' + total;
  }
  function paintHeroFromEntry(entry) {
    if (!entry) return;
    paintHero({ number: entry.liked ? '\u2665' : 'Continue', name: entry.liked ? 'Liked' : ('resume ' + clock(entry.positionSeconds || 0)),
      now: { show: entry.show || entry.title || '', title: entry.title && entry.title !== entry.show ? entry.title : '',
        art: entry.art, minutes: entry.duration ? Math.max(1, Math.round(entry.duration / 60)) : 0 } });
  }
  function heroForNowEl(el) {
    if (!el) return;
    if (el._entry) paintHeroFromEntry(el._entry);
    else if (el._item && !el._item.app) paintHero(el._item);
  }
  function channelsRowIndex() {
    var i;
    for (i = 0; i < rows.length; i++) if (rows[i].kind === 'channels') return i;
    return -1;
  }
  function refreshNowPageRow(col) {
    var cols = nowCols(), holder = $('channels'), start = nowPage * cols, els = [], c;
    holder.innerHTML = '';
    for (c = start; c < start + cols && c < nowAllCards.length; c++) {
      var btn = channelButton(nowAllCards[c], c);
      holder.appendChild(btn);
      els.push(btn);
    }
    paintNowPager();
    var ri = channelsRowIndex();
    if (ri >= 0) rows[ri].els = els;
    if (col < 0) col = 0;
    if (col >= els.length) col = els.length - 1;
    focus.col = col;
    var focused = $('home').querySelectorAll('.focused');
    for (var f = 0; f < focused.length; f++) focused[f].classList.remove('focused');
    var pick = els[col];
    if (!pick) return;
    pick.classList.add('focused');
    try { pick.focus(); } catch (e) {}
    heroForNowEl(pick);
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
    if (id === 'now') nowPage = 0;
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
  // Billboard backdrop: the focused channel's picture fills the screen (Now layout only). A curated still
  // (1280+ px wide) is shown sharp and drifts; the 640 px generated art is softened into ambience.
  var backdropUrl = '', heroChannelId = '';
  // Cross-fades overlap when the focus moves quickly: each picture removes only those older than itself.
  var pictureSeq = 0;
  function dropOlder(box, img) {
    var mine = +img.getAttribute('data-seq'), all = box.getElementsByTagName('img'), i;
    for (i = all.length - 1; i >= 0; i--) if (+all[i].getAttribute('data-seq') < mine) box.removeChild(all[i]);
  }
  function backdropScrim() {
    var scrim = $('backdrop-scrim'), bg = '', m;
    if (!scrim) return;
    try { bg = window.getComputedStyle(document.body).backgroundColor || ''; } catch (e) { bg = ''; }
    m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    var c = m ? m[1] + ',' + m[2] + ',' + m[3] : '7,16,12';
    var key = 'scrim:' + c;
    if (scrim.getAttribute('data-c') === key) return;
    scrim.setAttribute('data-c', key);
    scrim.style.background =
      'linear-gradient(to right, rgba(' + c + ',.94) 0, rgba(' + c + ',.78) 30%, rgba(' + c + ',.25) 58%, rgba(' + c + ',0) 75%),' +
      'linear-gradient(to bottom, rgba(' + c + ',.7) 0, rgba(' + c + ',0) 20%, rgba(' + c + ',0) 48%, rgba(' + c + ',.72) 70%, rgb(' + c + ') 90%)';
  }
  // Picture pools per channel (server /api/channel-art): the billboard and the screensaver draw from them.
  var channelPools = {}, poolTimer = 0, poolIndex = 0, backdropKey = '';
  function loadPools() {
    api('/api/channel-art').then(function (body) { channelPools = (body && body.pools) || {}; }, function () {});
  }
  function showBackdropImage(url, soft) {
    var box = $('backdrop');
    if (!box || !url) return;
    backdropUrl = url;
    var image = new Image();
    image.onload = function () {
      if (backdropUrl !== url) return;
      var img = document.createElement('img');
      img.alt = '';
      if (soft) img.className = 'soft';
      img.src = url;
      box.insertBefore(img, $('backdrop-scrim'));
      // Next frame, so the opacity transition runs; older pictures leave once this one is in.
      img.setAttribute('data-seq', String(++pictureSeq));
      setTimeout(function () {
        img.className += ' on';
        setTimeout(function () { dropOlder(box, img); }, 800);
      }, 30);
    };
    image.src = url;
  }
  // A hand-picked still (1280+ px) for the title wins; otherwise the channel's pool, one picture every 15 s;
  // otherwise the 640 px generated art, softened into ambience.
  function setBackdrop(url, channelId) {
    document.body.classList.add('billboard');
    backdropScrim();
    var key = (channelId || '') + '|' + (url || '');
    if (key === backdropKey) return;
    backdropKey = key;
    clearInterval(poolTimer); poolTimer = 0;
    var pool = channelPools[channelId] || [];
    var usePool = function () {
      if (!pool.length || backdropKey !== key) return false;
      poolIndex = Math.floor(Math.random() * pool.length);
      showBackdropImage(artUrl(pool[poolIndex].url), false);
      if (pool.length > 1) poolTimer = setInterval(function () {
        if (backdropKey !== key) { clearInterval(poolTimer); return; }
        if ($('home').hidden) return; // nothing decodes behind the player
        poolIndex = (poolIndex + 1) % pool.length;
        showBackdropImage(artUrl(pool[poolIndex].url), false);
      }, 15000);
      return true;
    };
    if (!url) { usePool(); return; }
    var probe = new Image();
    probe.onload = function () {
      if (backdropKey !== key) return;
      if ((probe.naturalWidth || 0) >= 1280) showBackdropImage(url, false);
      else if (!usePool()) showBackdropImage(url, true);
    };
    probe.onerror = function () { if (backdropKey === key) usePool(); };
    probe.src = url;
  }
  function clearBackdrop() { document.body.classList.remove('billboard'); clearInterval(poolTimer); poolTimer = 0; backdropKey = ''; }
  function paintHero(item) {
    var hero = $('hero'), mode = layoutMode();
    if (!item || item.app || mode === 'pictures' || mode === 'tube') { hero.hidden = true; hero.textContent = ''; clearBackdrop(); return; }
    hero.hidden = false;
    hero.className = mode === 'guide' ? 'hero-compact' : 'hero-full';
    if (mode === 'guide') clearBackdrop();
    else setBackdrop(item.now && item.now.art ? artUrl(item.now.art) : '', item.id);
    heroChannelId = item.id || '';
    document.body.classList.toggle('xmas-heavy', heroChannelId === 'christmas' || heroChannelId === 'fireplace');
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
    if (nowLayoutActive()) {
      if (window.innerWidth <= 600) return 1;
      if (window.innerWidth <= 1100) return 2;
      return 4;
    }
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
        glyphP.innerHTML = appGlyph(item.app);
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
    } else if (nowLayoutActive()) {
      var entryNow = item._resumeEntry;
      var pic = document.createElement('span');
      pic.className = 'now-card-pic';
      if (item.app) {
        var glyphNow = document.createElement('span');
        glyphNow.className = 'app-glyph';
        glyphNow.setAttribute('aria-hidden', 'true');
        glyphNow.innerHTML = appGlyph(item.app);
        pic.appendChild(glyphNow);
      } else if (entryNow) {
        var imgR = document.createElement('img');
        imgR.className = 'art';
        imgR.alt = '';
        pic.appendChild(imgR);
        var artR = entryNow.art || (entryNow.src ? '/art?src=' + q(entryNow.src) : '');
        if (artR) loadArt(imgR, artUrl(artR));
      } else if (item.now && item.now.art) {
        var imgN = document.createElement('img');
        imgN.className = 'art';
        imgN.alt = '';
        pic.appendChild(imgN);
        loadArt(imgN, artUrl(item.now.art));
      }
      button.appendChild(pic);
      var text = document.createElement('span');
      text.className = 'now-card-text';
      var line1 = document.createElement('span');
      line1.className = 'now-card-line1';
      var line2 = document.createElement('span');
      line2.className = 'now-card-line2 clamp2';
      if (entryNow) {
        button._entry = entryNow;
        var showName = entryNow.show || entryNow.title || '';
        var resumeMark = document.createElement('span');
        resumeMark.className = 'resume-mark';
        resumeMark.textContent = entryNow.liked ? '\u2665 ' : '\u25b6 ';
        line1.appendChild(resumeMark);
        line1.appendChild(document.createTextNode(showName));
        var ep = (entryNow.title && entryNow.title !== entryNow.show) ? entryNow.title : '';
        line2.textContent = ep;
        button.setAttribute('aria-label', (entryNow.liked ? 'Liked: ' : 'Continue: ') + showName + (ep ? ', ' + ep : ''));
      } else {
        var numNow = document.createElement('span');
        numNow.className = 'num';
        numNow.textContent = String(item.number);
        line1.appendChild(numNow);
        line1.appendChild(document.createTextNode(' ' + item.name));
        if (show) line2.textContent = show;
        button.setAttribute('aria-label', item.number + ' ' + item.name + (show ? ', ' + show : ''));
      }
      text.appendChild(line1);
      text.appendChild(line2);
      button.appendChild(text);
    } else {
      button.appendChild(antennaEl());
      var bezel = document.createElement('span');
      bezel.className = 'bezel';
      if (item.app) {
        var glyph = document.createElement('span');
        glyph.className = 'app-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.innerHTML = appGlyph(item.app);
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
      var ri = channelsRowIndex(), col = index % columnCount(), rowAt = ri >= 0 ? ri : rows.length - 1;
      if (nowLayoutActive()) {
        var colsTap = nowCols();
        nowPage = Math.floor(index / colsTap);
        focus = { row: rowAt, col: index - nowPage * colsTap };
        refreshNowPageRow(focus.col);
      } else {
        var topRows = 0, rowIndex;
        for (rowIndex = 0; rowIndex < rows.length; rowIndex++) if (rows[rowIndex].kind !== 'channels') topRows++;
        focus = { row: Math.floor(index / columnCount()) + topRows, col: col };
        moveFocus(0, 0);
      }
      if (button._entry) playResume(button._entry);
      else activate(item);
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
        b.setAttribute('data-theme', person.theme || 'default');
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
  // Back from the player lands on the tile you left from, found by what it is (channel id, episode src), not by
  // its index: watching something adds it to Continue at the front, which shifted every index by one and put
  // focus on the neighbour (22 Nov 2026, "I literally couldn't navigate to certain tiles").
  var homeReturn = null;
  function tileId(el) {
    if (!el) return '';
    if (el._entry && el._entry.src) return 'src:' + el._entry.src;
    if (el._item && el._item._resumeEntry && el._item._resumeEntry.src) return 'src:' + el._item._resumeEntry.src;
    if (el._item && el._item.id) return 'ch:' + el._item.id;
    return '';
  }
  function cardId(card) {
    if (!card) return '';
    if (card._resumeEntry && card._resumeEntry.src) return 'src:' + card._resumeEntry.src;
    return card.id ? 'ch:' + card.id : '';
  }
  function returnTarget() {
    if (!homeReturn || !homeReturn.pending) return '';
    return homeReturn.id;
  }
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
    if (layoutMode() === 'tube' && window.ontoTube) {
      var tubeHero = $('hero');
      tubeHero.hidden = true;
      tubeHero.textContent = '';
      window.ontoTube.paint();
      diag('rendered', { page: 'home', state: 'ready' });
      return;
    }
    if (window.ontoTube) window.ontoTube.hideChrome();
    $('home').classList.toggle('home-now', nowLayoutActive());
    var resumeEls = [], resumeRow = $('resume-row'), c;
    if (nowLayoutActive()) {
      resumeRow.hidden = true;
      resumeRow.innerHTML = '';
      nowAllCards = buildNowAllCards();
      var wantBack = returnTarget(), backAt = -1;
      for (var bi = 0; wantBack && bi < nowAllCards.length; bi++) if (cardId(nowAllCards[bi]) === wantBack) { backAt = bi; break; }
      if (backAt >= 0) nowPage = Math.floor(backAt / nowCols());
      if (nowPage >= nowPageCount()) nowPage = Math.max(0, nowPageCount() - 1);
    } else {
      resumeEls = paintResumeRow();
    }
    var cards = nowLayoutActive() ? nowAllCards : gridCards();
    var holder = $('channels');
    holder.className = 'layout-' + layoutMode();
    holder.innerHTML = '';
    if (nowLayoutActive()) {
      var colsRender = nowCols(), from = nowPage * colsRender, to = from + colsRender;
      for (c = from; c < to && c < cards.length; c++) holder.appendChild(channelButton(cards[c], c));
      paintNowPager();
    } else {
      for (c = 0; c < cards.length; c++) holder.appendChild(channelButton(cards[c], c));
      paintNowPager();
    }
    var firstChannel = null;
    for (var fc = 0; fc < gridCards().length; fc++) if (!gridCards()[fc].app) { firstChannel = gridCards()[fc]; break; }
    paintHero(firstChannel);
    rows = [];
    if (viewers.children.length && !GUEST) {
      var controls = viewers.querySelectorAll('.viewer');
      rows.push({ kind: 'viewers', els: controls });
    }
    if (resumeEls.length) rows.push({ kind: 'resume', els: resumeEls });
    if (nowLayoutActive()) {
      var pageEls = [];
      for (var pe = 0; pe < holder.children.length; pe++) pageEls.push(holder.children[pe]);
      if (pageEls.length) rows.push({ kind: 'channels', els: pageEls });
    } else {
      for (var start = 0; start < holder.children.length; start += columnCount()) {
        var slice = [];
        for (var n = start; n < holder.children.length && n < start + columnCount(); n++) slice.push(holder.children[n]);
        rows.push({ kind: 'channels', els: slice });
      }
    }
    if (!rows.length) return;
    var backTo = returnTarget();
    if (backTo) {
      for (var rr = 0; rr < rows.length; rr++) {
        if (rows[rr].kind === 'viewers') continue;
        for (var rc = 0; rc < rows[rr].els.length; rc++) if (tileId(rows[rr].els[rc]) === backTo) { focus.row = rr; focus.col = rc; rr = rows.length; break; }
      }
    }
    if (focus.row > rows.length - 1) focus.row = rows.length - 1;
    moveFocus(0, 0);
    diag('rendered', { page: 'home', state: 'ready' });
  }
  function moveFocus(dRow, dCol) {
    if (!rows.length) return;
    if (nowLayoutActive() && dCol && rows[focus.row] && rows[focus.row].kind === 'channels') {
      var prow = rows[focus.row];
      if (dCol === 1 && focus.col === prow.els.length - 1 && (nowPage + 1) * nowCols() < nowAllCards.length) {
        nowPage++;
        refreshNowPageRow(0);
        return;
      }
      if (dCol === -1 && focus.col === 0 && nowPage > 0) {
        nowPage--;
        refreshNowPageRow(prow.els.length - 1);
        return;
      }
    }
    var previous = rows[focus.row] || rows[0];
    if (!rows[focus.row]) focus.row = 0;
    focus.row = Math.max(0, Math.min(rows.length - 1, focus.row + dRow));
    var row = rows[focus.row];
    if (dRow && previous !== row) focus.col = Math.min(focus.col, row.els.length - 1);
    focus.col = Math.max(0, Math.min(row.els.length - 1, focus.col + dCol));
    // Only the home screen's marks: a home repaint that lands while the Library is open over it (the server's
    // answer after Back from a Library episode) wiped the Library's focus and left nothing focused (22 Nov 2026).
    var focused = $('home').querySelectorAll('.focused');
    for (var i = 0; i < focused.length; i++) focused[i].classList.remove('focused');
    var el = row.els[focus.col];
    if (!el) return;
    el.classList.add('focused');
    if (!(window.ontoLibrary && window.ontoLibrary.isOpen())) { try { el.focus(); } catch (e) {} }
    if (row.kind === 'chips') {
      var scroller = $('tube-chips');
      if (scroller) {
        if (el.offsetLeft < scroller.scrollLeft) scroller.scrollLeft = el.offsetLeft - 12;
        else if (el.offsetLeft + el.offsetWidth > scroller.scrollLeft + scroller.clientWidth) {
          scroller.scrollLeft = el.offsetLeft + el.offsetWidth - scroller.clientWidth + 12;
        }
      }
    }
    if (row.kind === 'avatars') {
      // The creator circles scroll sideways inside their strip; keep the focused one whole on screen.
      var avStrip = el.parentNode, avBox = el.getBoundingClientRect(), avArea = avStrip.getBoundingClientRect();
      var avRight = Math.min(avArea.right, window.innerWidth);
      if (avBox.left < avArea.left + 12) avStrip.scrollLeft -= avArea.left + 12 - avBox.left;
      else if (avBox.right > avRight - 12) avStrip.scrollLeft += avBox.right - avRight + 12;
    }
    if (row.kind === 'grid' || row.kind === 'avatars') {
      var tubeHolder = $('channels'), tubeBox = el.getBoundingClientRect(), tubeArea = tubeHolder.getBoundingClientRect();
      if (tubeBox.top < tubeArea.top + 36) tubeHolder.scrollTop -= tubeArea.top + 36 - tubeBox.top;
      if (tubeBox.bottom > tubeArea.bottom - 40) tubeHolder.scrollTop += tubeBox.bottom - tubeArea.bottom + 40;
    }
    if (row.kind === 'resume') {
      // The row holds more tiles than fit: it scrolls sideways inside itself to keep the focused one in view.
      var strip = $('resume-row'), tile = el.getBoundingClientRect(), view = strip.getBoundingClientRect();
      if (tile.left < view.left + 16) strip.scrollLeft -= view.left + 16 - tile.left;
      if (tile.right > view.right - 16) strip.scrollLeft += tile.right - view.right + 16;
      // The big panel shows the focused tile in full: a tile is too narrow for a long title.
      var held = el._entry;
      if (held) paintHero({ number: held.liked ? '\u2665' : 'Continue', name: held.liked ? 'Liked' : ('resume ' + clock(held.positionSeconds || 0)),
        now: { show: held.show || held.title || '', title: held.title && held.title !== held.show ? held.title : '', art: held.art,
          minutes: held.duration ? Math.max(1, Math.round(held.duration / 60)) : 0 } });
    }
    if (row.kind === 'channels') {
      if (!nowLayoutActive()) {
        var holder = $('channels'), box = el.getBoundingClientRect(), area = holder.getBoundingClientRect();
        var padTop = 36, padBottom = 40;
        if (box.top < area.top + padTop) holder.scrollTop -= area.top + padTop - box.top;
        if (box.bottom > area.bottom - padBottom) holder.scrollTop += box.bottom - area.bottom + padBottom;
      }
      heroForNowEl(el);
    }
    if (layoutMode() === 'tube' && window.ontoTube && row.kind === 'grid') window.ontoTube.nearEnd();
  }
  function activate(item) {
    if (!item) return;
    if (item.app === 'library' && window.ontoLibrary) return window.ontoLibrary.open({ from: 'home' });
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
    homeReturn = row.kind === 'viewers' ? null : { id: tileId(el), pending: false };
    if (row.kind === 'viewers') {
      if (el.getAttribute('data-profile') === 'chip') return openPicker();
      if (el.getAttribute('data-layout')) return chooseLayout(el.getAttribute('data-layout'));
      return chooseRating(el.getAttribute('data-rating'));
    }
    if (row.kind === 'resume') return playResume(el._entry);
    if (row.kind === 'channels' && el._entry) return playResume(el._entry);
    activate(el._item);
  }
  function applyHome(home, request) {
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
    if (desktopPlay && window.ontoPlayLibrary) {
      var wanted = desktopPlay;
      desktopPlay = '';
      window.ontoPlayLibrary({ src: wanted, title: desktopParam('title'), show: desktopParam('show'), resume: Number(desktopParam('at')) || 0 });
      return;
    }
    if (desktopChannel) {
      var requestedChannel = desktopChannel;
      desktopChannel = '';
      for (var c = 0; c < data.channels.length; c++) {
        if (data.channels[c].id === requestedChannel) { startChannel(data.channels[c]); return; }
      }
      tellDesktop('onto:desktop-home');
    }
  }
  function loadHome() {
    var path = homePath();
    var request = ++homeRequest, shown = '';
    if (homeCache[path]) {
      try { applyHome(JSON.parse(homeCache[path]), request); shown = homeCache[path]; } catch (eCache) { mediaState = 'connecting'; }
    } else mediaState = 'connecting';
    return api(path).then(function (home) {
      if (request !== homeRequest) return;
      var fresh = '';
      try { fresh = JSON.stringify(home); homeCache[path] = fresh; } catch (eStore) {}
      // The server's answer matches what is on screen: no second rebuild of every card under the viewer's thumb.
      if (shown && fresh === shown) return;
      applyHome(home, request);
    }).catch(function (error) {
      if (request !== homeRequest) return;
      if (homeCache[path]) return;
      mediaState = 'offline';
      diag('offline', { page: 'home', state: 'offline' });
      if (PACKAGED) return findServer();
      tellDesktop('onto:desktop-error', error && error.status);
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
    // Not scrollIntoView({ block }): Chromium 47 reads the object as alignToTop and snaps the list.
    if (focused) {
      var fBox = focused.getBoundingClientRect(), lBox = list.getBoundingClientRect();
      if (fBox.top < lBox.top) list.scrollTop -= lBox.top - fBox.top;
      else if (fBox.bottom > lBox.bottom) list.scrollTop += fBox.bottom - lBox.bottom;
    }
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
        loadHousehold();
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
      loadHousehold();
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

  var pendingTapSeek = null, tapSeekScheduled = false, lastTracksKey = '', lastScreenSaverAllow = null, reportNowTimer = 0;
  function syncScreenSaver() {
    var allow = !play || pausedNow() || mediaState === 'error';
    if (allow === lastScreenSaverAllow) return;
    lastScreenSaverAllow = allow;
    try {
      if (window.webapis && webapis.appcommon && typeof webapis.appcommon.setScreenSaver === 'function') {
        var saverState = allow
          ? webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
          : webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF;
        webapis.appcommon.setScreenSaver(saverState, function () {}, function () {});
      }
    } catch (e) {}
  }
  function playerOverlay() {
    return !!(play && (play.resumePending || play.errorOn)) || (upNextCard && upNextCard.active());
  }
  function osdOpen() { return osd && !osd.classList.contains('hidden'); }
  function clearTapSeekChrome() {
    $('player').classList.remove('is-tap-seeking');
    var bubble = $('osd-seek-time');
    if (bubble) bubble.textContent = '';
  }
  function showOsd() {
    if (!play || $('player').hidden) return;
    osd.classList.remove('hidden');
    paintBackChip();
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () {
      osdTimer = 0;
      if (!play || $('player').hidden) return;
      // The directions tray is read, not glanced at: it stays three times as long.
      if (directionsShown && Date.now() - directionsShown.touched < OSD_MS * 3 - 100) { directionsShown.touched -= 1; showOsd(); return; }
      // Transport, continue and scrub focus keep the bar up while keys are being pressed, but not for ever:
      // eight quiet seconds and it goes (Ian, 21 Nov 2026: "the bottom bar never disappears").
      if (overlayFocus && Date.now() - lastInput < OSD_MS * 2) { showOsd(); return; }
      if (!pausedNow() && !playerOverlay()) {
        osd.classList.add('hidden');
        paintBackChip();
        overlayFocus = '';
        closeContinue();
        clearTransportFocus();
        clearScrubFocus();
        clearTapSeekChrome();
      }
    }, OSD_MS);
  }
  function paintOsdLabels(item) {
    if (!item) return;
    var shown0 = item.display || {};
    $('osd-show').textContent = shown0.show || item.show || '';
    $('osd-episode').textContent = shown0.episode || '';
    $('osd-show').title = item.title || item.show || '';
  }
  function updateOsd() {
    if (!play || !play.item) return;
    var duration = media.duration() || play.item.duration || 0;
    var channel = play.channel;
    var isPaused = pausedNow();
    var mediaNow = pendingTapSeek ? pendingTapSeek.target : media.time();
    if (play.mode === 'tube') {
      paintChannel({ name: play.item.show || '' });
      $('osd-show').textContent = '';
      $('osd-episode').textContent = play.item.title || '';
    } else {
      paintChannel(channel);
      paintOsdLabels(play.item);
    }
    $('osd-play').setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
    var shown = seekPreview != null ? seekPreview : mediaNow;
    $('osd-elapsed').textContent = clock(shown);
    $('osd-elapsed').classList.toggle('is-preview', seekPreview != null);
    $('osd-duration').textContent = clock(duration);
    $('osd-fill').style.width = duration ? Math.min(100, 100 * mediaNow / duration) + '%' : '0';
    var seekMark = $('osd-seek');
    if (seekMark) {
      if (seekPreview == null || !duration) seekMark.hidden = true;
      else { seekMark.hidden = false; seekMark.style.left = Math.min(100, 100 * seekPreview / duration) + '%'; }
    }
    var tracksKey = (play.sidecars ? play.sidecars.length : 0) + ':' + subsChoice() + ':' + (play.audioIndex || 0) + ':' + (duration > 0 ? 1 : 0);
    if (tracksKey !== lastTracksKey) {
      lastTracksKey = tracksKey;
      paintTrackToggles();
    }
    if (isPaused) $('osd-play').classList.add('is-paused');
    else $('osd-play').classList.remove('is-paused');
    $('osd-next').hidden = play.mode === 'single' && !(play.nextQueue && play.nextQueue[0]);
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
  function playFailed() { return !!(play && (play.errorOn || mediaState === 'error')); }
  function rememberShow() {
    if (!play || !play.item || !play.channel) return;
    var channelId = play.channel.id;
    var last = showStack.length ? showStack[showStack.length - 1] : null;
    if (last && last.item && last.item.src === play.item.src && last.channelId === channelId) return;
    showStack.push({ channelId: channelId, item: play.item, time: typeof play.showTime === 'number' ? play.showTime : (play.item.resume || 0) });
    if (showStack.length > 30) showStack.shift();
    var snap = snapshotPlaying();
    // A title that failed to play is no place to go back to: Back during the error's move to the next title
    // would retune the failure (16 Nov 2026: two TNG episodes failing in turn, Back retuned the broken one).
    if (snap && watchBack && !playFailed()) {
      watchBack.leave(profileId, snap, Date.now());
      persistBack();
      paintBackChip();
      warmMedia(snap.src);
    }
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
  var avSubCues = null, avSubKey = '', avSubReq = 0, lastPaintedSub = '';
  function paintAvSub(text) {
    var box = $('av-subs'), span;
    if (!box) return;
    text = String(text || '');
    if (text === lastPaintedSub) return;
    lastPaintedSub = text;
    if (!text) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = '';
    span = document.createElement('span');
    span.textContent = text;
    box.appendChild(span);
    box.hidden = false;
  }
  function clearAvSubs() {
    avSubReq += 1;
    avSubCues = null;
    avSubKey = '';
    paintAvSub('');
  }
  function loadAvSidecarVtt(src, name) {
    var wantedKey = src + '\n' + name, reqId;
    if (avSubKey === wantedKey && avSubCues) {
      if (window.ontoPlayerExtras && window.ontoPlayerExtras.activeCue) {
        paintAvSub(window.ontoPlayerExtras.activeCue(avSubCues, media.time()));
      }
      return;
    }
    avSubKey = wantedKey;
    avSubCues = null;
    paintAvSub('');
    reqId = ++avSubReq;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', subsUrl(src, name), true);
    if (TOKEN) xhr.setRequestHeader('X-Onto-Token', TOKEN);
    xhr.onload = function () {
      if (reqId !== avSubReq || !play || !play.item || play.item.src !== src) return;
      if (xhr.status === 200 && window.ontoPlayerExtras && window.ontoPlayerExtras.parseVtt) {
        avSubCues = window.ontoPlayerExtras.parseVtt(xhr.responseText || '');
        paintAvSub(window.ontoPlayerExtras.activeCue(avSubCues, media.time()));
      }
    };
    xhr.onerror = function () { if (reqId === avSubReq) avSubKey = ''; };
    try { xhr.send(); } catch (e) { avSubKey = ''; }
  }
  function applySavedSubs() {
    if (!media.selectText) return;
    var choice = resolveSubs(subsChoice());
    if (media.engine === 'avplay') {
      if (choice.indexOf('track:') === 0) {
        clearAvSubs();
        media.selectText(Number(choice.slice(6)));
        return;
      }
      if (choice.indexOf('file:') === 0 && play && play.item && play.item.src) {
        media.selectText(-1);
        loadAvSidecarVtt(play.item.src, choice.slice(5));
        return;
      }
      clearAvSubs();
      media.selectText(-1);
      return;
    }
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
  function applySeek(target, keepBurst) {
    pendingTapSeek = null;
    seekPreview = null;
    if (seekCtrl && !keepBurst) seekCtrl.clear();
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
  var sweepRepeats = 0;
  function stepSweep() {
    if (!play || !seekCtrl || !sweepDir) return;
    applySeek(seekCtrl.hold(media.time(), durationNow(), sweepDir, sweepRepeats), true);
    sweepRepeats += 1;
  }
  function holdSeek(key) {
    clearInterval(sweepTimer);
    sweepDir = key === 'left' ? -1 : 1;
    sweepRepeats = 0;
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
        } else if (action.key === 'up' || action.key === 'down') {
          if (play && play.mode === 'tube' && window.ontoTube) { if (action.key === 'up') window.ontoTube.onUp(); else window.ontoTube.onDown(); }
          else showOsd();
        }
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
    if (code === KEY.UP) return 'up';
    if (code === KEY.DOWN) return 'down';
    if (code === KEY.ENTER || code === KEY.PLAYPAUSE || code === KEY.SPACE) return 'ok';
    if (code === KEY.PLAY) return 'play';
    if (KEY.SUBT && code === KEY.SUBT) return 'subt';
    return '';
  }
  function optionRows() { return document.querySelectorAll('#options .opt'); }
  function activateOption(index) {
    var button = optionRows()[index];
    if (button && button.getAttribute('data-opt') === 'library') {
      closeOptions();
      if (!media.paused()) media.pause();
      if (window.ontoLibrary) window.ontoLibrary.open({ from: 'player' });
      return;
    }
    if (index === 0) cycleSubs();
    else if (index === 1) cycleAudio();
    else cycleAds();
  }
  function handleOptionKey(name) {
    var last = optionRows().length - 1;
    if (last < 0) last = 0;
    if (name === 'up') optionRow = Math.max(0, optionRow - 1);
    else if (name === 'down') optionRow = Math.min(last, optionRow + 1);
    else if (name === 'ok') activateOption(optionRow);
    else if (name === 'subt') { optionRow = 0; cycleSubs(); }
    else return;
    paintOptions();
  }
  function load(item, restoring) {
    var i;
    resetTapSeek();
    if (!restoring) rememberShow();
    watchSession = 'tv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    watchSequence = 0;
    watchTracker = window.ontoWatchTracker ? window.ontoWatchTracker() : null;
    play.item = item;
    loadLike(item);
    directionsShown = null;
    setTimeout(function () { if (play && play.item === item && !item.directions) fetchDirections(null); }, 2500);
    play.switching = false;
    if (osd) osd.classList.remove('is-skipping');
    play.visitStart = item.resume || 0;
    play.lastSave = Date.now();
    play.started = false;
    play.pictureTold = false;
    play.firstTime = null;
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
    pendingTapSeek = null;
    lastTracksKey = '';
    clearAvSubs();
    scrub = null;
    $('player').classList.remove('is-seeking');
    if (overlayFocus === 'seek') overlayFocus = '';
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
    if (play.mode === 'tube' && window.ontoTube) window.ontoTube.onPlayStart();
    closeContinue();
    dismissArm();
    noteCurrent();
    schedulePrefetch();
    paintBackChip();
    if (!restoring && !play.direct && window.ontoPlayerExtras && window.ontoPlayerExtras.resumeOffer(item.resume || 0)) {
      // The choice is made on this page, so the Mac app shows it now.
      tellDesktop('onto:desktop-playing');
      showResumePrompt(item);
      return;
    }
    // The Mac app keeps the channel's card up until there is a picture: "loading" says the server
    // answered, "playing" (from the time handler) that the picture is running.
    tellDesktop('onto:desktop-loading');
    startQueued(item);
  }
  function startQueued(item) {
    var i, preroll = [];
    play.resumePending = false;
    play.errorOn = false;
    hideResume();
    hideError();
    mediaState = 'loading'; lastProgressAt = 0; previousMediaTime = item.resume || 0;
    syncScreenSaver();
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
    if (!play || !play.item || play.resumePending || play.errorOn || play.airing !== 'show') return;
    if (play.mode === 'tube') { if (window.ontoTube) window.ontoTube.onTime(); return; }
    if (!upNextCard) return;
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
    // A failed first tune has no episode yet, and Retry still tunes the channel.
    if (!play || (!play.item && !(play.errorKind === 'tune' && play.channel))) return;
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

  function startTube(card, fromEnd) {
    if (!card || !card.src) return;
    if (window.ontoTube) window.ontoTube.remember(card.src);
    if (play && play.item && play.item.src !== card.src && !fromEnd) {
      watchEvent('stop');
      saveProgress(false);
    }
    play = { mode: 'tube', channel: null, direct: true };
    load({
      src: card.src,
      title: card.title || card.src,
      show: card.creator || card.show || '',
      duration: card.duration || 0,
      resume: card.resume || 0,
      queue: [{ kind: 'show', src: card.src, breaks: [] }]
    });
  }

  function nextBody(channel, fromItem, reason) {
    var body = { channel: channel.id };
    var viewers = storedViewers(), rating = storedRating();
    if (viewers !== null) body.viewers = viewers;
    if (rating) body.rating = rating;
    if (fromItem) {
      body.current = fromItem.src;
      body.reason = reason;
      body.time = Math.floor(playbackPosition());
      body.watched = Math.floor(Math.max(0, play && play.watchedSeconds || 0));
      body.duration = Math.floor(fromItem.duration || (play && play.airing === 'show' ? media.duration() : 0) || 0);
    }
    return body;
  }
  function beginShown(channel, item) {
    var previousId = play && play.channel ? play.channel.id : '';
    if (play && play.item && play.channel !== channel) watchEvent('stop');
    if (play && play.item && play.channel && play.channel.id !== channel.id) rememberShow();
    if (!previousId || previousId !== channel.id) showTuning(channel);
    play = play && play.channel === channel ? play : { mode: 'channel', channel: channel, nextQueue: keptQueue() };
    paintChannel(channel);
    if (item && item.src) { paintOsdLabels(item); showOsd(); }
    load(item);
  }
  function peekNextForChannel(channel) {
    var queued = play && play.nextQueue && play.nextQueue[0];
    if (queued) {
      return { src: queued.src, show: queued.show || queued.title, title: queued.title, display: queued.display };
    }
    if (!channel) return null;
    var known = channelPrefetch[channel.id];
    // The prefetch for the channel being watched names what is on it now, not what a skip brings.
    if (known && known.item && known.item.src && Date.now() - known.at < 20000 &&
      !(play && play.item && known.item.src === play.item.src)) return known.item;
    return null;
  }
  function showSkipping(preview) {
    if (play) play.switching = true;
    try { media.stop(); } catch (e) {}
    if (osd) osd.classList.add('is-skipping');
    $('osd-fill').style.width = '0';
    $('osd-elapsed').textContent = clock(0);
    if (preview) paintOsdLabels(preview);
    else { $('osd-show').textContent = ''; $('osd-episode').textContent = ''; }
    showOsd();
  }
  function startChannel(channel, fromItem, reason) {
    var request = ++tuneRequest;
    var previousId = play && play.channel ? play.channel.id : '';
    dismissArm();
    if (play && play.item && (!fromItem || play.channel !== channel)) watchEvent('stop');
    if (play && play.item && play.channel && play.channel.id !== channel.id) rememberShow();
    if (!previousId || previousId !== channel.id) showTuning(channel);
    play = play && play.channel === channel ? play : { mode: 'channel', channel: channel, nextQueue: keptQueue() };
    paintChannel(channel);
    // A skip must be felt at once: the old item stops (sound cuts) and the bar resets in the same frame as the
    // press, before the server is asked what is next.
    if ((reason === 'skip' || reason === 'error') && previousId === channel.id) showSkipping(peekNextForChannel(channel));
    var body = nextBody(channel, fromItem, reason);
    return post('/api/next', body).then(function (item) {
      if (request !== tuneRequest) return;
      if (item && item.src) paintOsdLabels(item);
      load(item);
    }).catch(function (error) { if (request !== tuneRequest) return; if (play) { if (!play.item) { tellDesktop('onto:desktop-error', error && error.status); showTuneTrouble(); } showStreamError('tune'); return; } stopPlayback(); fail(error); });
  }

  // What is queued to play next carries over to another channel, except the rest of a show found by name
  // in the Mac app: that run belongs to the show, and a channel moves on by its own picks.
  function keptQueue() {
    var queue = (play && play.nextQueue) || [], kept = [], i;
    for (i = 0; i < queue.length; i++) if (!queue[i].run) kept.push(queue[i]);
    return kept;
  }
  // A first tune that fails has nothing on screen yet: until 15 Nov 2026 the home screen simply sat there
  // while the retry counted down out of sight. The player comes up with the channel and the retry line.
  function showTuneTrouble() {
    $('home').hidden = true;
    $('player').hidden = false;
    document.body.classList.add('playing');
    hideTuning();
  }
  function saveProgress(completed) {
    if (!play || !play.item || play.airing === 'ad') return;
    play.lastSave = Date.now();
    post('/api/progress', { src: play.item.src, positionSeconds: completed ? 0 : playbackPosition(),
      durationSeconds: play.item.duration || media.duration(), completed: !!completed }).catch(function () {});
    reportNow();
  }
  function reportNow() {
    clearTimeout(reportNowTimer);
    reportNowTimer = 0;
    if (!TOKEN) return;
    var body, channel;
    if (!play || !play.item || $('player').hidden) body = { src: null, position: 0, channel: null, profile: profileId };
    else {
      channel = play.channel || {};
      body = {
        src: play.item.src,
        position: Math.round(playbackPosition() || 0),
        channel: { id: channel.id || '', number: typeof channel.number === 'number' ? channel.number : null, name: channel.name || '' },
        profile: profileId
      };
    }
    post('/api/now-playing', body).catch(function () {});
  }
  function reportNowSoon() {
    clearTimeout(reportNowTimer);
    reportNowTimer = setTimeout(function () { reportNowTimer = 0; reportNow(); }, 500);
  }

  function next(reason) {
    if (!play) return;
    var current = play.item;
    var queued = play.nextQueue && play.nextQueue[0];
    watchEvent(reason === 'ended' ? 'ended' : 'skip');
    saveProgress(reason === 'ended');
    if (play.mode === 'tube') { if (window.ontoTube) window.ontoTube.advance(); return; }
    if (queued) {
      showSkipping({ src: queued.src, show: queued.show || queued.title, title: queued.title || basename(queued.src) });
      playResume({
        src: queued.src, title: queued.title || basename(queued.src), show: queued.title || basename(queued.src),
        art: '/art?src=' + q(queued.src), positionSeconds: 0, queued: true,
        channel: play.channel, mode: play.mode || 'channel'
      });
      return;
    }
    if (play.mode === 'channel') return startChannel(play.channel, current, reason);
    stopPlayback();
  }

  function afterNextPaint(fn, fallbackMs) {
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    // Two frames: the first paints the UI change, and the heavy AVPlay bridge call lands after it (one frame
    // would let it run before the press's own next-frame mark, which is what the TV's key telemetry reports).
    // A hidden page gets no frames: run at once, and always arm a timer fallback.
    var done = false;
    function go() { if (done) return; done = true; fn(); }
    if (document.hidden) { go(); return; }
    raf(function () { raf(function () { setTimeout(go, 0); }); });
    setTimeout(go, fallbackMs || 250);
  }
  function stopAfterPaint() {
    afterNextPaint(function () { if (!play) media.stop(); }, 250);
  }
  function stopPlayback() {
    resetPressedKeys();
    resetTapSeek();
    clearTimeout(osdTimer);
    osdTimer = 0;
    overlayFocus = '';
    transportIndex = 1;
    continueIndex = 0;
    clearTransportFocus();
    clearContinueFocus();
    clearScrubFocus();
    osd.classList.add('hidden');
    tuneRequest++;
    dismissArm();
    closeContinue();
    noteCurrent();
    hideTuning();
    clearTimeout(navTimer);
    clearTimeout(stripTimer);
    clearTimeout(upNextTimer);
    clearTimeout(errorTimer);
    clearInterval(sweepTimer);
    seekPreview = null;
    pendingTapSeek = null;
    lastTracksKey = '';
    clearAvSubs();
    scrub = null;
    $('player').classList.remove('is-seeking');
    if (overlayFocus === 'seek') overlayFocus = '';
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
    if (window.ontoTube) window.ontoTube.onStop();
    tellDesktop('onto:desktop-home');
    // Tuned elsewhere while watching: Back lands on the channel that was on.
    if (homeReturn && play && play.channel && play.channel.id && /^ch:/.test(homeReturn.id)) homeReturn.id = 'ch:' + play.channel.id;
    play = null; mediaState = 'ready';
    syncScreenSaver();
    // The home screen paints first and the player is told after: AVPlay's stop and close are synchronous and
    // slow on the TV (Back took 190-240 ms at p50 and up to 2 s, remote-events.jsonl 14-21 Nov 2026, against
    // 14 ms for a home move). With 'playing' gone the page is opaque, so the picture is already hidden.
    stopAfterPaint();
    reportNow();
    document.body.classList.remove('playing');
    $('player').hidden = true;
    $('home').hidden = false;
    if (homeReturn) homeReturn.pending = true;
    loadHome();
    if (window.ontoLibrary && window.ontoLibrary.resume()) return;
  }

  // Pause and play answer in the frame of the press: the button and bar repaint first, and the player (whose pause
  // call took 700 ms on the TV, 14 Nov 2026) is told after the frame has painted. Returns whether the picture is now paused.
  var pendingPause = null;
  function pausedNow() { return pendingPause === null ? media.paused() : pendingPause; }
  function togglePause() {
    var willPause = !pausedNow();
    pendingPause = willPause;
    $('osd-play').classList.toggle('is-paused', willPause);
    $('osd-play').setAttribute('aria-label', willPause ? 'Play' : 'Pause');
    showOsd();
    syncScreenSaver();
    afterNextPaint(function () {
      var want = pendingPause;
      pendingPause = null;
      if (!play || want === null) return;
      if (want !== media.paused()) { if (want) media.pause(); else { media.play(); watchEvent('resume'); } }
      syncScreenSaver();
      updateOsd();
      showOsd();
      reportNowSoon();
    }, 250);
    return willPause;
  }

  media.on('subtitle', function () {
    if (media.engine !== 'avplay' || !play || play.airing !== 'show') return;
    var choice = resolveSubs(subsChoice());
    if (choice.indexOf('track:') === 0) paintAvSub(media.subtitle ? media.subtitle() : '');
  });
  media.on('time', function () {
    // The picture is running once the clock has moved (a resumed episode starts with its clock already
    // at its place, so one reading is not enough).
    if (play && !play.pictureTold) {
      if (play.firstTime === null || play.firstTime === undefined) play.firstTime = media.time();
      else if (media.time() > play.firstTime + 0.05) { play.pictureTold = true; tellDesktop('onto:desktop-playing'); }
    }
    if (play && play.resumePending) return;
    if (play && play.airing === 'show') followSegments();
    if (play && play.airing === 'show') considerUpNext();
    if (media.engine === 'avplay' && avSubCues && play && play.airing === 'show' && window.ontoPlayerExtras && window.ontoPlayerExtras.activeCue) {
      paintAvSub(window.ontoPlayerExtras.activeCue(avSubCues, media.time()));
    }
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
    if (play && play.mode === 'tube') { if (window.ontoTube) window.ontoTube.onEnded(); return; }
    if (upNextCard && upNextCard.active()) return;
    if (play && play.upNextDismissed) { showOsd(); return; }
    if (play && window.ontoPlayerExtras && window.ontoPlayerExtras.isSerial(play.item)) { considerUpNext(); return; }
    next('ended');
  });
  media.on('error', function () {
    if (play && play.switching) return;
    if (!play) return;
    if (play.airing === 'ad') return advanceAd();
    mediaState = 'error';
    syncScreenSaver();
    diag('play_error', { page: 'player', engine: media.engine || 'video', state: 'error', errorCode: 'media' });
    watchEvent('error');
    // Stay on the channel. Retry reloads this file; after 5 s the channel moves on.
    if (!play.pictureTold) tellDesktop('onto:desktop-error', -1);
    showStreamError('media');
  });
  media.on('pause', function () { if (play && play.switching) return; mediaState = media.paused() ? 'paused' : 'loading'; if (media.paused()) { watchEvent('pause'); diag('pause', diagnosticSample()); } updateOsd(); showOsd(); });
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
    if (GUEST && guestEntry) { history.back(); return; }
    undoOrHome();
  }
  $('osd-back').addEventListener('click', guestBack);
  if ($('back-chip')) $('back-chip').addEventListener('click', undoOrHome);
  if ($('channel-preview')) $('channel-preview').addEventListener('click', function () {
    var decision = channelArm ? channelArm.ok() : null;
    if (decision && decision.type === 'commit') commitChannel(decision.target);
  });
  window.addEventListener('popstate', function () {
    if (!GUEST) return;
    guestEntry = false;
    if (!$('player').hidden) stopPlayback();
  });
  $('osd-play').addEventListener('click', togglePause);
  $('osd-prev-scene').addEventListener('click', function () { previousShow(); });
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
        activateOption(index);
        if (optionButtons[index].getAttribute('data-opt') !== 'library') paintOptions();
      });
    })(optionIndex);
  }
  window.addEventListener('pagehide', function () { if (play) watchEvent('stop'); });
  document.addEventListener('visibilitychange', function () { if (!play) return; watchEvent(document.hidden || media.paused() ? 'pause' : 'resume'); });

  function basename(src) {
    var parts = String(src || '').split('/');
    return parts.length ? parts[parts.length - 1] : '';
  }
  function playRemote(command) {
    var position = command.positionSeconds, list, i;
    if (position == null && watchBack) {
      list = watchBack.continueList(profileId);
      for (i = 0; i < list.length; i++) if (list[i].src === command.src) { position = list[i].positionSeconds; break; }
    }
    if (typeof position !== 'number' || position !== position || position < 0) position = 0;
    dismissArm();
    closeContinue();
    if (window.ontoGames && window.ontoGames.isOpen && window.ontoGames.isOpen() && window.ontoGames.close) window.ontoGames.close();
    if (window.ontoLibrary && window.ontoLibrary.abandon) window.ontoLibrary.abandon();
    if (play && play.item) rememberShow();
    tuneRequest++;
    var channel = { id: 'continue', number: '', name: '' };
    var queue = play && play.nextQueue ? play.nextQueue.slice() : [];
    showTuning(channel);
    play = { mode: 'single', channel: channel, nextQueue: queue };
    paintChannel(channel);
    load({
      src: command.src,
      title: basename(command.src),
      show: basename(command.src),
      art: '/art?src=' + q(command.src),
      resume: position,
      duration: 0,
      queue: [{ kind: 'show', src: command.src, breaks: [] }]
    }, true);
    showOsd();
  }
  function channelFromCommand(command) {
    var list = data.channels || [], i, want = command && command.channel;
    for (i = 0; i < list.length; i++) {
      if (list[i].app) continue;
      if (typeof want === 'number' && list[i].number === want) return list[i];
      if (String(list[i].id) === String(want) || String(list[i].number) === String(want)) return list[i];
    }
    return null;
  }
  window.ontoTVAction = function (action, command) {
    var channel;
    if (action === 'play') {
      if (!command || typeof command.src !== 'string' || !command.src || command.src.indexOf('..') >= 0) return Promise.reject(new Error('no src'));
      playRemote(command);
      return null;
    }
    if (action === 'queue-next') {
      if (!command || typeof command.src !== 'string' || !command.src || command.src.indexOf('..') >= 0) return Promise.reject(new Error('no src'));
      if (!play || $('player').hidden) { playRemote(command); return null; }
      play.nextQueue = play.nextQueue || [];
      play.nextQueue.push({ src: command.src, title: basename(command.src) });
      showOsd();
      return null;
    }
    if (action === 'pause') { if (play) media.pause(); showOsd(); reportNow(); return null; }
    if (action === 'resume') { if (play) { media.play(); watchEvent('resume'); } showOsd(); reportNow(); return null; }
    if (action === 'seek') {
      if (!play || !command || typeof command.seconds !== 'number') return Promise.reject(new Error('no seek'));
      applySeek(command.seconds);
      reportNow();
      return null;
    }
    if (action === 'home') { if (window.ontoHome) window.ontoHome(); else stopPlayback(); return null; }
    // Reload: pick up a new interface from the server. What is on comes back where it was.
    if (action === 'reload') {
      try {
        if (play && play.item && play.item.src && !$('player').hidden) {
          window.localStorage.setItem('onto.reload.resume', JSON.stringify({ src: play.item.src, positionSeconds: Math.max(0, Math.floor(media.time()) - 2), at: Date.now() }));
        }
      } catch (e) {}
      if (play && play.item) saveProgress(false);
      setTimeout(function () { location.reload(); }, 400);
      return null;
    }
    if (action === 'tune') {
      channel = channelFromCommand(command);
      if (!channel) return Promise.reject(new Error('no channel'));
      if ($('player').hidden) activate(channel);
      else commitChannel(channel);
      return null;
    }
    if (action === 'back') { backOneStep(); return null; }
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
      if (!$('player').hidden && play && !cards[i].app) { armChannel(cards[i]); return true; }
      if (play && !cards[i].app) saveProgress(false);
      activate(cards[i]);
      return true;
    }
    return false;
  }
  // The channel one step up or down. Steps from the channel whose card is showing (so Up, Up goes two channels,
  // not back again) and passes over tiles that are not channels (Games, Console).
  function channelByStep(direction) {
    var list = (data.channels || []).slice().sort(function (a, b) { return a.number - b.number; });
    if (!play || !play.channel || list.length < 2) return null;
    var from = (channelArm && channelArm.target && channelArm.target()) || play.channel;
    var index = -1, i, tries;
    for (i = 0; i < list.length; i++) if (list[i].id === from.id) index = i;
    if (index < 0) return null;
    for (tries = 0; tries < list.length; tries++) {
      index = (index + direction + list.length) % list.length;
      if (!list[index].app) return list[index];
    }
    return null;
  }
  function stepChannel(direction) {
    var target = channelByStep(direction);
    if (!target) { showOsd(); return; }
    armChannel(target);
  }

  function persistBack() {
    if (!watchBack) return;
    try { localStorage.setItem('onto.back.v1', JSON.stringify(watchBack.save())); } catch (e) {}
  }
  function snapshotPlaying() {
    if (!play || !play.item || play.airing === 'ad') return null;
    var item = play.item;
    var channel = play.channel || { id: '', number: '', name: '' };
    var shown = item.display || {};
    return {
      src: item.src,
      title: shown.episode || item.title || item.show || '',
      show: shown.show || item.show || item.title || '',
      art: item.art || (channel.now && channel.now.art) || ('/art?src=' + q(item.src)),
      positionSeconds: playbackPosition(),
      duration: item.duration || (media && media.duration ? media.duration() : 0) || 0,
      channel: { id: channel.id || '', number: channel.number, name: channel.name || '' },
      mode: play.mode || 'channel'
    };
  }
  function noteCurrent() {
    if (playFailed()) return;   // nor a title to continue
    var snap = snapshotPlaying();
    if (!snap || !watchBack) return;
    watchBack.note(profileId, snap);
    persistBack();
  }
  function warmMedia(src) {
    if (!src) return;
    try { var img = new Image(); img.src = artUrl('/art?src=' + q(src)); } catch (e) {}
    try { fetch(fileUrl('media', src), { headers: { Range: 'bytes=0-1023' } }).catch(function () {}); } catch (e2) {}
  }
  function warmChannel(channel) {
    if (!channel || channel.app) return;
    var known = channelPrefetch[channel.id];
    if (known && known.item && known.item.src && Date.now() - known.at < 20000) return;
    var body = nextBody(channel);
    body.prefetch = true;
    post('/api/next', body).then(function (item) {
      if (item && item.src) channelPrefetch[channel.id] = { at: Date.now(), item: item };
    }).catch(function () {});
  }
  function schedulePrefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(function () {
      if ($('player').hidden || !play || !play.channel) return;
      warmChannel(play.channel);
      warmChannel(channelByStep(1));
      warmChannel(channelByStep(-1));
    }, 500);
  }
  function resumeButton(entry) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'resume';
    button.tabIndex = -1;
    button._entry = entry;
    var name = (entry.direction || entry.liked) ? (entry.title || entry.show || '') : (entry.show || entry.title || '');
    var place = entry.direction ? entry.label : entry.liked ? ('\u2665 ' + (entry.show || '')) : entry.queued ? 'next' : ('resume ' + clock(entry.positionSeconds || 0));
    if (entry.direction === 'wait') button.className = 'resume direction loading';
    else if (entry.direction) button.className = 'resume direction';
    if (entry.liked) button.className = 'resume liked';
    button.setAttribute('aria-label', entry.direction ? (place + ': ' + name) : entry.liked ? ('Liked: ' + name) : ('Continue ' + name + ' ' + place));
    button.title = name;
    var bezel = document.createElement('span');
    bezel.className = 'bezel';
    var img = document.createElement('img');
    img.className = 'art';
    img.alt = '';
    bezel.appendChild(img);
    var art = entry.art || (entry.src ? '/art?src=' + q(entry.src) : '');
    if (art) loadArt(img, artUrl(art));
    var copy = document.createElement('span');
    copy.className = 'resume-copy';
    var title = document.createElement('span');
    title.className = 'resume-title';
    title.textContent = name;
    var at = document.createElement('span');
    at.className = 'resume-at';
    at.textContent = place;
    if (entry.direction) { copy.appendChild(at); copy.appendChild(title); }
    else { copy.appendChild(title); copy.appendChild(at); }
    bezel.appendChild(copy);
    button.appendChild(bezel);
    button.addEventListener('click', function () { playResume(entry); });
    return button;
  }
  function paintResumeInto(holder, entries) {
    if (!holder) return [];
    holder.innerHTML = '';
    var els = [], frag = document.createDocumentFragment(), i, button;
    for (i = 0; i < entries.length; i++) {
      button = resumeButton(entries[i]);
      frag.appendChild(button);
      els.push(button);
    }
    holder.appendChild(frag);
    return els;
  }
  function resumeEntries() {
    var list = watchBack ? watchBack.continueList(profileId).slice(0) : [];
    return list;
  }
  function queuedEntries() {
    var queue = play && play.nextQueue || [], list = [], i, item;
    for (i = 0; i < queue.length; i++) {
      item = queue[i];
      if (!item || !item.src) continue;
      list.push({
        src: item.src, title: item.title || basename(item.src), show: item.title || basename(item.src),
        art: '/art?src=' + q(item.src), positionSeconds: 0, duration: 0, queued: true,
        channel: (play && play.channel) || { id: 'next', number: '', name: '' }, mode: (play && play.mode) || 'single'
      });
    }
    return list;
  }
  function continueEntries() { return resumeEntries().concat(queuedEntries()); }
  // A tile's channel as this audience sees it (the home screen numbers channels per audience).
  function channelView(channel) {
    var list = (data && data.channels) || [], i;
    if (!channel) return { id: 'continue', number: '', name: '' };
    for (i = 0; i < list.length; i++) if (list[i].id === channel.id) return { id: list[i].id, number: list[i].number, name: list[i].name };
    return channel;
  }
  // What was liked, after what is half-watched, in the same row: the way back to "that one".
  function likedEntries(skip) {
    var list = (data && data.liked) || [], out = [], i, item;
    for (i = 0; i < list.length; i++) {
      item = list[i];
      if (!item || !item.src || skip[item.src]) continue;
      out.push({ liked: true, src: item.src, title: (item.display && item.display.episode) || item.title, show: (item.display && item.display.show) || item.show, art: '/art?src=' + q(item.src),
        positionSeconds: item.resume || 0, duration: item.duration || 0, channel: channelView(item.channel), mode: 'channel' });
    }
    return out;
  }
  function paintResumeRow() {
    var holder = $('resume-row');
    var entries = resumeEntries(), have = {}, r;
    for (r = 0; r < entries.length; r++) have[entries[r].src] = true;
    if (!GUEST) entries = entries.concat(likedEntries(have));
    if (!holder) return [];
    if (!entries.length) { holder.hidden = true; holder.innerHTML = ''; return []; }
    holder.hidden = false;
    return paintResumeInto(holder, entries);
  }
  function scrollContinueTo(index) {
    var strip = $('continue-strip'), els = strip ? strip.children : [];
    if (!strip || !els.length || !els[index]) return;
    if (index === 0 && strip.scrollLeft === 0) return;
    var tile = els[index].getBoundingClientRect(), view = strip.getBoundingClientRect();
    if (tile.left < view.left + 16) strip.scrollLeft -= view.left + 16 - tile.left;
    if (tile.right > view.right - 16) strip.scrollLeft += tile.right - view.right + 16;
  }
  function directionTileFromOffer(tile) {
    return { direction: tile.kind, label: tile.label, src: tile.src, title: tile.title, show: tile.show, art: '/art?src=' + q(tile.src),
      positionSeconds: tile.resume || 0, duration: tile.duration || 0, channel: channelView(tile.channel), mode: 'channel' };
  }
  function appendResumeTiles(holder, entries) {
    var els = [], frag = document.createDocumentFragment(), i, button;
    if (!holder) return els;
    for (i = 0; i < entries.length; i++) {
      button = resumeButton(entries[i]);
      frag.appendChild(button);
      els.push(button);
    }
    holder.appendChild(frag);
    return els;
  }
  function directionPlaceholder() {
    return { direction: 'wait', label: '\u2026', title: '', show: '', src: '', art: '', positionSeconds: 0, duration: 0, channel: { id: '', number: '', name: '' }, mode: 'channel' };
  }
  function ensureDirectionPlaceholder(holder) {
    var last = holder && holder.lastElementChild, entry;
    if (last && last._entry && last._entry.direction === 'wait') return last;
    entry = directionPlaceholder();
    return resumeButton(entry);
  }
  function removeDirectionPlaceholder(holder) {
    var last = holder && holder.lastElementChild;
    if (last && last._entry && last._entry.direction === 'wait') holder.removeChild(last);
  }
  function maybeFetchMoreDirections() {
    var shown = directionsShown, holder = $('continue-strip'), body, ph;
    if (!shown || !holder || GUEST || shown.fetching) return;
    if (shown.next === null || shown.next === undefined) return;
    if (continueIndex < holder.children.length - 4) return;
    shown.fetching = true;
    if (continueIndex >= holder.children.length - 1) {
      ph = ensureDirectionPlaceholder(holder);
      if (ph.parentNode !== holder) holder.appendChild(ph);
    }
    body = directionsBody();
    body.offset = shown.next;
    body.limit = 12;
    post('/api/directions', body).then(function (offer) {
      shown.fetching = false;
      removeDirectionPlaceholder(holder);
      if (!directionsShown || directionsShown !== shown || !play || overlayFocus !== 'continue') return;
      if (!offer || !offer.tiles || !offer.tiles.length) return;
      var entries = [], i;
      for (i = 0; i < offer.tiles.length; i++) entries.push(directionTileFromOffer(offer.tiles[i]));
      appendResumeTiles(holder, entries);
      shown.tiles = shown.tiles.concat(entries);
      shown.next = offer.next;
      if (continueIndex >= holder.children.length - 4) maybeFetchMoreDirections();
    }).catch(function () { if (directionsShown === shown) shown.fetching = false; removeDirectionPlaceholder(holder); });
  }
  function focusContinue(index) {
    var els = $('continue-strip') ? $('continue-strip').children : [];
    if (!els.length) return;
    if (directionsShown && index < 0) return;
    if (index < 0) index = 0;
    if (index >= els.length) index = els.length - 1;
    continueIndex = index;
    var i;
    for (i = 0; i < els.length; i++) els[i].classList.toggle('focused', i === index);
    try { els[index].focus(); } catch (e) {}
    scrollContinueTo(index);
    if (directionsShown) maybeFetchMoreDirections();
    // The focused direction's whole title, which a tile may not have room for.
    var caption = $('direction-caption'), entry = els[index]._entry;
    if (caption) {
      if (entry && entry.direction && entry.direction !== 'wait') { caption.textContent = entry.title || ''; caption.hidden = false; if (directionsShown) directionsShown.touched = Date.now(); }
      else if (entry && entry.direction === 'wait') caption.hidden = true;
      else caption.hidden = true;
    }
  }
  // ---------- directions (Down while watching) ----------
  // Tiles of where the channel could go next, one real episode each. The offer is fetched a moment after an
  // episode starts so the tray opens in the same frame as the press; what was offered and what was chosen
  // (or that it was closed) is sent to the server for the taste work.
  function directionsBody() {
    var body = { channel: play && play.channel ? String(play.channel.id) : '', current: play.item.src };
    var viewers = storedViewers(), rating = storedRating();
    if (viewers !== null) body.viewers = viewers;
    if (rating) body.rating = rating;
    return body;
  }
  function fetchDirections(then, offset) {
    var item = play && play.item, body;
    if (!item || !item.src || GUEST || inAd()) { if (then) then(null); return; }
    body = directionsBody();
    body.offset = offset || 0;
    body.limit = 12;
    post('/api/directions', body).then(function (offer) {
      if (!play || play.item !== item) return;
      if (offer && offer.tiles && offer.tiles.length && (!offset || offset === 0)) {
        item.directions = { at: Date.now(), tiles: offer.tiles, next: offer.next === undefined ? null : offer.next };
      }
      if (then) then(offer && offer.tiles && offer.tiles.length ? offer : (item.directions || null));
    }).catch(function () { if (then && play && play.item === item) then(item.directions || null); });
  }
  function paintDirections(offer) {
    var holder = $('continue-strip'), entries = [], i, tile;
    if (!holder || !offer || !offer.tiles.length || !play || !play.item || overlayFocus === 'seek') return;
    for (i = 0; i < offer.tiles.length; i++) entries.push(directionTileFromOffer(offer.tiles[i]));
    dismissArm();
    if (optionOpen) closeOptions();
    if (directionsShown) directionsShown = null;
    closeContinue();
    clearTransportFocus();
    overlayFocus = 'continue';
    continueOpen = true;
    holder.scrollLeft = 0;
    paintResumeInto(holder, entries);
    holder.hidden = false;
    holder.classList.add('directions-open');
    directionsShown = { openedAt: Date.now(), touched: Date.now(), from: play.item.src, position: Math.floor(media.time()),
      channel: play.channel ? String(play.channel.id) : '', tiles: entries, next: offer.next === undefined ? null : offer.next, fetching: false };
    focusContinue(0);
    showOsd();
  }
  function openDirections() {
    var item = play && play.item;
    if (!item || GUEST || inAd() || play.resumePending || play.errorOn) { showOsd(); return; }
    showOsd();
    if (item.directions) { paintDirections(item.directions); if (Date.now() - item.directions.at > 300000) fetchDirections(null); return; }
    fetchDirections(function (offer) { if (offer && !overlayFocus && !optionOpen) paintDirections(offer); });
  }
  function sendDirection(entry) {
    var shown = directionsShown, body, i, viewers;
    directionsShown = null;
    if (!shown || !TOKEN) return;
    body = { channel: shown.channel, from: shown.from, position: shown.position, msOpen: Date.now() - shown.openedAt, shown: [],
      chosen: entry ? { kind: entry.direction, src: entry.src } : null };
    for (i = 0; i < shown.tiles.length; i++) body.shown.push({ kind: shown.tiles[i].direction, src: shown.tiles[i].src });
    viewers = storedViewers();
    if (viewers !== null) body.viewers = viewers;
    post('/api/direction-choice', body).catch(function () {});
  }
  function closeContinue() {
    // A directions tray closed without a choice is data too.
    if (directionsShown) sendDirection(null);
    var caption = $('direction-caption'); if (caption) caption.hidden = true;
    continueOpen = false;
    var holder = $('continue-strip');
    if (holder) { holder.hidden = true; holder.innerHTML = ''; holder.scrollLeft = 0; holder.classList.remove('directions-open'); }
  }
  function toggleContinue() {
    if (continueOpen) { closeContinue(); return; }
    dismissArm();
    var holder = $('continue-strip');
    var entries = continueEntries();
    if (!holder || !entries.length) { showOsd(); return; }
    continueOpen = true;
    paintResumeInto(holder, entries);
    holder.hidden = false;
    focusContinue(0);
    showOsd();
  }
  function paintPreview(channel, ready) {
    var card = $('channel-preview');
    if (!card || !channel) return;
    card.hidden = false;
    var number = channel.number != null && channel.number !== '' ? String(channel.number) : '';
    var name = channel.name || '';
    var showName = channel.now && channel.now.show || '';
    $('channel-preview-num').textContent = number;
    $('channel-preview-name').textContent = name;
    $('channel-preview-show').textContent = showName;
    card.setAttribute('aria-label', (number ? number + ' ' : '') + name + (showName ? ' ' + showName : ''));
    var img = $('channel-preview-art');
    if (channel.now && channel.now.art) loadArt(img, artUrl(channel.now.art));
    var spin = $('channel-preview-spin');
    if (spin) spin.hidden = !!ready;
  }
  function hidePreview() {
    var card = $('channel-preview');
    if (card) card.hidden = true;
  }
  function dismissArm() {
    clearTimeout(armTimer);
    armedRequest = 0;
    if (channelArm) channelArm.cancel();
    hidePreview();
  }
  function onArmTick() {
    if (!channelArm) return;
    var decision = channelArm.tick(Date.now());
    if (decision.type === 'wait') { armTimer = setTimeout(onArmTick, Math.max(0, decision.commitAt - Date.now())); return; }
    if (decision.type === 'commit') commitChannel(decision.target);
  }
  function armChannel(channel) {
    if (!channelArm || !channel || channel.app) return;
    var decision = channelArm.press(channel, Date.now());
    if (decision.type === 'cancel') {
      clearTimeout(armTimer);
      hidePreview();
      if ($('tune-num')) $('tune-num').hidden = true;
      return;
    }
    if (decision.type !== 'preview') return;
    var request = ++tuneRequest;
    armedRequest = request;
    var known = channelPrefetch[channel.id];
    paintPreview(channel, !!(known && known.item && known.item.src));
    clearTimeout(armTimer);
    armTimer = setTimeout(onArmTick, Math.max(0, decision.commitAt - Date.now()));
    var body = nextBody(channel);
    body.prefetch = true;
    post('/api/next', body).then(function (item) {
      if (item && item.src) channelPrefetch[channel.id] = { at: Date.now(), item: item };
      if (armedRequest !== request) return;
      paintPreview(channel, true);
    }).catch(function () {});
  }
  function commitChannel(channel) {
    clearTimeout(armTimer);
    armedRequest = 0;
    hidePreview();
    if (channelArm) channelArm.cancel();
    if (!channel) return;
    var known = channelPrefetch[channel.id];
    if (known && known.item && known.item.src && Date.now() - known.at < 20000) {
      var request = ++tuneRequest;
      beginShown(channel, known.item);
      var body = nextBody(channel);
      post('/api/next', body).then(function (item) {
        if (request !== tuneRequest || !play || !play.item || !item || !item.src) return;
        if (item.src !== play.item.src || (item.queue && item.queue[0] && item.queue[0].kind === 'ad' && media.time() < 2)) load(item);
      }).catch(function () {});
      return;
    }
    startChannel(channel);
  }
  function playResume(entry) {
    if (!entry || !entry.src) return;
    closeContinue();
    dismissArm();
    var queue = play && play.nextQueue ? play.nextQueue.slice() : [];
    var channel = entry.channel || {};
    channel = { id: channel.id || 'continue', number: channel.number != null ? channel.number : '', name: channel.name || entry.show || '' };
    var item = {
      src: entry.src,
      title: entry.title || entry.show || '',
      show: entry.show || entry.title || '',
      art: entry.art || ('/art?src=' + q(entry.src)),
      resume: entry.positionSeconds || 0,
      duration: entry.duration || 0,
      queue: [{ kind: 'show', src: entry.src, breaks: [] }]
    };
    tuneRequest++;
    if (play && play.item && play.item.src !== entry.src) rememberShow();
    showTuning(channel);
    play = { mode: entry.mode || (channel.id && channel.id !== 'continue' ? 'channel' : 'single'), channel: channel, nextQueue: queue };
    if (entry.queued) {
      play.nextQueue = queue.filter(function (queued) { return queued.src !== entry.src; });
      if (TOKEN) post('/api/play-next', { src: entry.src, consume: true }).catch(function () {});
    }
    paintChannel(channel);
    load(item, true);
    warmMedia(entry.src);
  }
  function restoreEntry(entry) { playResume(entry); }
  // Remote Back: straight to the main menu from anywhere in the player. The on-screen 'Back to <show>' chip
  // (undoOrHome) is the way to return to what was on before.
  function goHome() { dismissArm(); closeContinue(); closeOverlay(); stopPlayback(); }
  // Back peels one layer (Ian, 21 Nov 2026: "back should remove the menu before it kicks you back to the main
  // menu"): controls, a tray or a menu on screen close first and the picture keeps playing; with only the
  // picture showing, Back goes to the main menu.
  function backOneStep() {
    // Only what the viewer opened is peeled (controls, the continue tray, up next): the bar that shows by
    // itself after a tune, a resume prompt or an error line does not stand between Back and the main menu.
    var errorUp = play && play.errorOn;
    if (!errorUp && (overlayFocus || continueOpen || (upNextCard && upNextCard.active()))) {
      dismissArm();
      closeContinue();
      closeOverlay();
      overlayFocus = '';
      clearTransportFocus();
      clearScrubFocus();
      clearTapSeekChrome();
      clearTimeout(osdTimer); osdTimer = 0;
      osd.classList.add('hidden');
      return;
    }
    goHome();
  }
  function undoOrHome() {
    dismissArm();
    closeContinue();
    var entry = watchBack ? watchBack.undo(profileId, Date.now()) : null;
    if (watchBack) persistBack();
    paintBackChip();
    if (entry) { restoreEntry(entry); return; }
    stopPlayback();
  }
  // The 'Back to <show>' chip is gone (Ian, 21 Nov 2026: "that massive back icon is kinda dumb"); remote Back
  // goes to the main menu and Previous / Pre-Ch return to what was on.
  function paintBackChip() {
    var chip = $('back-chip');
    if (chip) chip.hidden = true;
    return;
    // eslint-disable-next-line no-unreachable
    var entry = watchBack && $('player') && !$('player').hidden ? watchBack.chip(profileId, Date.now()) : null;
    if (!entry || !osdOpen()) { chip.hidden = true; return; }
    chip.hidden = false;
    var title = entry.show || entry.title || '';
    var label = $('back-chip-title');
    if (label) label.textContent = title;
    chip.setAttribute('aria-label', 'Back to ' + title);
    var img = $('back-chip-art');
    var art = entry.art || (entry.src ? '/art?src=' + q(entry.src) : '');
    if (img && art) loadArt(img, artUrl(art));
  }
  function showDigitHold(text) {
    var bug = $('tune-num'), digits = $('tune-digits');
    if (!bug || !digits || $('player').hidden) return;
    digits.textContent = text;
    bug.hidden = false;
  }
  // Like: the heart fills in the same frame as the press; the server is told afterwards and a failure puts it back.
  function paintLike() {
    var button = $('osd-like'), on = !!(play && play.item && play.item.liked);
    if (!button) return;
    button.hidden = !(play && play.item && play.item.src) || GUEST;
    button.classList.toggle('is-liked', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Liked' : 'Like');
    button.title = on ? 'Liked' : 'Like';
  }
  function loadLike(item) {
    paintLike();
    if (!item || !item.src || GUEST || typeof item.liked === 'boolean') return;
    api('/api/like?src=' + q(item.src)).then(function (reply) {
      if (reply && play && play.item === item && typeof item.liked !== 'boolean') { item.liked = !!reply.liked; paintLike(); }
    }).catch(function () {});
  }
  function toggleLike() {
    var item = play && play.item, want, body, viewers;
    if (!item || !item.src || GUEST || inAd()) { showOsd(); return; }
    want = !item.liked;
    item.liked = want;
    paintLike();
    showOsd();
    body = { src: item.src, liked: want };
    if (play.channel && play.channel.id) body.channel = String(play.channel.id);
    viewers = storedViewers();
    if (viewers !== null) body.viewers = viewers;
    // Only the newest press may repaint: an older reply landing late must not undo a newer press.
    var mark = item.likeMark = (item.likeMark || 0) + 1;
    post('/api/like', body).then(function (reply) {
      if (mark !== item.likeMark) return;
      if (reply && typeof reply.liked === 'boolean') { item.liked = reply.liked; if (play && play.item === item) paintLike(); }
    }).catch(function () { if (mark !== item.likeMark) return; item.liked = !want; if (play && play.item === item) paintLike(); });
  }
  function transportEls() {
    var ids = [], els = [], i, el;
    if (GUEST) ids.push('osd-back');
    ids.push('osd-prev-scene', 'osd-play', 'osd-next', 'osd-like', 'osd-options');
    for (i = 0; i < ids.length; i++) {
      el = $(ids[i]);
      if (!el || el.hidden) continue;
      els.push(el);
    }
    return els;
  }
  // Where focus lands when the controls open: play/pause (previous and next are one step either side).
  function transportHome() {
    var els = transportEls(), i;
    for (i = 0; i < els.length; i++) if (els[i].id === 'osd-play') return i;
    return 0;
  }
  function clearScrubFocus() { var line = $('osd-progress'); if (line) line.classList.remove('focused'); }
  // Back to plain watching: nothing focused. The bar fades on its own timer.
  function dropFocus() {
    overlayFocus = '';
    clearTransportFocus();
    clearScrubFocus();
    closeContinue();
  }
  function clearTransportFocus() {
    var els = transportEls(), i;
    for (i = 0; i < els.length; i++) els[i].classList.remove('focused');
  }
  function paintTransportFocus() {
    var els = transportEls(), i;
    if (!els.length) return;
    if (transportIndex < 0) transportIndex = 0;
    if (transportIndex >= els.length) transportIndex = els.length - 1;
    for (i = 0; i < els.length; i++) els[i].classList.toggle('focused', i === transportIndex);
    try { els[transportIndex].focus(); } catch (e) {}
  }
  function clearContinueFocus() {
    var els = $('continue-strip') ? $('continue-strip').children : [], i;
    for (i = 0; i < els.length; i++) els[i].classList.remove('focused');
  }
  function focusTransportRow() {
    overlayFocus = 'transport';
    clearScrubFocus();
    closeContinue();
    clearContinueFocus();
    clearTapSeekChrome();
    paintTransportFocus();
    showOsd();
  }
  function focusContinueRow() {
    var holder = $('continue-strip'), entries = continueEntries();
    if (!holder || !entries.length) { showOsd(); return; }   // nothing to continue: stay on the transport row
    clearTransportFocus();
    clearScrubFocus();
    showOsd();
    overlayFocus = 'continue';
    continueOpen = true;
    paintResumeInto(holder, entries);
    holder.hidden = false;
    focusContinue(Math.max(0, continueIndex));
  }
  function closeOverlay() {
    overlayFocus = '';
    closeContinue();
    clearScrubFocus();
    clearTransportFocus();
    clearTimeout(osdTimer);
    if (osd) osd.classList.add('hidden');
    paintBackChip();
  }
  function seekBy(seconds) {
    var duration, at;
    if (!play) return;
    if (play.airing === 'ad') { if (seconds > 0) skipBreak(); showOsd(); return; }
    duration = durationNow();
    at = media.time() + seconds;
    if (at < 0) at = 0;
    if (duration > 5 && at > duration - 5) at = duration - 5;
    else if (duration > 1 && at > duration - 1) at = duration - 1;
    applySeek(at);
    reportNow();
  }
  function activateTransport() {
    var els = transportEls(), el = els[transportIndex];
    if (!el) return;
    if (el.id === 'osd-back') { undoOrHome(); return; }
    if (el.id === 'osd-prev-scene') previousShow();
    else if (el.id === 'osd-play') { if (!togglePause()) dropFocus(); return; }
    else if (el.id === 'osd-next') { skipForward(); return; }
    else if (el.id === 'osd-like') { toggleLike(); return; }
    else if (el.id === 'osd-options') openOptions();
    showOsd();
  }
  // Right (or Next): the next thing on this channel, at once. With nothing to go to (a single Library film)
  // the bar shows instead of dropping to the home screen.
  function skipForward() {
    if (!play) return;
    if (inAd()) { skipBreak(); showOsd(); return; }
    if (play.mode !== 'channel' && !(play.nextQueue && play.nextQueue[0])) { showOsd(); return; }
    next('skip');
  }
  // ---------- seek mode (the rewind and forward keys) ----------
  // Netflix-style steps: docs/netflix-seek.md — 10 s, 30 s, 60 s, 5 min per tap; hold uses a repeat ramp.
  function scrubTapStepSize(tapIndex) { return window.ontoPlayerExtras.seekTapStepSize(tapIndex); }
  function scrubHoldStepSize(holdIndex) { return window.ontoPlayerExtras.seekHoldStepSize(holdIndex); }
  function paintScrub() {
    var bubble = $('osd-seek-time'), delta, sign, duration, mark, elapsed;
    if (!scrub) return;
    seekPreview = scrub.target;
    delta = Math.round(scrub.target - scrub.from);
    sign = delta < 0 ? '\u2212' : '+';
    // Bubble and marker in this frame; the full bar refresh can wait until after the key has been felt.
    if (bubble) bubble.textContent = sign + clock(Math.abs(delta));
    $('player').classList.add('is-seeking');
    elapsed = $('osd-elapsed');
    if (elapsed) { elapsed.textContent = clock(seekPreview); elapsed.classList.add('is-preview'); }
    duration = durationNow();
    mark = $('osd-seek');
    if (mark && duration) {
      mark.hidden = false;
      mark.style.left = Math.min(100, 100 * scrub.target / duration) + '%';
    }
    osd.classList.remove('hidden');
    setTimeout(function () {
      if (!scrub) return;
      updateOsd();
      showOsd();
      showStrip(scrub.target, true);
    }, 0);
  }
  function scrubStep(direction, held) {
    var duration, target, step;
    if (!play || !play.item || (play.resumePending) || play.errorOn) return;
    if (upNextCard && upNextCard.active()) cancelUpNext();
    if (inAd()) { if (direction > 0 && !held) skipBreak(); showOsd(); return; }
    duration = durationNow();
    if (!scrub) {
      scrub = {
        from: media.time(), target: media.time(), wasPaused: pausedNow(), taps: 0, holdRepeats: 0,
        direction: direction, holding: false
      };
      if (optionOpen) closeOptions();
      clearTransportFocus();
      closeContinue();
      clearContinueFocus();
      overlayFocus = 'seek';
      // Marker and paused chrome in this frame; tell the player on the next tick (same pattern as togglePause).
      if (!scrub.wasPaused) {
        pendingPause = true;
        $('osd-play').classList.add('is-paused');
        $('osd-play').setAttribute('aria-label', 'Play');
        setTimeout(function () { if (scrub && play && !media.paused()) media.pause(); }, 0);
      }
    } else if (!held && scrub.direction !== direction) {
      scrub.from = scrub.target;
      scrub.taps = 0;
      scrub.holdRepeats = 0;
      scrub.direction = direction;
    }
    if (held) {
      scrub.holding = true;
      step = scrubHoldStepSize(scrub.holdRepeats);
      scrub.holdRepeats += 1;
    } else {
      step = scrubTapStepSize(scrub.taps);
      scrub.taps += 1;
    }
    target = scrub.target + direction * step;
    if (target < 0) target = 0;
    if (duration > 5 && target > duration - 5) target = duration - 5;
    else if (duration > 1 && target > duration - 1) target = duration - 1;
    scrub.target = target;
    paintScrub();
  }
  function paintTapSeekBubble() {
    var bubble = $('osd-seek-time'), delta, sign;
    if (!seekCtrl || !bubble) return;
    delta = seekCtrl.delta();
    if (!delta) { $('player').classList.remove('is-tap-seeking'); bubble.textContent = ''; return; }
    sign = delta < 0 ? '\u2212' : '+';
    bubble.textContent = sign + clock(Math.abs(delta));
    $('player').classList.remove('is-seeking');
    $('player').classList.add('is-tap-seeking');
  }
  function resetTapSeek() {
    pendingTapSeek = null;
    if (seekCtrl) seekCtrl.clear();
    arrowHoldRepeats = 0;
    clearTapSeekChrome();
  }
  function resetPressedKeys() {
    pressedKeys.clear();
    arrowHoldRepeats = 0;
  }
  function tapSeekStep(direction, held) {
    var duration, target, step, baseTime;
    if (!play || !play.item || play.resumePending || play.errorOn) return;
    if (upNextCard && upNextCard.active()) cancelUpNext();
    if (inAd()) { if (direction > 0 && !held) skipBreak(); showOsd(); return; }
    if (scrub) cancelScrub();
    duration = durationNow();
    if (!seekCtrl) return;
    baseTime = pendingTapSeek ? pendingTapSeek.target : media.time();
    if (held) {
      step = scrubHoldStepSize(arrowHoldRepeats);
      arrowHoldRepeats += 1;
      target = baseTime + direction * step;
    } else {
      arrowHoldRepeats = 0;
      target = seekCtrl.tap(baseTime, duration, direction, Date.now());
    }
    if (target < 0) target = 0;
    if (duration > 5 && target > duration - 5) target = duration - 5;
    else if (duration > 1 && target > duration - 1) target = duration - 1;
    pendingTapSeek = { target: target, keepBurst: !held };
    seekPreview = null;
    $('osd-elapsed').textContent = clock(target);
    $('osd-elapsed').classList.remove('is-preview');
    if (duration) $('osd-fill').style.width = Math.min(100, 100 * target / duration) + '%';
    paintTapSeekBubble();
    showOsd();
    if (!tapSeekScheduled) {
      tapSeekScheduled = true;
      afterNextPaint(function () {
        tapSeekScheduled = false;
        var req = pendingTapSeek;
        pendingTapSeek = null;
        if (!req || !play) return;
        applySeek(req.target, req.keepBurst);
        reportNowSoon();
      }, 250);
    }
  }
  function endScrub() {
    var was = scrub;
    scrub = null;
    seekPreview = null;
    pendingPause = null;
    if (overlayFocus === 'seek') overlayFocus = '';
    $('player').classList.remove('is-seeking');
    hideStripSoon();
    return was;
  }
  function commitScrub() {
    var was = endScrub();
    if (!was || !play) return;
    applySeek(was.target);
    if (!was.wasPaused) { media.play(); watchEvent('resume'); }
    updateOsd();
    showOsd();
    reportNow();
  }
  function cancelScrub() {
    var was = endScrub();
    if (!was || !play) return;
    if (!was.wasPaused) { media.play(); watchEvent('resume'); }
    updateOsd();
    showOsd();
  }
  // PRE-CH: back to what was on before the last change, where it was left. With nothing to go back to, nothing changes.
  function lastWatched() {
    var entry = watchBack ? watchBack.undo(profileId, Date.now()) : null;
    if (watchBack) persistBack();
    paintBackChip();
    if (entry) { dismissArm(); closeContinue(); restoreEntry(entry); return; }
    showOsd();
  }
  // INFO: the drawing of the remote for this page. A second press, or Back, puts it away.
  function guidePage() { return $('player').hidden ? 'home' : 'player'; }
  function applyRemote(action) {
    var target, chosen;
    if (!action || action.type === 'none' || action.type === 'digit') return;
    if (action.type === 'tap-seek') { tapSeekStep(action.direction, action.held); return; }
    if (action.type === 'scrub') { scrubStep(action.direction, action.held); return; }
    if (action.type === 'scrub-commit') { commitScrub(); return; }
    if (action.type === 'scrub-cancel') { cancelScrub(); return; }
    // Anything else pressed while seeking drops the seek first: the picture is back where it was.
    if (scrub && action.type !== 'like') cancelScrub();
    if (action.type === 'options') { if (optionOpen) closeOptions(); else { closeOverlay(); openOptions(); showOsd(); } return; }
    if (action.type === 'subs') { if (!optionOpen) { closeOverlay(); openOptions(); } handleOptionKey('subt'); showOsd(); return; }
    if (action.type === 'home') { dismissArm(); closeOverlay(); stopPlayback(); return; }
    if (action.type === 'last') { lastWatched(); return; }
    if (action.type === 'directions') { openDirections(); return; }
    if (action.type === 'show') { overlayFocus = ''; clearTransportFocus(); showOsd(); return; }
    if (action.type === 'focus' && action.row === 'transport') {
      if (action.fresh) transportIndex = transportHome();
      focusTransportRow();
      return;
    }
    if (action.type === 'open') {
      // OK while watching: pause and open the controls. OK again (or on a paused picture) resumes and lets go.
      if (inAd()) { skipBreak(); showOsd(); return; }
      if (togglePause()) { transportIndex = transportHome(); focusTransportRow(); }
      else dropFocus();
      return;
    }
    if (action.type === 'focus') { focusContinueRow(); return; }
    if (action.type === 'move' && action.row === 'transport') {
      transportIndex += action.delta;
      paintTransportFocus();
      showOsd();
      return;
    }
    if (action.type === 'move') {
      if (directionsShown && action.delta < 0 && continueIndex === 0) { showOsd(); return; }
      focusContinue(continueIndex + action.delta);
      showOsd();
      return;
    }
    if (action.type === 'seek') { seekBy(action.seconds); return; }
    if (action.type === 'play-pause') {
      if (inAd()) { skipBreak(); showOsd(); return; }
      togglePause();
      return;
    }
    if (action.type === 'activate') {
      if (overlayFocus === 'continue' || continueOpen) {
        chosen = $('continue-strip') && $('continue-strip').children[continueIndex];
        if (chosen && chosen._entry && chosen._entry.direction && chosen._entry.direction !== 'wait') {
          if (chosen._entry.direction) sendDirection(chosen._entry);
          playResume(chosen._entry);
        }
        return;
      }
      activateTransport();
      return;
    }
    if (action.type === 'play') { if (play) { media.play(); watchEvent('resume'); } showOsd(); reportNow(); return; }
    if (action.type === 'pause') { if (play) media.pause(); showOsd(); reportNow(); return; }
    if (action.type === 'stop') { dismissArm(); closeOverlay(); stopPlayback(); return; }
    if (action.type === 'like') { toggleLike(); return; }
    if (action.type === 'next') { skipForward(); return; }
    if (action.type === 'previous') { previousShow(); return; }
    if (action.type === 'close') { closeOverlay(); return; }
    if (action.type === 'back') { backOneStep(); return; }
    if (action.type === 'tune') {
      target = channelByStep(action.direction);
      if (!target) { showOsd(); return; }
      // Flipped back onto the channel already playing: drop the card, change nothing.
      if (play && play.channel && target.id === play.channel.id) { dismissArm(); showOsd(); return; }
      armChannel(target);
    }
  }

  // ---------- remote telemetry ----------
  // One entry per press: the key, what it did, where focus was, and ms from the press to the next painted frame.
  // Sent in batches to /api/remote-log; never blocks or delays a key.
  var remoteQueue = [], remoteTimer = 0, remoteSession = 'tv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  function flushRemote() {
    clearTimeout(remoteTimer); remoteTimer = 0;
    if (!remoteQueue.length) return;
    var batch = remoteQueue.splice(0, 100);
    if (!TOKEN || GUEST) return;
    try {
      post('/api/remote-log', { session: remoteSession, build: String(CONFIG.build || 'dev').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64), events: batch }).catch(function () {});
    } catch (e) {}
  }
  function logRemote(page, key, type, focusName, repeat, pressedAt) {
    try {
      var entry = { t: Date.now(), p: page, k: key, a: type || 'none', f: focusName || '', ms: null };
      if (repeat) entry.r = true;
      if (pressedAt && window.performance && performance.now) {
        (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
          setTimeout(function () { entry.ms = Math.max(0, Math.min(60000, Math.round(performance.now() - pressedAt))); }, 0);
        });
      }
      remoteQueue.push(entry);
      if (remoteQueue.length > 200) remoteQueue.shift();
      if (remoteQueue.length >= 25) setTimeout(flushRemote, 50);
      else if (!remoteTimer) remoteTimer = setTimeout(flushRemote, 15000);
    } catch (e) {}
  }

  // ---------- keys ----------
  document.addEventListener('keydown', function (event) {
    var key = event.keyCode;
    var repeat = pressedKeys.down(key, event.repeat);
    var pressedAt = window.performance && performance.now ? performance.now() : 0;
    if (window.ontoUke && window.ontoUke.isOpen()) { if (window.ontoUke.key(key)) event.preventDefault(); return; }
    if (window.ontoLibrary && window.ontoLibrary.isOpen()) { window.ontoLibrary.key(key); event.preventDefault(); return; }
    if (window.ontoGames && window.ontoGames.isOpen()) {
      event.preventDefault();
      if (!repeat && window.ontoGames.handleKey(key, 1)) {
        diag('game_input', { page: 'games', input: key >= 48 && key <= 57 ? 'number' : key >= 37 && key <= 40 ? 'arrows' : key === 13 ? 'ok' : 'back' });
      }
      return;
    }
    if (consoleState) { if (consoleKey(key)) event.preventDefault(); return; }
    if (pickerOpen) { if (pickerKey(key)) event.preventDefault(); return; }
    if (!$('setup').hidden) return;
    if (window.ontoRemoteGuide) {
      if (key === window.ontoRemoteMap.KEY.INFO) {
        if (!repeat) window.ontoRemoteGuide.toggle(guidePage());
        logRemote(guidePage(), key, 'guide', overlayFocus, !!repeat, pressedAt);
        event.preventDefault();
        return;
      }
      if (window.ontoRemoteGuide.isOpen()) {
        if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) { window.ontoRemoteGuide.close(); event.preventDefault(); return; }
        window.ontoRemoteGuide.press(key);
        // The key still does its job; if that changed the page, the drawing follows.
        setTimeout(function () { if (window.ontoRemoteGuide.isOpen()) window.ontoRemoteGuide.open(guidePage()); }, 0);
      }
    }
    var started = Date.now();
    var input = (key >= 48 && key <= 57) ? 'number' : (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) ? 'back' : (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) ? 'ok' : 'arrows';
    if (!repeat) answer(started, input);
    if (key >= 48 && key <= 57) {
      if (repeat) { event.preventDefault(); return; }
      if (layoutMode() === 'tube' && $('player').hidden) {
        if (window.ontoTube) window.ontoTube.digit(String(key - 48));
        event.preventDefault();
        return;
      }
      // Digits tune like a TV: wait briefly for a second digit when one could follow.
      clearTimeout(digitTimer);
      digitBuffer += String(key - 48);
      showDigitHold(digitBuffer);
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
      if (window.ontoTube && window.ontoTube.playingKey(key)) { event.preventDefault(); return; }
      var action, optionName, resumeName, armed;
      if (upNextCard && upNextCard.active() && (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE)) { cancelUpNext(); event.preventDefault(); return; }
      if (optionOpen && (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE)) { closeOptions(); event.preventDefault(); return; }
      if (play && play.resumePending) {
        resumeName = navKey(key);
        if (resumeName === 'left') { focusResume(-1); event.preventDefault(); return; }
        if (resumeName === 'right') { focusResume(1); event.preventDefault(); return; }
        if (resumeName === 'ok') { acceptResume(); event.preventDefault(); return; }
      }
      if (play && play.errorOn) {
        // Back leaves a picture that will not come for the home screen; it used to be swallowed, which a
        // channel that fails on its first tune would have made a screen with no way out.
        if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE || key === KEY.STOP) stopPlayback();
        else if (navKey(key) === 'ok') retryPlayback();
        event.preventDefault();
        return;
      }
      if (upNextCard && upNextCard.active() && navKey(key) === 'ok') { acceptUpNext(); event.preventDefault(); return; }
      if (!optionOpen && !repeat && (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) && channelArm) {
        armed = channelArm.ok();
        if (armed.type === 'commit') { commitChannel(armed.target); event.preventDefault(); return; }
      }
      if (optionOpen) {
        optionName = navKey(key);
        if (optionName) { handleOptionKey(optionName); event.preventDefault(); return; }
      }
      action = window.ontoRemoteMap.decide({
        overlay: osd.classList.contains('hidden') ? 'hidden' : 'open',
        focus: overlayFocus,
        repeat: !!repeat
      }, key);
      logRemote('player', key, action && action.type, overlayFocus, !!repeat, pressedAt);
      applyRemote(action);
      if (!action || action.type === 'none') return;
      event.preventDefault();
      return;
    } else {
      logRemote('home', key, key === KEY.ENTER ? 'home-select' : (key === KEY.LEFT || key === KEY.RIGHT || key === KEY.UP || key === KEY.DOWN) ? 'home-move' :
        (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) ? 'home-back' : 'none', 'home', !!repeat, pressedAt);
      if (homeReturn && homeReturn.pending) homeReturn = null; // the viewer has moved on from where they came back to
      if (layoutMode() === 'tube' && window.ontoTube && window.ontoTube.homeKey(key)) { event.preventDefault(); return; }
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
    var key = event.keyCode;
    pressedKeys.up(key);
    if ($('player').hidden) return;
    if (window.ontoUke && window.ontoUke.isOpen()) return;
    if (window.ontoGames && window.ontoGames.isOpen()) return;
    if (window.ontoLibrary && window.ontoLibrary.isOpen()) return;
    if (consoleState) return;
    clearInterval(sweepTimer);
    sweepDir = 0;
    if (key === KEY.LEFT || key === KEY.RIGHT) arrowHoldRepeats = 0;
    if (scrub && scrub.holding && (key === KEY.FF || key === KEY.RW)) commitScrub();
  });

  // Media keys reach the app only once registered (Tizen). SUBT is mapped when the TV exposes it.
  if (window.tizen && tizen.tvinputdevice) {
    var remoteKeys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'MediaTrackNext', 'MediaTrackPrevious', 'ChannelUp', 'ChannelDown',
      'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', 'Tools', 'Guide', 'ChannelList', 'PreviousChannel',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    // The TV's own code for each named key wins over the defaults in remote-map.js and on the guide's drawing.
    var NAMED = { ColorF0Red: ['RED', 'a'], ColorF1Green: ['GREEN', 'b'], ColorF2Yellow: ['YELLOW', 'c'], ColorF3Blue: ['BLUE', 'd'],
      Info: ['INFO', 'info'], Tools: ['TOOLS', 'tools'], Guide: ['GUIDE', 'guide'], ChannelList: ['CH_LIST', 'chlist'],
      PreviousChannel: ['PRE_CH', 'prech'], MediaFastForward: ['FF', 'ff'], MediaRewind: ['RW', 'rw'] };
    var supported = [];
    try { supported = tizen.tvinputdevice.getSupportedKeys() || []; } catch (e) { supported = []; }
    for (var subtIndex = 0; subtIndex < supported.length; subtIndex++) {
      var subtName = supported[subtIndex] && supported[subtIndex].name;
      var subtCode = supported[subtIndex] && supported[subtIndex].code;
      if (subtName && NAMED[subtName] && typeof subtCode === 'number') {
        window.ontoRemoteMap.KEY[NAMED[subtName][0]] = subtCode;
        if (window.ontoRemoteGuide) window.ontoRemoteGuide.setCode(NAMED[subtName][1], subtCode);
      }
      if (subtName && /caption|subtitle|subt/i.test(subtName)) {
        remoteKeys.push(subtName);
        KEY.SUBT = subtCode;
        window.ontoRemoteMap.KEY.SUBT = subtCode;
        if (window.ontoRemoteGuide) window.ontoRemoteGuide.setCode('subt', subtCode);
      }
    }
    if (typeof tizen.tvinputdevice.registerKeyBatch === 'function') {
      try { tizen.tvinputdevice.registerKeyBatch(remoteKeys); }
      catch (eBatch) {
        remoteKeys.forEach(function (name) {
          try { tizen.tvinputdevice.registerKey(name); } catch (e) {}
        });
      }
    } else {
      remoteKeys.forEach(function (name) {
        try { tizen.tvinputdevice.registerKey(name); } catch (e) {}
      });
    }
  }
  // Leaving the app (Home button or TV standby) saves the place and suspends AVPlay's hardware decoder
  // so another app or standby cannot leave AVPlay in INVALID_STATE on return.
  // Back after a long time away, the page starts afresh from the server (boot.js): on 16 Nov 2026 a page left
  // hidden for 23 hours woke with no pictures on the cards and every title failing, though the server served both.
  window.addEventListener('blur', resetPressedKeys);
  var hiddenAt = 0, STALE_AFTER_MS = 30 * 60 * 1000;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      resetPressedKeys();
      hiddenAt = Date.now();
      flushRemote();
      if (play) {
        saveProgress(false);
        if (media.suspend) media.suspend(); else media.pause();
        syncScreenSaver();
      }
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > STALE_AFTER_MS && !GUEST && window.tizen) {
      hiddenAt = 0;
      setTimeout(function () { location.reload(); }, 400);
      diag('wake_reload', { page: play ? 'player' : 'home' });
      try { if (play) stopPlayback(); } catch (e) {}
    } else {
      hiddenAt = 0;
      if (play && play.item && media.engine === 'avplay' && media.restore) {
        media.restore(mediaUrl(play.item.src), playbackPosition(), false);
        syncScreenSaver();
        updateOsd();
        showOsd();
      }
    }
  });

  // The shell reports what it is doing to the TV (tuning, a TV that will not answer).
  window.ontoNotice = status;
  // The shell's Home button: whatever is on, come back to the home screen.
  window.ontoHome = function () {
    if (window.ontoUke && window.ontoUke.isOpen()) window.ontoUke.close();
    if (window.ontoGames && window.ontoGames.isOpen()) window.ontoGames.close();
    if (window.ontoLibrary) window.ontoLibrary.abandon();
    if (play) stopPlayback();
    focus = { row: 0, col: 0 };
    render();
  };

  window.ontoLibraryQuery = function () {
    var stored = storedViewers(), rating = storedRating();
    if (stored === null) return '/api/library';
    return '/api/library?viewers=' + q(stored) + (rating ? '&rating=' + q(rating) : '');
  };
  window.ontoLibraryApi = function (path) { return api(path); };
  window.ontoArtUrl = artUrl;
  window.ontoLibraryClosed = function (from) {
    if (from === 'player') showOsd();
    else moveFocus(0, 0);
  };
  // The Mac app follows the episode it asked for with the rest of that show.
  window.addEventListener('message', function (event) {
    var list, queue = [], i;
    if (!desktopQuery || event.source !== window.parent || !event.data || event.data.type !== 'onto:desktop-queue') return;
    list = event.data.queue;
    if (!play || !list || !list.length) return;
    for (i = 0; i < list.length && queue.length < 60; i++) {
      if (list[i] && typeof list[i].src === 'string' && list[i].src) queue.push({ src: list[i].src, title: typeof list[i].title === 'string' ? list[i].title : '', run: true });
    }
    play.nextQueue = queue;
    updateOsd();
  });
  window.ontoPlayLibrary = function (item, rest) {
    if (!item || !item.src) return;
    tuneRequest++;
    if (play && play.item) { watchEvent('stop'); saveProgress(false); }
    var series = item.show && item.title && item.show !== item.title ? item.show : 'Library';
    var title = item.title || item.show || '';
    play = { mode: 'single', channel: { id: 'library', number: '', name: series }, nextQueue: rest && rest.length ? rest : [] };
    load({
      src: item.src,
      title: title,
      show: title,
      resume: item.resume || 0,
      duration: item.durationSeconds || item.duration || 0,
      queue: [{ kind: 'show', src: item.src, breaks: [] }]
    });
  };
  // After a reload for a new interface, put back what was on.
  (function () {
    var held = null;
    try { held = JSON.parse(window.localStorage.getItem('onto.reload.resume') || 'null'); window.localStorage.removeItem('onto.reload.resume'); } catch (e) { held = null; }
    if (!held || typeof held.src !== 'string' || !held.src || !(Date.now() - held.at < 120000)) return;
    var tries = 0;
    (function again() {
      tries++;
      if (!SERVER) { if (tries < 40) setTimeout(again, 250); return; }
      try { window.ontoTVAction('play', { src: held.src, positionSeconds: held.positionSeconds }); } catch (e) {}
    }());
  }());
  if (window.ontoTube) window.ontoTube.mount({
    $: $,
    api: api,
    q: q,
    clock: clock,
    artUrl: artUrl,
    loadArt: loadArt,
    layout: layoutMode,
    viewers: storedViewers,
    rating: storedRating,
    rows: function () { return rows; },
    setRows: function (next) { rows = next; },
    focusAt: function () { return focus; },
    move: function () { moveFocus(0, 0); },
    playCard: startTube,
    playing: function () { return play; },
    mediaTime: function () { return media.time(); },
    mediaDuration: function () { return media.duration(); },
    mediaEnded: function () { return media.ended(); },
    save: saveProgress,
    watch: watchEvent,
    showOsd: showOsd,
    keyName: navKey,
    KEY: KEY
  });
  loadLayoutStore();
  syncProfileFromStorage();
  paintBodyProfile();
  if (!PACKAGED) loadHousehold();   // the packaged app asks once it has found its server
  paintClock();
  setInterval(paintClock, 1000);
  // Season: a light Christmas touch on the home screen from mid-November to Twelfth Night; the Christmas and
  // Fireplace channels get the full treatment (styles.css body.season-xmas / body.xmas-heavy).
  (function () {
    var d = new Date(), m = d.getMonth(), day = d.getDate();
    if ((m === 10 && day >= 15) || m === 11 || (m === 0 && day <= 6)) document.body.classList.add('season-xmas');
  }());
  loadPools();
  setInterval(loadPools, 600000);
  // Screensaver: five idle minutes on the home screen show the focused channel's pictures full screen (all
  // pools when it has none) with the time; no photo credits on screen (Ian: household use only). Any key wakes
  // it and does nothing else.
  var SAVER_MS = 300000, lastInput = Date.now(), saver = null, saverTimer = 0, saverIndex = 0;
  function saverPool() {
    var pool = channelPools[heroChannelId] || [], all = [], id, i;
    if (pool.length) return pool;
    for (id in channelPools) if (channelPools.hasOwnProperty(id)) for (i = 0; i < channelPools[id].length; i++) all.push(channelPools[id][i]);
    return all;
  }
  function saverShow() {
    var pool = saverPool();
    if (!saver || !pool.length) return;
    saverIndex = (saverIndex + 1) % pool.length;
    var entry = pool[saverIndex], url = artUrl(entry.url), image = new Image();
    image.onload = function () {
      if (!saver) return;
      var img = document.createElement('img');
      img.alt = ''; img.src = url;
      img.setAttribute('data-seq', String(++pictureSeq));
      saver.insertBefore(img, saver.firstChild);
      setTimeout(function () {
        img.className = 'on';
        setTimeout(function () { if (saver) dropOlder(saver, img); }, 1600);
      }, 30);
    };
    image.src = url;
  }
  function startSaver() {
    if (saver || !saverPool().length) return;
    saver = document.createElement('div');
    saver.id = 'saver';
    saver.setAttribute('aria-hidden', 'true');
    saver.innerHTML = '<div class="saver-shade"></div><time class="saver-clock"></time>';
    document.body.appendChild(saver);
    saverIndex = Math.floor(Math.random() * saverPool().length);
    saverShow();
    saverTimer = setInterval(saverShow, 12000);
    paintSaverClock();
    startSaverPanel();
  }
  // Screensaver panels: live facts for the focused channel. Planes and cars: a radar scope of the aircraft
  // around Perth Airport (server /api/saver-info, adsb.lol). Christmas: Perth beside the North Pole, the days to
  // Christmas, and Santa's sleigh on a 360-degree band (at the workshop until Christmas Eve, then following
  // local midnight west around the world).
  var panelTimers = [], flights = [], flightsAt = 0;
  var saverForce = '';
  function saverMode() {
    if (saverForce) return saverForce;
    if (heroChannelId === 'trains' || heroChannelId === 'rides') return 'radar';
    if (heroChannelId === 'christmas' || heroChannelId === 'fireplace') return 'xmas';
    return '';
  }
  function startSaverPanel() {
    var mode = saverMode(), panel;
    if (!saver || !mode) return;
    panel = document.createElement('div');
    panel.className = 'saver-panel saver-' + mode;
    saver.appendChild(panel);
    if (mode === 'radar') {
      panel.innerHTML = '<div class="sp-head"><span class="sp-title">Over Perth now</span><span class="sp-count"></span></div><canvas width="760" height="760"></canvas>';
      var poll = function () { api('/api/saver-info?kind=flights').then(function (b) { flights = (b && b.flights) || []; flightsAt = Date.now(); }, function () {}); };
      poll();
      panelTimers.push(setInterval(poll, 10000));
      panelTimers.push(setInterval(function () { drawRadar(panel); }, 1000));
      drawRadar(panel);
    } else {
      panel.innerHTML = '<div class="sp-weather"></div><div class="sp-days"></div><div class="sp-sleigh"><div class="sp-band"><i class="sp-perth"><b>Perth</b></i><i class="sp-santa"><b>Santa</b></i></div><div class="sp-where"></div></div>';
      var loadWeather = function () { api('/api/saver-info?kind=weather').then(function (b) { paintWeather(panel, b && b.weather); }, function () {}); };
      loadWeather();
      panelTimers.push(setInterval(loadWeather, 900000));
      paintSleigh(panel);
      panelTimers.push(setInterval(function () { paintSleigh(panel); }, 30000));
    }
  }
  function stopSaverPanel() { while (panelTimers.length) clearInterval(panelTimers.pop()); }
  var NM_PER_DEG = 60, AIRPORT = { lat: -31.9403, lon: 115.9669 }, RANGE_NM = 50;
  function drawRadar(panel) {
    var canvas = panel.querySelector('canvas'), ctx = canvas && canvas.getContext('2d');
    if (!ctx) return;
    var W = canvas.width, c = W / 2, R = c - 30, px = R / RANGE_NM, i, f, now = Date.now();
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(4, 14, 12, 0.82)';
    ctx.beginPath(); ctx.arc(c, c, R + 18, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(126, 224, 129, 0.35)'; ctx.lineWidth = 2;
    ctx.font = '700 22px Nunito, sans-serif'; ctx.fillStyle = 'rgba(126, 224, 129, 0.75)';
    for (i = 10; i <= RANGE_NM; i += 20) {
      ctx.beginPath(); ctx.arc(c, c, i * px, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(i + ' nm', c + 6, c - i * px + 22);
    }
    ctx.beginPath(); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.stroke();
    ctx.fillStyle = '#7ee081'; ctx.font = '800 28px Nunito, sans-serif'; ctx.fillText('N', c - 9, c - R + 4);
    // Perth Airport: runways 03/21 and 06/24.
    var rw = function (bearing, len) {
      var a = bearing * Math.PI / 180, dx = Math.sin(a) * len, dy = -Math.cos(a) * len;
      ctx.beginPath(); ctx.moveTo(c - dx, c - dy); ctx.lineTo(c + dx, c + dy); ctx.stroke();
    };
    ctx.strokeStyle = '#f6f2ea'; ctx.lineWidth = 4; rw(29, 14); rw(59, 9);
    var shown = 0, cos = Math.cos(AIRPORT.lat * Math.PI / 180), placed = [];
    for (i = 0; i < flights.length; i++) {
      f = flights[i];
      var dt = (now - flightsAt) / 3600000, lat = f.lat, lon = f.lon;
      if (!f.ground && f.track !== null && f.gs) {
        var tr = f.track * Math.PI / 180, dist = f.gs * dt / NM_PER_DEG;
        lat += Math.cos(tr) * dist; lon += Math.sin(tr) * dist / cos;
      }
      var x = c + (lon - AIRPORT.lon) * cos * NM_PER_DEG * px, y = c - (lat - AIRPORT.lat) * NM_PER_DEG * px;
      if (Math.sqrt((x - c) * (x - c) + (y - c) * (y - c)) > R) continue;
      if (f.ground) { ctx.fillStyle = 'rgba(246, 242, 234, 0.45)'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); continue; }
      shown++;
      ctx.save(); ctx.translate(x, y); ctx.rotate((f.track || 0) * Math.PI / 180);
      ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(10, 12); ctx.lineTo(0, 6); ctx.lineTo(-10, 12); ctx.closePath(); ctx.fill();
      ctx.restore();
      // Label beside the aircraft; when it would cover one already drawn, try the other sides.
      var name = f.callsign || f.reg || '', line2 = (f.alt >= 10000 ? 'FL' + Math.round(f.alt / 100) : f.alt.toLocaleString() + ' ft') + (f.type ? ' \u00b7 ' + f.type : '');
      ctx.font = '800 24px Nunito, sans-serif';
      var lw = Math.max(ctx.measureText(name).width, 20 + line2.length * 10), lh = 48, spots = [[16, -26], [-16 - lw, -26], [16, 18], [-16 - lw, 18], [-lw / 2, -66], [-lw / 2, 26]], spot = spots[0], k, b;
      for (k = 0; k < spots.length; k++) {
        b = { x: x + spots[k][0], y: y + spots[k][1], w: lw, h: lh };
        if (!labelHits(placed, b)) { spot = spots[k]; break; }
      }
      placed.push({ x: x + spot[0], y: y + spot[1], w: lw, h: lh });
      ctx.fillStyle = '#f6f2ea';
      ctx.fillText(name, x + spot[0], y + spot[1] + 22);
      ctx.fillStyle = 'rgba(246, 242, 234, 0.75)'; ctx.font = '700 20px Nunito, sans-serif';
      ctx.fillText(line2, x + spot[0], y + spot[1] + 46);
    }
    var count = panel.querySelector('.sp-count');
    if (count) count.textContent = shown + (shown === 1 ? ' aircraft' : ' aircraft');
  }
  function labelHits(list, b) {
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) return true;
    }
    return false;
  }
  function weatherIcon(code) {
    var sun = '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="9" fill="#ffd166"/><g stroke="#ffd166" stroke-width="4" stroke-linecap="round"><path d="M24 4v6M24 38v6M4 24h6M38 24h6M10 10l4 4M34 34l4 4M38 10l-4 4M14 34l-4 4"/></g></svg>';
    var cloud = '<svg viewBox="0 0 48 48"><path fill="#dfe7ee" d="M14 36h22a8 8 0 0 0 0-16 11 11 0 0 0-21-3 9 9 0 0 0-1 19z"/></svg>';
    var snow = '<svg viewBox="0 0 48 48"><g stroke="#e8f4ff" stroke-width="3.5" stroke-linecap="round"><path d="M24 6v36M8.4 15l31.2 18M8.4 33l31.2-18M19 9l5 5 5-5M19 39l5-5 5 5"/></g></svg>';
    var rain = '<svg viewBox="0 0 48 48"><path fill="#dfe7ee" d="M14 28h22a8 8 0 0 0 0-16 11 11 0 0 0-21-3 9 9 0 0 0-1 19z"/><g stroke="#5ab4ff" stroke-width="3.5" stroke-linecap="round"><path d="M16 34l-3 7M25 34l-3 7M34 34l-3 7"/></g></svg>';
    if (code === null || code === undefined) return cloud;
    if (code <= 1) return sun;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return snow;
    if ((code >= 51 && code <= 67) || code >= 80) return rain;
    return cloud;
  }
  function paintWeather(panel, w) {
    var box = panel.querySelector('.sp-weather');
    if (!box || !w) return;
    var cell = function (name, x) {
      if (!x || x.temp === null) return '';
      return '<div class="sp-place"><span class="sp-icon">' + weatherIcon(x.code) + '</span><span class="sp-temp">' + x.temp + '\u00b0</span>' +
        '<span class="sp-name">' + name + '</span><span class="sp-range">' + (x.max !== null ? 'high ' + x.max + '\u00b0 \u00b7 low ' + x.min + '\u00b0' : '') + '</span></div>';
    };
    box.innerHTML = cell('Perth', w.perth) + cell('North Pole', w.northPole);
  }
  function paintSleigh(panel) {
    var now = new Date(), year = now.getFullYear();
    var xmas = new Date(year, 11, 25);
    if (now > new Date(year, 11, 26)) xmas = new Date(year + 1, 11, 25);
    var days = Math.ceil((xmas - now) / 86400000);
    var daysEl = panel.querySelector('.sp-days');
    if (daysEl) daysEl.textContent = days > 1 ? 'Christmas in ' + days + ' days' : days === 1 ? 'Christmas is tomorrow' : 'Merry Christmas';
    // Santa flies with local midnight: at UTC hour h, midnight is at longitude (0 - h) * 15, wrapped to +-180.
    var startUtc = Date.UTC(xmas.getFullYear(), 11, 24, 10), endUtc = Date.UTC(xmas.getFullYear(), 11, 25, 12);
    var flying = now.getTime() >= startUtc && now.getTime() <= endUtc;
    var lon = 0;
    if (flying) {
      var h = now.getUTCHours() + now.getUTCMinutes() / 60;
      lon = ((-(h) * 15) % 360 + 540) % 360 - 180;
    }
    var pos = function (l) { return ((l + 180) / 360 * 100).toFixed(2) + '%'; };
    var santa = panel.querySelector('.sp-santa'), perth = panel.querySelector('.sp-perth'), where = panel.querySelector('.sp-where');
    if (perth) perth.style.left = pos(115.9);
    if (santa) { santa.style.left = pos(flying ? lon : 0); santa.className = 'sp-santa' + (flying ? ' flying' : ''); }
    if (where) where.textContent = flying ? "Santa's sleigh \u00b7 over " + regionAt(lon) : "Santa's sleigh \u00b7 at the workshop, North Pole";
  }
  function regionAt(lon) {
    if (lon >= 150 || lon < -150) return 'the Pacific and New Zealand';
    if (lon >= 110) return 'Australia and East Asia';
    if (lon >= 60) return 'India and Central Asia';
    if (lon >= 20) return 'the Middle East and Africa';
    if (lon >= -20) return 'Europe and West Africa';
    if (lon >= -60) return 'the Atlantic and South America';
    if (lon >= -100) return 'North America';
    return 'the western Americas and Hawaii';
  }
  function paintSaverClock() {
    var c = saver && saver.querySelector('.saver-clock'), clock = $('clock');
    if (c && clock) c.textContent = clock.textContent;
  }
  function stopSaver() {
    if (!saver) return false;
    stopSaverPanel();
    clearInterval(saverTimer); saverTimer = 0;
    if (saver.parentNode) saver.parentNode.removeChild(saver);
    saver = null;
    return true;
  }
  document.addEventListener('keydown', function (event) {
    lastInput = Date.now();
    if (stopSaver()) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  setInterval(function () {
    paintSaverClock();
    if (saver && (play || $('home').hidden)) { stopSaver(); return; }
    if (saver || play || $('home').hidden || Date.now() - lastInput < SAVER_MS) return;
    startSaver();
  }, 5000);
  window.ontoSaver = { start: function (mode) { saverForce = mode || ''; startSaver(); }, stop: stopSaver };
  setInterval(paintBackChip, 1000);
  setInterval(watchBand, 30000);
  loadHome();
})();
