/* Onto the TV, TV side. Runs in a Samsung TV's web engine (Tizen 4+, Chromium 56+),
   so it sticks to ES2017: no optional chaining, no nullish coalescing. */
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
  var ICONS = { '2': '🧸', '6': '🚀', grown: '🎬', music: '🎵', all: '🔀' };
  var SEEK = 30, SAVE_EVERY = 15000, OSD_MS = 4000;

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video'), osd = $('osd');
  var data = { channels: [], continueWatching: [], shows: [] };
  var rows = [];            // [{ el, items, kind }]
  var focus = { row: 0, col: 0 };
  var page = null;          // null for home, or the channel whose shows are open
  var openShow = null;      // { name, episodes } while the shows row lists one show's episodes
  // The Mac mini or Air running the TV offers YouTube and the TV's own tuner; a browser does not.
  var SHELL = window.ontoShell || null;
  var play = null;          // { mode: 'channel'|'show'|'single', channel, list, index, item, visitStart, lastSave }
  var osdTimer = 0;

  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (TOKEN) options.headers['X-Onto-Token'] = TOKEN;
    return fetch(SERVER + path, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || ('Server error ' + response.status));
        return body;
      });
    });
  }
  function q(value) { return encodeURIComponent(value); }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    var art = document.createElement('div');
    art.className = 'art';
    var label = document.createElement('div');
    label.className = 'label';
    var name = document.createElement('span');
    name.className = 'name';
    var count = document.createElement('span');
    count.className = 'count';
    if (kind === 'launch') {
      el.className += ' tint-' + (item.app || item.id);
      if (item.app === 'youtube') art.innerHTML = '<b class="yt-mark"></b>';
      else art.textContent = ICONS[item.id] || '📺';
      name.textContent = item.label;
    } else if (kind === 'shuffle') {
      art.textContent = ICONS.all;
      name.textContent = 'Shuffle';
      count.textContent = item.count;
    } else if (kind === 'live') {
      art.innerHTML = '<span class="lcn"></span><span class="on-air">LIVE</span>';
      art.firstChild.textContent = item.lcn;
      name.textContent = item.name;
    } else if (kind === 'show') {
      art.style.backgroundImage = 'url("' + fileUrl('art', item.src) + '")';
      name.textContent = item.name;
      count.textContent = item.count;
    } else {
      art.style.backgroundImage = 'url("' + fileUrl('art', item.src) + '")';
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
  }

  // Home: what to watch, what to finish, what is on air. A channel: its shows.
  function launchItems() {
    var items = data.channels.filter(function (channel) { return channel.id !== 'all'; });
    if (SHELL && SHELL.youtube) items.splice(Math.min(2, items.length), 0, { app: 'youtube', label: 'YouTube' });
    return items;
  }
  function onChannel(item) { return !page || (item.channels || []).indexOf(page.id) >= 0; }
  function render() {
    var live = (SHELL && SHELL.live) || [];
    var resume = data.continueWatching.filter(onChannel);
    rows = [];
    $('page-title').hidden = !page;
    $('page-title').textContent = page ? page.label : '';
    $('launch-row').hidden = !!page;
    $('shows-row').hidden = !page;
    $('live-row').hidden = !!page || !live.length;
    if (!page) {
      rows.push({ el: $('launch'), items: launchItems(), kind: 'launch' });
      fill($('launch'), rows[0].items, 'launch');
    } else if (openShow) {
      $('shows-title').textContent = openShow.name;
      rows.push({ el: $('shows'), items: openShow.episodes, kind: 'episode' });
      fill($('shows'), openShow.episodes, 'episode');
    } else {
      $('shows-title').textContent = 'Shows';
      var shows = [page].concat(data.shows.filter(onChannel));
      rows.push({ el: $('shows'), items: shows, kind: 'show' });
      fill($('shows'), shows, 'show');
    }
    $('continue-row').hidden = !resume.length;
    fill($('continue'), resume, 'episode');
    if (resume.length) rows.push({ el: $('continue'), items: resume, kind: 'continue' });
    if (!page && live.length) {
      fill($('live'), live, 'live');
      rows.push({ el: $('live'), items: live, kind: 'live' });
    }
    focus.row = Math.min(focus.row, rows.length - 1);
    moveFocus(0, 0);
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
      focus.col = Math.max(0, rows[0].items.map(function (show) { return show.name; }).indexOf(name));
      moveFocus(0, 0);
      return true;
    }
    if (page) {
      var id = page.id;
      page = null;
      focus = { row: 0, col: 0 };
      render();
      focus.col = Math.max(0, rows[0].items.map(function (item) { return item.id; }).indexOf(id));
      moveFocus(0, 0);
      return true;
    }
    return false;
  }

  function caption(row, item) {
    if (!item) return '';
    if (row.kind === 'launch') return item.app === 'youtube' ? 'YouTube' : item.label + ' · ' + item.count + ' videos';
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
    var tiles = document.querySelectorAll('.tile.focused');
    for (var i = 0; i < tiles.length; i++) tiles[i].classList.remove('focused');
    var el = row.el.children[focus.col];
    if (el) {
      el.classList.add('focused');
      // Keep the focused tile in view: scroll the row so it sits second from the left.
      var offset = Math.max(0, el.offsetLeft - (el.offsetWidth + 24));
      var max = Math.max(0, row.el.scrollWidth - (1920 - 160));
      row.el.style.transform = 'translateX(' + -Math.min(offset, max) + 'px)';
    }
    status(caption(row, row.items[focus.col]));
  }

  function select() {
    var row = rows[focus.row], item = row && row.items[focus.col];
    if (!item) return;
    if (row.kind === 'launch') return item.app ? SHELL.open(item.app) : openPage(item);
    if (row.kind === 'live') return SHELL.watchLive(item.lcn);
    if (row.kind === 'show' && item === page) return startChannel(page);
    if (row.kind === 'show') {
      status('Loading ' + item.name + '…');
      return api('/api/show?name=' + q(item.name)).then(function (episodes) {
        openShow = { name: item.name, episodes: episodes };
        focus.col = 0;
        render();
      }).catch(fail);
    }
    if (row.kind === 'episode') return startList('show', openShow.episodes, focus.col);
    if (row.kind === 'continue') return startList('single', [item], 0);
  }

  function loadHome() {
    status('Connecting to ' + (SERVER || 'the Mac') + '…');
    return api('/api/home').then(function (home) { data = home; render(); }).catch(function (error) {
      if (PACKAGED) return findServer();
      fail(error);
    });
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
    var candidates = [saved].concat(CONFIG.servers || []).filter(Boolean);
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
    play.item = item;
    play.visitStart = item.resume || 0;
    play.lastSave = Date.now();
    $('home').hidden = true;
    $('player').hidden = false;
    document.body.classList.add('playing');
    media.load(fileUrl('media', item.src), item.resume || 0);
    updateOsd();
    showOsd();
  }

  function startChannel(channel, fromItem, reason) {
    play = play && play.channel === channel ? play : { mode: 'channel', channel: channel };
    var body = { channel: channel.id };
    if (fromItem) {
      body.current = fromItem.src;
      body.reason = reason;
      body.time = Math.floor(media.time());
      body.watched = Math.floor(Math.max(0, media.time() - play.visitStart));
      body.duration = Math.floor(media.duration() || fromItem.duration || 0);
    }
    return post('/api/next', body).then(load).catch(function (error) { stopPlayback(); fail(error); });
  }

  function startList(mode, list, index) {
    play = { mode: mode, list: list, index: index };
    load(list[index]);
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
    saveProgress(reason === 'ended');
    if (play.mode === 'channel') return startChannel(play.channel, current, reason);
    if (play.mode === 'show' && play.index + 1 < play.list.length) {
      play.index += 1;
      return load(play.list[play.index]);
    }
    stopPlayback();
  }

  function stopPlayback() {
    if (play && play.item && !media.ended()) saveProgress(false);
    play = null;
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
    showOsd();
  }
  function togglePause() {
    if (media.paused()) media.play(); else media.pause();
    updateOsd();
    showOsd();
  }

  media.on('time', function () {
    updateOsd();
    if (play && Date.now() - play.lastSave > SAVE_EVERY) saveProgress(false);
  });
  media.on('ended', function () { next('ended'); });
  media.on('error', function () {
    if (!play) return;
    status('⚠ Could not play ' + (play.item ? play.item.title : 'that video'));
    // A file the TV cannot decode teaches nothing; channels move on, single files return home.
    if (play.mode === 'channel') startChannel(play.channel, null); else stopPlayback();
  });
  media.on('pause', function () { updateOsd(); showOsd(); });
  video.addEventListener('click', togglePause);
  $('osd-next').addEventListener('click', function () { next('skip'); });

  // ---------- keys ----------
  document.addEventListener('keydown', function (event) {
    var key = event.keyCode;
    if (!$('setup').hidden) return;
    var playing = !$('player').hidden;
    if (playing) {
      if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE || key === KEY.STOP) stopPlayback();
      else if (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) togglePause();
      else if (key === KEY.PLAY) { media.play(); showOsd(); }
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
      } else if (key === KEY.BACK && window.tizen) { try { tizen.application.getCurrentApplication().exit(); } catch (e) {} }
      else return;
    }
    event.preventDefault();
  });

  // Media keys reach the app only once registered (Tizen).
  if (window.tizen && tizen.tvinputdevice) {
    ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'MediaTrackNext', 'MediaTrackPrevious', 'ChannelUp', 'ChannelDown'].forEach(function (name) {
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
    if (play) stopPlayback();
    page = null;
    openShow = null;
    focus = { row: 0, col: 0 };
    render();
  };

  loadHome();
})();
