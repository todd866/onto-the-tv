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
    video.addEventListener('timeupdate', function () { emit('time'); });
    video.addEventListener('ended', function () { emit('ended'); });
    video.addEventListener('error', function () { emit('error'); });
    video.addEventListener('pause', function () { emit('pause'); });
    return {
      engine: 'video', on: on,
      load: function (url, start) {
        video.src = url;
        video.load();
        var begin = function () {
          video.removeEventListener('loadedmetadata', begin);
          if (start) video.currentTime = start;
          video.play();
        };
        video.addEventListener('loadedmetadata', begin);
      },
      play: function () { video.play(); },
      pause: function () { video.pause(); },
      paused: function () { return video.paused; },
      time: function () { return isFinite(video.currentTime) ? video.currentTime : 0; },
      duration: function () { return isFinite(video.duration) ? video.duration : 0; },
      seek: function (seconds) { video.currentTime = seconds; },
      ended: function () { return video.ended; },
      stop: function () { video.pause(); video.removeAttribute('src'); video.load(); },
      tracks: videoTracks,
      selectAudio: selectVideoAudio,
      selectText: selectVideoText,
    };
  }

  var av = webapis.avplay;
  var state = { paused: true, ended: false, time: 0, duration: 0 };
  video.hidden = true;
  avObject.hidden = false;
  function close() { try { av.stop(); } catch (e) {} try { av.close(); } catch (e) {} }
  return {
    engine: 'avplay', on: on,
    load: function (url, start) {
      close();
      state = { paused: false, ended: false, time: start || 0, duration: 0 };
      try {
        av.open(url);
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setListener({
          oncurrentplaytime: function (ms) { state.time = ms / 1000; emit('time'); },
          onstreamcompleted: function () { state.ended = true; emit('ended'); },
          onerror: function () { emit('error'); },
          onbufferingstart: function () {}, onbufferingprogress: function () {}, onbufferingcomplete: function () {},
          onevent: function () {}, onsubtitlechange: function () {}, ondrmevent: function () {},
        });
        av.prepareAsync(function () {
          state.duration = av.getDuration() / 1000;
          var go = function () { av.play(); emit('time'); };
          if (start) av.seekTo(Math.floor(start * 1000), go, go); else go();
        }, function () { emit('error'); });
      } catch (e) { setTimeout(function () { emit('error'); }, 0); }
    },
    play: function () { try { av.play(); state.paused = false; } catch (e) {} emit('pause'); },
    pause: function () { try { av.pause(); state.paused = true; } catch (e) {} emit('pause'); },
    paused: function () { return state.paused; },
    time: function () { return state.time; },
    duration: function () { return state.duration; },
    seek: function (seconds) {
      try { av.seekTo(Math.floor(seconds * 1000)); state.time = seconds; } catch (e) {}
      emit('time');
    },
    ended: function () { return state.ended; },
    stop: function () { close(); state.paused = true; },
    tracks: function () {
      var audio = [], text = [], info = [], i, item, label, extra;
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
      return { audio: audio, text: text };
    },
    selectAudio: function (index) { try { av.setSelectTrack('AUDIO', index); } catch (e) {} },
    selectText: function (index) {
      try {
        if (index < 0 && av.setSilentSubtitle) av.setSilentSubtitle(true);
        else {
          if (av.setSilentSubtitle) av.setSilentSubtitle(false);
          if (index >= 0) av.setSelectTrack('TEXT', index);
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
    if (duration > 1 && time > duration - 1) time = duration - 1;
    return time;
  }

  function seek() {
    var origin = null, steps = 0;
    return {
      tap: function (time, duration, direction) {
        if (origin === null) origin = time;
        steps += direction < 0 ? -1 : 1;
        return clampTime(origin + steps * 10, duration);
      },
      hold: function (time, duration, direction) {
        origin = null;
        steps = 0;
        return clampTime(time + (direction < 0 ? -30 : 30), duration);
      },
      clear: function () { origin = null; steps = 0; }
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
  }

  return {
    clock: clock,
    isSerial: isSerial,
    upNextLabel: upNextLabel,
    offerUpNext: offerUpNext,
    upNextDue: upNextDue,
    upNext: upNext,
    seek: seek,
    resumeOffer: resumeOffer,
    resumeLabel: resumeLabel,
    resumeMove: resumeMove,
    resumeAction: resumeAction,
    skipChip: skipChip,
    errorLine: errorLine,
    install: install
  };
}());
