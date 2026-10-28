/* One playback interface over two engines. The installed TV app uses Samsung's AVPlay,
   which plays everything the TV's own player does (MKV, HEVC, Dolby Digital). A browser
   uses the <video> element. ES2017, as app.js. */
window.ontoPlayer = function (video, avObject) {
  'use strict';
  var handlers = {};
  function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }
  function emit(name) { (handlers[name] || []).forEach(function (fn) { fn(); }); }

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
  };
};
