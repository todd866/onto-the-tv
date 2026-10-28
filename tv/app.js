/* Onto the TV, TV side. Runs in a Samsung TV's web engine (Tizen 4+, Chromium 56+),
   so it sticks to ES2017: no optional chaining, no nullish coalescing. */
(function () {
  'use strict';
  var SERVER = (function () {
    try { var saved = localStorage.getItem('onto.server'); if (saved) return saved.replace(/\/$/, ''); } catch (e) {}
    if (window.ONTO_SERVER) return window.ONTO_SERVER;
    return location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : '';
  })();
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
  var openShow = null;      // { name, episodes } while the shows row lists one show's episodes
  var play = null;          // { mode: 'channel'|'show'|'single', channel, list, index, item, visitStart, lastSave }
  var osdTimer = 0;

  function api(path, options) {
    return fetch(SERVER + path, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || ('Server error ' + response.status));
        return body;
      });
    });
  }
  function q(value) { return encodeURIComponent(value); }
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
    if (kind === 'channel') {
      art.textContent = ICONS[item.id] || '📺';
      name.textContent = item.label;
      count.textContent = item.count;
    } else if (kind === 'show') {
      art.style.backgroundImage = 'url("' + SERVER + '/art?src=' + q(item.src) + '")';
      name.textContent = item.name;
      count.textContent = item.count;
    } else {
      art.style.backgroundImage = 'url("' + SERVER + '/art?src=' + q(item.src) + '")';
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
    items.forEach(function (item) { el.appendChild(tile(item, kind)); });
  }

  function render() {
    fill($('channels'), data.channels, 'channel');
    fill($('continue'), data.continueWatching, 'episode');
    $('continue-row').hidden = !data.continueWatching.length;
    if (openShow) {
      $('shows-title').textContent = openShow.name;
      fill($('shows'), openShow.episodes, 'episode');
    } else {
      $('shows-title').textContent = 'Shows';
      fill($('shows'), data.shows, 'show');
    }
    rows = [{ el: $('channels'), items: data.channels, kind: 'channel' }];
    if (data.continueWatching.length) rows.push({ el: $('continue'), items: data.continueWatching, kind: 'continue' });
    rows.push({ el: $('shows'), items: openShow ? openShow.episodes : data.shows, kind: openShow ? 'episode' : 'show' });
    focus.row = Math.min(focus.row, rows.length - 1);
    moveFocus(0, 0);
  }

  function caption(row, item) {
    if (!item) return '';
    if (row.kind === 'channel') return item.label + ' · ' + item.count + ' videos';
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
    if (row.kind === 'channel') return startChannel(item);
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
    return api('/api/home').then(function (home) { data = home; render(); }).catch(fail);
  }
  function fail(error) { status('⚠ ' + error.message); }

  // ---------- playback ----------
  function showOsd() {
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { if (!video.paused) osd.classList.add('hidden'); }, OSD_MS);
  }
  function updateOsd() {
    if (!play || !play.item) return;
    var duration = video.duration || play.item.duration || 0;
    $('osd-show').textContent = play.item.show;
    $('osd-episode').textContent = play.item.title;
    $('osd-channel').textContent = play.channel ? play.channel.label : '';
    $('osd-elapsed').textContent = clock(video.currentTime);
    $('osd-duration').textContent = clock(duration);
    $('osd-fill').style.width = duration ? Math.min(100, 100 * video.currentTime / duration) + '%' : '0';
    $('osd-play').textContent = video.paused ? '▶' : '⏸';
    $('osd-next').hidden = play.mode === 'single';
  }

  function load(item) {
    play.item = item;
    play.visitStart = item.resume || 0;
    play.lastSave = Date.now();
    $('home').hidden = true;
    $('player').hidden = false;
    video.src = SERVER + '/media?src=' + q(item.src);
    video.load();
    var start = function () {
      video.removeEventListener('loadedmetadata', start);
      if (item.resume) video.currentTime = item.resume;
      video.play();
    };
    video.addEventListener('loadedmetadata', start);
    updateOsd();
    showOsd();
  }

  function startChannel(channel, fromItem, reason) {
    play = play && play.channel === channel ? play : { mode: 'channel', channel: channel };
    var query = '/api/next?channel=' + q(channel.id);
    if (fromItem) {
      query += '&current=' + q(fromItem.src) + '&reason=' + reason + '&time=' + Math.floor(video.currentTime || 0) +
        '&watched=' + Math.floor(Math.max(0, (video.currentTime || 0) - play.visitStart)) +
        '&duration=' + Math.floor(video.duration || fromItem.duration || 0);
    }
    return api(query).then(load).catch(function (error) { stopPlayback(); fail(error); });
  }

  function startList(mode, list, index) {
    play = { mode: mode, list: list, index: index };
    load(list[index]);
  }

  function saveProgress(completed) {
    if (!play || !play.item || !isFinite(video.currentTime)) return;
    play.lastSave = Date.now();
    api('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: play.item.src, positionSeconds: completed ? 0 : video.currentTime,
        durationSeconds: isFinite(video.duration) ? video.duration : 0, completed: !!completed }) }).catch(function () {});
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
    if (play && play.item && !video.ended) saveProgress(false);
    play = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    $('player').hidden = true;
    $('home').hidden = false;
    loadHome();
  }

  function seek(seconds) {
    if (!isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + seconds));
    showOsd();
  }
  function togglePause() {
    if (video.paused) video.play(); else video.pause();
    updateOsd();
    showOsd();
  }

  video.addEventListener('timeupdate', function () {
    updateOsd();
    if (play && Date.now() - play.lastSave > SAVE_EVERY) saveProgress(false);
  });
  video.addEventListener('ended', function () { next('ended'); });
  video.addEventListener('error', function () {
    if (!play) return;
    status('⚠ Could not play ' + (play.item ? play.item.title : 'that video'));
    // A file the TV cannot decode teaches nothing; channels move on, single files return home.
    if (play.mode === 'channel') startChannel(play.channel, null); else stopPlayback();
  });
  video.addEventListener('pause', function () { updateOsd(); showOsd(); });

  // ---------- keys ----------
  document.addEventListener('keydown', function (event) {
    var key = event.keyCode;
    var playing = !$('player').hidden;
    if (playing) {
      if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE || key === KEY.STOP) stopPlayback();
      else if (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) togglePause();
      else if (key === KEY.PLAY) { video.play(); showOsd(); }
      else if (key === KEY.PAUSE) { video.pause(); showOsd(); }
      else if (key === KEY.LEFT || key === KEY.RW) seek(-SEEK);
      else if (key === KEY.RIGHT || key === KEY.FF) seek(SEEK);
      else if (key === KEY.NEXT || key === KEY.CH_UP || key === KEY.DOWN) next('skip');
      else if (key === KEY.PREV || key === KEY.CH_DOWN) { video.currentTime = 0; showOsd(); }
      else if (key === KEY.UP) showOsd();
      else return;
    } else {
      if (key === KEY.LEFT) moveFocus(0, -1);
      else if (key === KEY.RIGHT) moveFocus(0, 1);
      else if (key === KEY.UP) moveFocus(-1, 0);
      else if (key === KEY.DOWN) moveFocus(1, 0);
      else if (key === KEY.ENTER) select();
      else if ((key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) && openShow) {
        var name = openShow.name;
        openShow = null;
        render();
        focus.col = Math.max(0, data.shows.map(function (show) { return show.name; }).indexOf(name));
        moveFocus(0, 0);
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
    if (document.hidden && play) { saveProgress(false); video.pause(); }
  });

  loadHome();
})();
