/* The remote guide: a drawing of the lounge remote (One For All, Samsung layout) with the keys this page uses
   lit and called out. INFO shows and hides it; a pressed key flashes on the drawing. ES5: the TV's Chromium 47.
   Geometry is the remote's own: three columns, the rows in the order they sit under the thumb. */
window.ontoRemoteGuide = (function () {
  var W = 760, H = 940, BODY_X = 260, BODY_W = 240;
  // id, centre x, centre y, width, height, face text, tint, key codes that flash it
  var KEYS = [
    ['power', 310, 52, 36, 36, '', 'pink', []], ['hdmi', 380, 54, 56, 26, 'HDMI', '', []], ['source', 450, 54, 48, 26, 'SRC', '', []],
    ['1', 310, 118, 54, 36, '1', '', [49]], ['2', 380, 118, 54, 36, '2', '', [50]], ['3', 450, 118, 54, 36, '3', '', [51]],
    ['4', 310, 170, 54, 36, '4', '', [52]], ['5', 380, 170, 54, 36, '5', '', [53]], ['6', 450, 170, 54, 36, '6', '', [54]],
    ['7', 310, 222, 54, 36, '7', '', [55]], ['8', 380, 222, 54, 36, '8', '', [56]], ['9', 450, 222, 54, 36, '9', '', [57]],
    ['chlist', 310, 274, 54, 36, 'CH LIST', '', [10073]], ['0', 380, 274, 54, 36, '0', '', [48]], ['prech', 450, 274, 54, 36, 'PRE-CH', '', [10190]],
    ['vol', 310, 366, 52, 108, 'VOL', 'sky', []], ['mute', 380, 330, 52, 28, 'MUTE', '', []],
    ['subt', 380, 402, 52, 28, 'SUBT.', '', [10221]], ['ch', 450, 366, 52, 108, 'CH', 'sky', [427, 428]],
    ['menu', 310, 462, 56, 26, 'MENU', 'grey', []], ['hub', 380, 462, 56, 26, '', 'yellow', []], ['guide', 450, 462, 56, 26, 'GUIDE', 'grey', [458]],
    ['tools', 316, 522, 52, 44, 'TOOLS', '', [10135]], ['up', 380, 522, 46, 48, 'up', '', [38]], ['info', 444, 522, 52, 44, 'INFO', '', [457]],
    ['left', 316, 580, 52, 46, 'left', '', [37]], ['ok', 380, 580, 46, 46, 'OK', '', [13]], ['right', 444, 580, 52, 46, 'right', '', [39]],
    ['return', 316, 638, 52, 44, 'RETURN', '', [10009, 27, 8]], ['down', 380, 638, 46, 48, 'down', '', [40]], ['exit', 444, 638, 52, 44, 'EXIT', '', []],
    ['a', 306, 700, 40, 28, 'A', 'red', [403]], ['b', 355, 700, 40, 28, 'B', 'green', [404]],
    ['c', 405, 700, 40, 28, 'C', 'yellow', [405]], ['d', 454, 700, 40, 28, 'D', 'blue', [406]],
    ['pmode', 310, 748, 56, 26, 'P.MODE', 'grey', []], ['smode', 380, 748, 56, 26, 'S.MODE', 'grey', []], ['dual', 450, 748, 56, 26, 'DUAL', 'grey', []],
    ['ttx', 310, 792, 56, 26, '', 'grey', []], ['psize', 380, 792, 56, 26, 'P.SIZE', 'grey', []], ['pip', 450, 792, 56, 26, '', 'grey', []],
    ['rw', 310, 840, 58, 30, 'rw', '', [412]], ['pause', 380, 840, 58, 30, 'pause', '', [19]], ['ff', 450, 840, 58, 30, 'ff', '', [417]],
    ['rec', 310, 884, 58, 30, 'rec', '', []], ['play', 380, 884, 58, 30, 'play', '', [415, 10252]], ['stop', 450, 884, 58, 30, 'stop', '', [413]]
  ];
  var TINT = { pink: '#f48fb1', sky: '#8fc7f4', grey: '#9aa3b5', yellow: '#f2c230', red: '#e5484d', green: '#2fa36b', blue: '#3b82f6' };
  // What each page uses: key id -> [side, words, elbow y]. The words are the whole label, two or three at most.
  var PAGES = {
    player: {
      keys: {
        '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1, '0': 1, up: 1, down: 1, left: 1, ff: 1
      },
      calls: [
        ['6', 'R', '0–9 channel'], ['prech', 'R', 'Last watched'], ['ch', 'R', 'Channel'], ['guide', 'R', 'All channels'],
        ['info', 'R', 'This guide'], ['right', 'R', 'Move'], ['d', 'R', 'Next'], ['pause', 'R', 'Pause'], ['stop', 'R', 'Stop'],
        ['chlist', 'L', 'All channels'], ['subt', 'L', 'Subtitles'], ['tools', 'L', 'Options'], ['ok', 'L', 'Pause · select'],
        ['return', 'L', 'Back'], ['a', 'L', 'Previous', 676], ['b', 'L', 'Like', 724], ['rw', 'L', 'Seek 10 s'], ['play', 'L', 'Play']
      ]
    },
    home: {
      keys: { '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1, '0': 1, up: 1, down: 1, left: 1 },
      calls: [
        ['6', 'R', '0–9 channel'], ['info', 'R', 'This guide'], ['right', 'R', 'Move'],
        ['ok', 'L', 'Open'], ['return', 'L', 'Back to start']
      ]
    }
  };
  var holder = null, page = '', timer = 0, flashTimers = {};

  function esc(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function glyph(name, x, y) {
    if (name === 'up') return '<path d="M' + (x - 9) + ' ' + (y + 6) + ' L' + x + ' ' + (y - 8) + ' L' + (x + 9) + ' ' + (y + 6) + ' Z"/>';
    if (name === 'down') return '<path d="M' + (x - 9) + ' ' + (y - 6) + ' L' + x + ' ' + (y + 8) + ' L' + (x + 9) + ' ' + (y - 6) + ' Z"/>';
    if (name === 'left') return '<path d="M' + (x + 6) + ' ' + (y - 9) + ' L' + (x - 8) + ' ' + y + ' L' + (x + 6) + ' ' + (y + 9) + ' Z"/>';
    if (name === 'right') return '<path d="M' + (x - 6) + ' ' + (y - 9) + ' L' + (x + 8) + ' ' + y + ' L' + (x - 6) + ' ' + (y + 9) + ' Z"/>';
    if (name === 'play') return '<path d="M' + (x - 6) + ' ' + (y - 8) + ' L' + (x + 8) + ' ' + y + ' L' + (x - 6) + ' ' + (y + 8) + ' Z"/>';
    if (name === 'pause') return '<path d="M' + (x - 7) + ' ' + (y - 8) + ' h5 v16 h-5 z M' + (x + 2) + ' ' + (y - 8) + ' h5 v16 h-5 z"/>';
    if (name === 'stop') return '<rect x="' + (x - 7) + '" y="' + (y - 7) + '" width="14" height="14"/>';
    if (name === 'rec') return '<circle cx="' + x + '" cy="' + y + '" r="6"/>';
    if (name === 'ff') return '<path d="M' + (x - 12) + ' ' + (y - 8) + ' L' + x + ' ' + y + ' L' + (x - 12) + ' ' + (y + 8) + ' Z M' + x + ' ' + (y - 8) + ' L' + (x + 12) + ' ' + y + ' L' + x + ' ' + (y + 8) + ' Z"/>';
    if (name === 'rw') return '<path d="M' + (x + 12) + ' ' + (y - 8) + ' L' + x + ' ' + y + ' L' + (x + 12) + ' ' + (y + 8) + ' Z M' + x + ' ' + (y - 8) + ' L' + (x - 12) + ' ' + y + ' L' + x + ' ' + (y + 8) + ' Z"/>';
    return '';
  }
  function draw(name) {
    var spec = PAGES[name] || PAGES.player, used = {}, i, k, out = [], call, key, byId = {}, x1, x2, y, ly, anchor;
    for (k in spec.keys) if (spec.keys.hasOwnProperty(k)) used[k] = true;
    for (i = 0; i < spec.calls.length; i++) used[spec.calls[i][0]] = true;
    out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Remote guide">');
    out.push('<rect class="rg-body" x="' + BODY_X + '" y="14" width="' + BODY_W + '" height="912" rx="36"/>');
    for (i = 0; i < KEYS.length; i++) byId[KEYS[i][0]] = KEYS[i];
    // Callouts: a dot on the edge of the key, a line straight out to the side, the words. The lines are drawn
    // first, so a line to a middle key passes behind its neighbour and neither key's face is covered.
    var tops = [];
    for (i = 0; i < spec.calls.length; i++) {
      call = spec.calls[i];
      key = byId[call[0]];
      if (!key) continue;
      y = key[2];
      ly = call[3] || y;
      x1 = call[1] === 'L' ? BODY_X - 12 : BODY_X + BODY_W + 12;
      anchor = call[1] === 'L' ? 'end' : 'start';
      if (ly === y) {
        x2 = call[1] === 'L' ? key[1] - key[3] / 2 : key[1] + key[3] / 2;
        out.push('<path class="rg-line" d="M' + x2 + ' ' + y + ' H' + x1 + '"/>');
        tops.push('<circle class="rg-dot" cx="' + x2 + '" cy="' + y + '" r="5"/>');
      } else {
        // Two keys share this row: leave by the top or bottom edge and run along the gap between rows.
        var edge = ly < y ? y - key[4] / 2 : y + key[4] / 2;
        out.push('<path class="rg-line" d="M' + key[1] + ' ' + edge + ' V' + ly + ' H' + x1 + '"/>');
        tops.push('<circle class="rg-dot" cx="' + key[1] + '" cy="' + edge + '" r="5"/>');
      }
      tops.push('<text class="rg-word" x="' + (call[1] === 'L' ? x1 - 8 : x1 + 8) + '" y="' + (ly + 9) + '" text-anchor="' + anchor + '">' + esc(call[2]) + '</text>');
    }
    for (i = 0; i < KEYS.length; i++) {
      key = KEYS[i];
      var on = !!used[key[0]], tint = TINT[key[6]] || '', face = key[5], shape = glyph(face, key[1], key[2]);
      var cls = 'rg-key' + (on ? ' on' : '') + (tint ? ' tint' : '');
      var style = tint ? ' style="fill:' + tint + '"' : '';
      out.push('<g class="' + cls + '" data-key="' + key[0] + '">');
      if (key[0] === 'power') out.push('<circle class="cap" cx="' + key[1] + '" cy="' + key[2] + '" r="18"' + style + '/>');
      else out.push('<rect class="cap" x="' + (key[1] - key[3] / 2) + '" y="' + (key[2] - key[4] / 2) + '" width="' + key[3] + '" height="' + key[4] + '" rx="7"' + style + '/>');
      if (shape) out.push('<g class="face">' + shape + '</g>');
      else if (face) out.push('<text class="face' + (face.length > 2 ? ' small' : '') + '" x="' + key[1] + '" y="' + (key[2] + (face.length > 2 ? 4 : 8)) + '" text-anchor="middle">' + esc(face) + '</text>');
      out.push('</g>');
    }
    out.push(tops.join(''));
    out.push('</svg>');
    return out.join('');
  }
  function ensure() {
    if (holder) return holder;
    holder = document.getElementById('remote-guide');
    return holder;
  }
  function isOpen() { return !!(holder && !holder.hidden); }
  function close() {
    clearTimeout(timer);
    if (holder) holder.hidden = true;
  }
  function keepAlive() {
    clearTimeout(timer);
    timer = setTimeout(close, 20000);
  }
  function open(name) {
    if (!ensure()) return;
    if (page !== name || !holder.firstChild) { holder.innerHTML = draw(name); page = name; }
    holder.hidden = false;
    keepAlive();
  }
  function toggle(name) { if (isOpen() && page === name) close(); else open(name); }
  // A pressed key lights on the drawing, so the guide teaches by being used.
  function press(code) {
    var i, j, el, id;
    if (!isOpen()) return;
    keepAlive();
    for (i = 0; i < KEYS.length; i++) {
      for (j = 0; j < KEYS[i][7].length; j++) {
        if (KEYS[i][7][j] !== code) continue;
        id = KEYS[i][0];
        el = holder.querySelector('[data-key="' + id + '"]');
        if (!el) return;
        el.setAttribute('class', el.getAttribute('class').replace(/ pressed/g, '') + ' pressed');
        clearTimeout(flashTimers[id]);
        flashTimers[id] = setTimeout((function (node) {
          return function () { node.setAttribute('class', node.getAttribute('class').replace(/ pressed/g, '')); };
        }(el)), 350);
        return;
      }
    }
  }
  // The TV reports its own codes for the named keys; use them over the defaults.
  function setCode(id, code) {
    var i;
    for (i = 0; i < KEYS.length; i++) if (KEYS[i][0] === id && KEYS[i][7].indexOf(code) < 0) KEYS[i][7].push(code);
  }
  return { open: open, close: close, toggle: toggle, isOpen: isOpen, press: press, setCode: setCode, draw: draw, PAGES: PAGES, KEYS: KEYS };
}());
