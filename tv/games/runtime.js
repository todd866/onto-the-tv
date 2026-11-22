/* Number Snake on the TV. ES2017: the page also runs in the Samsung browser.
   The wasm module writes a flat draw list; this file only reads pads and paints. */
(function () {
  'use strict';
  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  // Indices are the colour field in the draw buffer.
  var COLOURS = ['#000000', '#14161c', '#ff4b4b', '#3ee07a', '#4aa3ff', '#ffcc33', '#f7f1e5', '#1b1b1b',
    '#ffe566', '#ffb547', '#ffffff', '#ff5ad1', '#5af0ff', '#c6ff4a', '#ff8a3d', '#d9d4ff'];
  var P1 = { ArrowUp: 1, ArrowRight: 2, ArrowDown: 3, ArrowLeft: 4 };
  var P2 = { w: 1, W: 1, d: 2, D: 2, s: 3, S: 3, a: 4, A: 4 };
  var keys = {};
  var keyOrder = [];
  var prevDir = [0, 0, 0, 0];
  var prevA = [false, false, false, false];
  var prevBack = [false, false, false, false];
  var apiRef = null;

  // A tap can end before the next frame samples the keyboard, so directions apply on keydown.
  function noteKey(name) {
    if (!apiRef) return;
    var dir = P1[name];
    var player = 0;
    if (!dir) { dir = P2[name]; player = 1; }
    if (dir) {
      apiRef.game_input(player, dir, 0);
      prevDir[player] = dir;
    }
    if (name === 'Enter' || name === ' ' || name === 'Spacebar') {
      apiRef.game_input(0, 0, 1);
      prevA[0] = true;
    }
  }

  window.ontoHome = function () { location.href = '/'; };

  function goHome() { location.href = '/'; }

  // Older TV browsers report keyCode and an empty key.
  function nameOf(event) {
    if (event.key && event.key !== 'Unidentified') return event.key;
    var code = event.keyCode;
    if (code === 38) return 'ArrowUp';
    if (code === 39) return 'ArrowRight';
    if (code === 40) return 'ArrowDown';
    if (code === 37) return 'ArrowLeft';
    if (code === 87) return 'w';
    if (code === 65) return 'a';
    if (code === 83) return 's';
    if (code === 68) return 'd';
    if (code === 13) return 'Enter';
    if (code === 32) return ' ';
    if (code === 27 || code === 8 || code === 10009) return 'Escape';
    return '';
  }

  document.addEventListener('keydown', function (event) {
    var name = nameOf(event);
    if (name === 'Escape' || name === 'Backspace') {
      event.preventDefault();
      goHome();
      return;
    }
    if (!name || keys[name]) {
      event.preventDefault();
      return;
    }
    noteKey(name);
    keys[name] = true;
    keyOrder.push(name);
    event.preventDefault();
  });
  document.addEventListener('keyup', function (event) {
    var name = nameOf(event);
    keys[name] = false;
    var next = [];
    for (var i = 0; i < keyOrder.length; i++) if (keyOrder[i] !== name) next.push(keyOrder[i]);
    keyOrder = next;
  });

  function dirFromKeys(map) {
    for (var i = keyOrder.length - 1; i >= 0; i--) if (map[keyOrder[i]]) return map[keyOrder[i]];
    return 0;
  }

  function padPressed(pad, index) {
    return !!(pad.buttons[index] && pad.buttons[index].pressed);
  }

  // Standard mapping: 12–15 are the d-pad, axes 0/1 the left stick. D-pad wins.
  function dirFromPad(pad) {
    if (padPressed(pad, 12)) return 1;
    if (padPressed(pad, 15)) return 2;
    if (padPressed(pad, 13)) return 3;
    if (padPressed(pad, 14)) return 4;
    var x = pad.axes && pad.axes.length > 0 ? pad.axes[0] : 0;
    var y = pad.axes && pad.axes.length > 1 ? pad.axes[1] : 0;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return 0;
    if (Math.abs(x) > Math.abs(y)) return x > 0 ? 2 : 4;
    return y > 0 ? 3 : 1;
  }

  function poll(api) {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    var padDir = [0, 0, 0, 0];
    var padA = [false, false, false, false];
    var seen = 0;
    for (var i = 0; pads && i < pads.length && seen < 4; i++) {
      var pad = pads[i];
      if (!pad) continue;
      padDir[seen] = dirFromPad(pad);
      padA[seen] = padPressed(pad, 0);
      var back = padPressed(pad, 8);
      if (back && !prevBack[seen]) goHome();
      prevBack[seen] = back;
      seen++;
    }
    var keyDir = [dirFromKeys(P1), dirFromKeys(P2), 0, 0];
    var keyA = !!(keys.Enter || keys[' '] || keys.Spacebar);
    for (var p = 0; p < 4; p++) {
      var dir = padDir[p] || keyDir[p] || 0;
      var button = padA[p] || (p === 0 && keyA);
      if (dir && dir !== prevDir[p]) api.game_input(p, dir, 0);
      if (button && !prevA[p]) api.game_input(p, 0, 1);
      prevDir[p] = dir;
      prevA[p] = button;
    }
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth || 1920;
    var h = window.innerHeight || 1080;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }

  function roundRect(x, y, w, h, r) {
    var radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawNumber(x, y, w, h, colour, value) {
    var label = String(Math.round(value));
    var size = h * 0.72;
    ctx.fillStyle = colour;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 ' + Math.round(size) + 'px system-ui, sans-serif';
    while (size > 14 && ctx.measureText(label).width > w * 0.84) {
      size *= 0.88;
      ctx.font = '800 ' + Math.round(size) + 'px system-ui, sans-serif';
    }
    ctx.fillText(label, x + w / 2, y + h / 2 + size * 0.02);
  }

  function paint(api) {
    var ptr = api.draw_ptr();
    var len = api.draw_len();
    var cmds = new Float32Array(api.memory.buffer, ptr, len);
    ctx.setTransform(canvas.width / 1920, 0, 0, canvas.height / 1080, 0, 0);
    for (var i = 0; i + 7 < cmds.length; i += 8) {
      var op = cmds[i];
      var x = cmds[i + 1], y = cmds[i + 2], w = cmds[i + 3], h = cmds[i + 4];
      var colour = COLOURS[cmds[i + 5] | 0] || '#ffffff';
      var a = cmds[i + 6], b = cmds[i + 7];
      if (op === 0) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 1920, 1080);
      } else if (op === 1) {
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, w, h);
      } else if (op === 2) {
        ctx.fillStyle = colour;
        roundRect(x, y, w, h, a);
        ctx.fill();
      } else if (op === 3) {
        drawNumber(x, y, w, h, colour, a);
      } else if (op === 4) {
        ctx.fillStyle = b > 1 ? COLOURS[8] : b > 0 ? COLOURS[9] : '#2a2d33';
        roundRect(x, y, w, h, Math.min(20, h / 2));
        ctx.fill();
        drawNumber(x, y, w, h, b > 0 ? '#1b1b1b' : '#f4f1ea', a);
      }
    }
  }

  function fail() {
    resize();
    ctx.setTransform(canvas.width / 1920, 0, 0, canvas.height / 1080, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.fillStyle = '#f4f1ea';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '64px system-ui, sans-serif';
    ctx.fillText('Game did not load', 960, 540);
  }

  function loadWasm(url) {
    function instantiate(response) {
      return response.arrayBuffer().then(function (bytes) { return WebAssembly.instantiate(bytes); });
    }
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      return WebAssembly.instantiateStreaming(fetch(url)).catch(function () { return fetch(url).then(instantiate); });
    }
    return fetch(url).then(instantiate);
  }

  loadWasm('number-snake.wasm').then(function (result) {
    var api = result.instance.exports;
    apiRef = api;
    api.game_new((Date.now() >>> 0) || 1);
    window.addEventListener('resize', resize);
    resize();
    var last = 0;
    var frame = function (time) {
      var dt = last ? time - last : 16;
      last = time;
      if (dt > 100) dt = 100;
      if (dt < 0) dt = 0;
      poll(api);
      api.game_tick(dt >>> 0);
      paint(api);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }).catch(fail);
})();
