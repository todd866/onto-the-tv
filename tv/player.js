/* One playback interface over two engines. The installed TV app uses Samsung's AVPlay,
   which plays everything the TV's own player does (MKV, HEVC, Dolby Digital). A browser
   uses the <video> element. ES2017, as app.js. */
window.ontoPlayer = function (video, avObject) {
  'use strict';
  var handlers = {};
  function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }
  function emit(name) { (handlers[name] || []).forEach(function (fn) { fn(); }); }
  function videoTracks() {
    var audio = [], text = [], i, list, track;
    list = video.audioTracks;
    if (list) {
      for (i = 0; i < list.length; i++) {
        track = list[i];
        audio.push({ index: i, label: track.label || track.language || String(i + 1) });
      }
    }
    list = video.textTracks;
    if (list) {
      for (i = 0; i < list.length; i++) {
        track = list[i];
        if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
        text.push({ index: i, label: track.label || track.language || String(i + 1), language: track.language || '' });
      }
    }
    return { audio: audio, text: text };
  }
  function selectVideoAudio(index) {
    var list = video.audioTracks, i;
    if (!list) return;
    for (i = 0; i < list.length; i++) {
      try { list[i].enabled = i === index; } catch (e) {}
    }
  }
  function selectVideoText(index) {
    var list = video.textTracks, i;
    if (!list) return;
    for (i = 0; i < list.length; i++) list[i].mode = i === index ? 'showing' : 'disabled';
  }

  if (!(window.webapis && webapis.avplay && avObject)) {
    var VIDEO_STALL_MS = 25000, videoStallTimer = 0, pendingBegin = null;
    function clearVideoStall() { if (videoStallTimer) { clearTimeout(videoStallTimer); videoStallTimer = 0; } }
    function clearPendingBegin() {
      if (pendingBegin) { video.removeEventListener('loadedmetadata', pendingBegin); pendingBegin = null; }
    }
    function safeVideoPlay() {
      try {
        var p = video.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }
    video.addEventListener('timeupdate', function () { if (video.currentTime > 0) clearVideoStall(); emit('time'); });
    video.addEventListener('playing', function () { clearVideoStall(); });
    video.addEventListener('ended', function () { clearVideoStall(); emit('ended'); });
    video.addEventListener('error', function () { clearVideoStall(); emit('error'); });
    video.addEventListener('pause', function () { emit('pause'); });
    return {
      engine: 'video', on: on,
      load: function (url, start) {
        clearVideoStall();
        clearPendingBegin();
        video.src = url;
        video.load();
        pendingBegin = function () {
          clearPendingBegin();
          if (start) video.currentTime = start;
          safeVideoPlay();
        };
        video.addEventListener('loadedmetadata', pendingBegin);
        videoStallTimer = setTimeout(function () {
          videoStallTimer = 0;
          if (video.paused && video.readyState >= 2) return;
          clearPendingBegin();
          try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
          emit('error');
        }, VIDEO_STALL_MS);
      },
      play: function () { safeVideoPlay(); },
      pause: function () { video.pause(); },
      paused: function () { return video.paused; },
      time: function () { return isFinite(video.currentTime) ? video.currentTime : 0; },
      duration: function () { return isFinite(video.duration) ? video.duration : 0; },
      seek: function (seconds) { video.currentTime = seconds; },
      ended: function () { return video.ended; },
      stop: function () { clearVideoStall(); clearPendingBegin(); video.pause(); video.removeAttribute('src'); video.load(); },
      suspend: function () { video.pause(); },
      restore: function () {},
      subtitle: function () { return ''; },
      tracks: videoTracks,
      selectAudio: selectVideoAudio,
      selectText: selectVideoText,
    };
  }

  var av = webapis.avplay;
  var state = { paused: true, ended: false, time: 0, duration: 0 };
  video.hidden = true;
  avObject.hidden = false;
  // AVPlay can sit in prepareAsync forever without calling either callback (21 Nov 2026: the next title
  // after an ended one hung 'buffering' for an hour, and the channel never moved on). A load that has not
  // played a frame in STALL_MS becomes an error, so the channel's retry-then-move-on line takes over.
  var STALL_MS = 25000, stallTimer = 0, tracksCache = null, prepared = false, subText = '', subTimer = 0;
  function clearStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; } }
  function setSub(text, durationMs) {
    if (subTimer) { clearTimeout(subTimer); subTimer = 0; }
    var cleaned = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    if (cleaned === subText && !durationMs) return;
    subText = cleaned;
    emit('subtitle');
    if (subText && durationMs > 0) {
      subTimer = setTimeout(function () { subTimer = 0; subText = ''; emit('subtitle'); }, durationMs);
    }
  }
  function close() { clearStall(); setSub('', 0); seekBusy = 0; seekWanted = -1; tracksCache = null; prepared = false; try { av.stop(); } catch (e) {} try { av.close(); } catch (e) {} }
  // Seeks run asynchronously (with callbacks): without them seekTo blocks until the TV has found the frame, and the
  // remote's Left / Right took 130-220 ms at p50 and up to 4.7 s to answer (remote-events.jsonl, 21 Nov 2026).
  // One seek is in flight at a time; taps that arrive meanwhile collapse into the latest target.
  var seekBusy = 0, seekWanted = -1;
  function seekNow(ms) {
    seekBusy = Date.now();
    var done = function () {
      seekBusy = 0;
      if (seekWanted >= 0) { var next = seekWanted; seekWanted = -1; seekNow(next); }
    };
    try { av.seekTo(ms, done, done); } catch (e) { seekBusy = 0; }
  }
  return {
    engine: 'avplay', on: on,
    load: function (url, start) {
      close();
      state = { paused: false, ended: false, time: start || 0, duration: 0 };
      try {
        av.open(url);
        try {
          if (window.webapis && webapis.productinfo && typeof webapis.productinfo.isUdPanelSupported === 'function' && webapis.productinfo.isUdPanelSupported()) {
            if (av.setStreamingProperty) av.setStreamingProperty('SET_MODE_4K', 'TRUE');
          }
        } catch (e4k) {}
        av.setDisplayRect(0, 0, 1920, 1080);
        try {
          if (av.setDisplayMethod) av.setDisplayMethod('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO');
        } catch (eAspect) {
          try { if (av.setDisplayMethod) av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (eBox) {}
        }
        try { if (av.setTimeoutForBuffering) av.setTimeoutForBuffering(4); } catch (eBuf) {}
        av.setListener({
          // While a seek is in flight the TV still reports the old position; the target stands until it lands,
          // so held Left / Right keep stepping from where they asked for, not from where the picture was.
          oncurrentplaytime: function (ms) { clearStall(); if (seekBusy && Date.now() - seekBusy < 5000) return; state.time = ms / 1000; emit('time'); },
          onstreamcompleted: function () { state.ended = true; emit('ended'); },
          onerror: function () { clearStall(); emit('error'); },
          onbufferingstart: function () {}, onbufferingprogress: function () {}, onbufferingcomplete: function () {},
          onevent: function () {},
          onsubtitlechange: function (duration, text) { setSub(text, Number(duration) || 0); },
          ondrmevent: function () {},
        });
        stallTimer = setTimeout(function () {
          stallTimer = 0;
          if (state.paused) return; // paused before the first frame: the listener is in charge
          close(); emit('error');
        }, STALL_MS);
        av.prepareAsync(function () {
          prepared = true;
          state.duration = av.getDuration() / 1000;
          var go = function () { av.play(); emit('time'); };
          if (start) av.seekTo(Math.floor(start * 1000), go, go); else go();
        }, function () { clearStall(); emit('error'); });
      } catch (e) { setTimeout(function () { emit('error'); }, 0); }
    },
    play: function () { try { av.play(); state.paused = false; } catch (e) {} emit('pause'); },
    pause: function () { try { av.pause(); state.paused = true; } catch (e) {} emit('pause'); },
    paused: function () { return state.paused; },
    time: function () { return state.time; },
    duration: function () { return state.duration; },
    seek: function (seconds) {
      var ms = Math.floor(seconds * 1000);
      state.time = seconds;
      if (subText) setSub('', 0);
      // A seek whose callbacks never came back (5 s) does not hold up the next one.
      if (seekBusy && Date.now() - seekBusy < 5000) seekWanted = ms;
      else seekNow(ms);
      emit('time');
    },
    ended: function () { return state.ended; },
    stop: function () { close(); state.paused = true; },
    suspend: function () {
      try { if (av.suspend) av.suspend(); else av.pause(); state.paused = true; } catch (e) {}
      emit('pause');
    },
    restore: function (url, resumeAt, playNow) {
      try {
        if (av.restore) {
          av.restore(url || '', Math.floor((resumeAt || state.time || 0) * 1000), !!playNow);
          state.paused = !playNow;
          emit('pause');
          return;
        }
      } catch (e) {}
      if (playNow) { try { av.play(); state.paused = false; emit('pause'); } catch (e2) {} }
    },
    tracks: function () {
      if (tracksCache) return tracksCache;
      var audio = [], text = [], info = [], i, item, label, extra, out;
      try { info = av.getTotalTrackInfo() || []; } catch (e) { info = []; }
      for (i = 0; i < info.length; i++) {
        item = info[i] || {};
        label = '';
        extra = item.extra_info;
        if (typeof extra === 'string' && extra.charAt(0) === '{') {
          try {
            var parsed = JSON.parse(extra);
            label = parsed.language || parsed.track_lang || '';
          } catch (e2) {}
        } else if (typeof extra === 'string') label = extra;
        if (!label) label = String((item.index || 0) + 1);
        if (item.type === 'AUDIO') audio.push({ index: item.index, label: label });
        if (item.type === 'TEXT') text.push({ index: item.index, label: label, language: label });
      }
      out = { audio: audio, text: text };
      if (prepared || info.length > 0) tracksCache = out;
      return out;
    },
    subtitle: function () { return subText; },
    selectAudio: function (index) { try { av.setSelectTrack('AUDIO', index); } catch (e) {} },
    selectText: function (index) {
      try {
        if (index < 0) {
          setSub('', 0);
          if (av.setSilentSubtitle) av.setSilentSubtitle(true);
        } else {
          if (av.setSilentSubtitle) av.setSilentSubtitle(false);
          av.setSelectTrack('TEXT', index);
        }
      } catch (e) {}
    },
  };
};

/* Countdown, resume, seek steps, skip chip and the failed-stream line.
   ES5: the TV's Chromium 47. The media engines above stay as they are. */
window.ontoPlayerExtras = (function () {
  var UP_NEXT_SECONDS = 10;
  var ERROR_SECONDS = 5;

  function clock(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function episodeParts(text) {
    var match, rest;
    text = String(text || '');
    match = /(?:series|season)\s*(\d+)\s*(?:episode|ep\.?|e)\s*(\d+)/i.exec(text);
    if (!match) match = /\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(text);
    if (!match) return null;
    rest = text.slice(match.index + match[0].length);
    rest = rest.replace(/^[\s.:·\-–—|]+/, '').replace(/[\s.·\-]+$/, '');
    rest = rest.replace(/\b(?:720p|1080p|2160p|x26[45]|hevc|web-?rip|blu-?ray|brrip|aac|dvdrip)\b.*$/i, '').trim();
    return { code: 'S' + Number(match[1]) + 'E' + Number(match[2]), title: rest };
  }

  function isSerial(item) {
    if (!item) return false;
    return !!(episodeParts(item.title) || episodeParts(item.src));
  }

  function upNextLabel(item) {
    var parts;
    if (!item) return '';
    parts = episodeParts(item.title) || episodeParts(item.src);
    if (!parts) return '';
    if (parts.title) return 'Next · ' + parts.code + ' · ' + parts.title;
    return 'Next · ' + parts.code;
  }

  function offerUpNext(current, nextItem) {
    var showA, showB;
    if (!isSerial(current) || !nextItem) return '';
    if (current.src && nextItem.src && current.src === nextItem.src) return '';
    showA = String(current.show || '').toLowerCase();
    showB = String(nextItem.show || '').toLowerCase();
    if (showA && showB && showA !== showB) return '';
    return upNextLabel(nextItem);
  }

  function upNextDue(time, duration, segments) {
    var i, seg, left;
    segments = segments || [];
    for (i = 0; i < segments.length; i++) {
      seg = segments[i];
      if (!seg) continue;
      if ((seg.kind === 'outro' || seg.kind === 'credits') && time >= seg.start && time < seg.end) return true;
    }
    if (!(duration > 0)) return false;
    left = duration - time;
    return left <= UP_NEXT_SECONDS && left > 0;
  }

  function upNext() {
    var left = 0, on = false, dismissed = false;
    return {
      arm: function () {
        if (dismissed || on) return false;
        on = true;
        left = UP_NEXT_SECONDS;
        return true;
      },
      read: function () { return left; },
      active: function () { return on; },
      tick: function () {
        if (!on) return '';
        left -= 1;
        if (left <= 0) { left = 0; on = false; return 'play'; }
        return 'show';
      },
      ok: function () {
        if (!on) return '';
        on = false;
        left = 0;
        return 'play';
      },
      back: function () {
        if (!on) return '';
        on = false;
        dismissed = true;
        left = 0;
        return 'cancel';
      },
      reset: function () { on = false; dismissed = false; left = 0; }
    };
  }

  function clampTime(time, duration) {
    if (time < 0) time = 0;
    if (duration > 5 && time > duration - 5) time = duration - 5;
    else if (duration > 1 && time > duration - 1) time = duration - 1;
    return time;
  }

  function seekTapStepSize(tapIndex) {
    return tapIndex < 1 ? 10 : tapIndex < 2 ? 30 : tapIndex < 3 ? 60 : 300;
  }

  function seekHoldStepSize(holdIndex) {
    return holdIndex < 4 ? 10 : holdIndex < 12 ? 30 : holdIndex < 24 ? 60 : 300;
  }

  function seek() {
    var origin = null, offset = 0, taps = 0, sign = 0, lastAt = 0;
    var BURST_MS = 1500;
    return {
      tap: function (time, duration, direction, now) {
        var dir = direction < 0 ? -1 : 1, size, stamp = now || 0;
        if (origin === null || (stamp && lastAt && stamp - lastAt > BURST_MS)) {
          origin = time; offset = 0; taps = 0; sign = dir;
        } else if (sign !== dir) {
          origin = clampTime(origin + offset, duration);
          offset = 0; taps = 0; sign = dir;
        }
        size = seekTapStepSize(taps);
        taps += 1;
        offset += dir * size;
        if (stamp) lastAt = stamp;
        return clampTime(origin + offset, duration);
      },
      hold: function (time, duration, direction, holdIndex) {
        var step = seekHoldStepSize(holdIndex == null ? 0 : holdIndex);
        return clampTime(time + (direction < 0 ? -step : step), duration);
      },
      delta: function () { return offset; },
      clear: function () { origin = null; offset = 0; taps = 0; sign = 0; lastAt = 0; }
    };
  }

  function resumeOffer(seconds) { return (seconds || 0) > 5; }
  function resumeLabel(seconds) { return 'Resume ' + clock(seconds); }
  function resumeMove(index, direction) {
    var next = index + direction;
    if (next < 0) next = 1;
    if (next > 1) next = 0;
    return next;
  }
  function resumeAction(index) { return index === 1 ? 'start' : 'resume'; }

  function skipChip(time, segments) {
    var i, seg, label;
    if (!segments) return null;
    for (i = 0; i < segments.length; i++) {
      seg = segments[i];
      if (!seg || time < seg.start || time >= seg.end) continue;
      if (seg.kind === 'intro') label = 'Skip intro';
      else if (seg.kind === 'outro' || seg.kind === 'credits') label = 'Skip credits';
      else continue;
      return { label: label, end: seg.end };
    }
    return null;
  }

  function errorLine() {
    var left = ERROR_SECONDS, on = true, done = '';
    return {
      arm: function () { on = true; done = ''; left = ERROR_SECONDS; },
      read: function () { return left; },
      text: function () { return 'next in ' + left + 's'; },
      tick: function (channel) {
        if (!on && done) return done;
        if (!on) return '';
        left -= 1;
        if (left > 0) return 'wait';
        left = 0;
        on = false;
        done = channel ? 'next' : 'stay';
        return done;
      },
      retry: function () { on = false; done = ''; return 'retry'; }
    };
  }

  function el(doc, id) { return doc.getElementById(id); }

  function install(doc) {
    var player, track, keys, seekMark, root;
    if (!doc || el(doc, 'up-next')) return;
    player = el(doc, 'player');
    if (!player) return;
    root = doc.createElement('div');
    root.id = 'up-next';
    root.hidden = true;
    root.innerHTML = '<button type="button" id="up-next-play" class="focused">' +
      '<span class="glyph" aria-hidden="true"><svg viewBox="0 0 48 48"><path fill="currentColor" d="M14 8 L38 24 L14 40 Z"/></svg></span>' +
      '<span id="up-next-label"></span><span id="up-next-count">10</span></button>';
    player.appendChild(root);
    root = doc.createElement('div');
    root.id = 'resume-choice';
    root.hidden = true;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Resume');
    root.innerHTML = '<button type="button" id="resume-play" class="focused">Resume</button>' +
      '<button type="button" id="resume-start">Start over</button>';
    player.appendChild(root);
    root = doc.createElement('div');
    root.id = 'play-error';
    root.hidden = true;
    root.setAttribute('role', 'status');
    root.innerHTML = '<button type="button" id="play-retry" class="focused">Retry</button><span id="play-error-next">next in 5s</span>';
    player.appendChild(root);
    track = el(doc, 'osd-track');
    if (track && !el(doc, 'osd-seek')) {
      seekMark = doc.createElement('div');
      seekMark.id = 'osd-seek';
      seekMark.hidden = true;
      track.appendChild(seekMark);
    }
    keys = el(doc, 'osd-keys');
    if (keys && !el(doc, 'osd-cc')) {
      keys.insertAdjacentHTML('beforeend',
        '<button type="button" id="osd-cc" hidden><span class="k">CC</span><span class="v" id="osd-cc-value">Off</span></button>' +
        '<button type="button" id="osd-audio" hidden><span class="k">Audio</span><span class="v" id="osd-audio-value"></span></button>');
    }
    if (!el(doc, 'av-subs')) {
      root = doc.createElement('div');
      root.id = 'av-subs';
      root.hidden = true;
      root.setAttribute('aria-hidden', 'true');
      player.appendChild(root);
    }
  }

  function vttSeconds(raw) {
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(String(raw || '').trim());
    if (!m) return -1;
    var ms = m[4];
    while (ms.length < 3) ms += '0';
    return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + Number(ms) / 1000;
  }

  function decodeSubEntities(text) {
    return String(text || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  function parseVtt(text) {
    var body = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var blocks = body.split(/\n{2,}/), cues = [], i, lines, idx, arrow, start, end, cueText;
    for (i = 0; i < blocks.length; i++) {
      lines = blocks[i].split('\n');
      idx = 0;
      while (idx < lines.length && !lines[idx].trim()) idx++;
      if (idx >= lines.length || /^WEBVTT\b/i.test(lines[idx]) || /^NOTE\b/.test(lines[idx]) || /^STYLE\b/.test(lines[idx])) continue;
      if (lines[idx].indexOf('-->') === -1) idx++;
      if (idx >= lines.length || lines[idx].indexOf('-->') === -1) continue;
      arrow = lines[idx].split('-->');
      start = vttSeconds(arrow[0]);
      end = vttSeconds(String(arrow[1] || '').trim().split(/\s+/)[0]);
      if (start < 0 || end <= start) continue;
      cueText = decodeSubEntities(lines.slice(idx + 1).join('\n'));
      if (cueText) cues.push({ start: start, end: end, text: cueText });
    }
    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return cues;
  }

  function activeCue(cues, seconds) {
    if (!cues || !cues.length || !(seconds >= 0)) return '';
    var lo = 0, hi = cues.length - 1, mid, from, out = [], i;
    while (lo <= hi) {
      mid = (lo + hi) >> 1;
      if (cues[mid].start <= seconds) lo = mid + 1;
      else hi = mid - 1;
    }
    from = Math.max(0, lo - 8);
    for (i = from; i < lo; i++) {
      if (seconds >= cues[i].start && seconds < cues[i].end) out.push(cues[i].text);
    }
    return out.join('\n');
  }

  return {
    clock: clock,
    isSerial: isSerial,
    upNextLabel: upNextLabel,
    offerUpNext: offerUpNext,
    upNextDue: upNextDue,
    upNext: upNext,
    seek: seek,
    seekTapStepSize: seekTapStepSize,
    seekHoldStepSize: seekHoldStepSize,
    resumeOffer: resumeOffer,
    resumeLabel: resumeLabel,
    resumeMove: resumeMove,
    resumeAction: resumeAction,
    skipChip: skipChip,
    errorLine: errorLine,
    parseVtt: parseVtt,
    activeCue: activeCue,
    install: install
  };
}());
