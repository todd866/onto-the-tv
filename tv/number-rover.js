/* Number Rover — maze sum collector for Samsung TV (ES5). Model + overlay in one file. */
(function (globalObj, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (globalObj) {
    globalObj.createNumberRoverModel = api.createNumberRoverModel;
    if (typeof document !== 'undefined') {
      globalObj.ontoRover = api.createOverlayApi(api.createNumberRoverModel);
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var W = 9;
  var H = 7;
  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    ENTER: 13, SPACE: 32,
    BACK: 10009, ESC: 27, BACKSPACE: 8,
    N2: 50, N4: 52, N6: 54, N8: 56,
    ZERO: 48
  };

  function imul(a, b) {
    var ah = a >>> 16;
    var al = a & 65535;
    var bh = b >>> 16;
    var bl = b & 65535;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = imul(a ^ (a >>> 15), 1 | a);
      t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function clone(obj) {
    if (isArray(obj)) {
      var arr = [];
      var i;
      for (i = 0; i < obj.length; i++) {
        if (obj[i] && typeof obj[i] === 'object') arr.push(clone(obj[i]));
        else arr.push(obj[i]);
      }
      return arr;
    }
    var out = {};
    var k;
    for (k in obj) {
      if (obj.hasOwnProperty(k)) {
        if (obj[k] && typeof obj[k] === 'object') out[k] = clone(obj[k]);
        else out[k] = obj[k];
      }
    }
    return out;
  }

  /* # wall, . floor, S start, E exit, digits = pickup value */
  var LEVELS = [
    {
      target: 5,
      map: [
        '#########',
        '#S..1..E#',
        '#.......#',
        '#..2....#',
        '#.......#',
        '#...3...#',
        '#########'
      ],
      monsters: [{ x: 7, y: 5, dir: 2 }, { x: 1, y: 5, dir: 1 }]
    },
    {
      target: 10,
      map: [
        '#########',
        '#S.1..2.#',
        '#.#.#.#.#',
        '#.4..5..#',
        '#.#.###.#',
        '#...E...#',
        '#########'
      ],
      monsters: [{ x: 7, y: 1, dir: 2 }, { x: 1, y: 3, dir: 0 }, { x: 5, y: 5, dir: 3 }]
    },
    {
      target: 15,
      map: [
        '#########',
        '#S..6...#',
        '###.#.###',
        '#.1.2.3.#',
        '#.#.#.#.#',
        '#..4E5..#',
        '#########'
      ],
      monsters: [{ x: 4, y: 1, dir: 1 }, { x: 7, y: 3, dir: 2 }, { x: 3, y: 5, dir: 0 }]
    }
  ];

  function parseLevel(index) {
    var spec = LEVELS[index % LEVELS.length];
    var tiles = [];
    var pickups = [];
    var start = { x: 1, y: 1 };
    var exit = { x: 7, y: 5 };
    var y;
    var x;
    var row;
    var ch;
    for (y = 0; y < H; y++) {
      row = spec.map[y];
      for (x = 0; x < W; x++) {
        ch = row.charAt(x);
        if (ch === '#') {
          tiles.push(1);
        } else {
          tiles.push(0);
          if (ch === 'S') start = { x: x, y: y };
          else if (ch === 'E') exit = { x: x, y: y };
          else if (ch >= '1' && ch <= '9') {
            pickups.push({ x: x, y: y, value: ch.charCodeAt(0) - 48, taken: false });
          }
        }
      }
    }
    var monsters = [];
    for (var i = 0; i < spec.monsters.length; i++) {
      monsters.push({
        x: spec.monsters[i].x,
        y: spec.monsters[i].y,
        dir: spec.monsters[i].dir,
        homeX: spec.monsters[i].x,
        homeY: spec.monsters[i].y
      });
    }
    return {
      target: spec.target,
      tiles: tiles,
      pickups: pickups,
      start: start,
      exit: exit,
      monsters: monsters
    };
  }

  function tileAt(state, x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 1;
    return state.tiles[y * W + x];
  }

  function pickupAt(state, x, y) {
    var i;
    for (i = 0; i < state.pickups.length; i++) {
      if (!state.pickups[i].taken && state.pickups[i].x === x && state.pickups[i].y === y) {
        return state.pickups[i];
      }
    }
    return null;
  }

  function monsterAt(state, x, y) {
    var i;
    for (i = 0; i < state.monsters.length; i++) {
      if (state.monsters[i].x === x && state.monsters[i].y === y) return state.monsters[i];
    }
    return null;
  }

  function dirDelta(dir) {
    if (dir === 0) return { dx: 0, dy: -1 };
    if (dir === 1) return { dx: 1, dy: 0 };
    if (dir === 2) return { dx: 0, dy: 1 };
    return { dx: -1, dy: 0 };
  }

  function moveMonsters(state) {
    if (state.level < 2) return;
    var count = state.monsters.length;
    var order = [];
    var rng = state._rng;
    var i;
    var j;
    var tmp;
    var mi;
    for (i = 0; i < count; i++) order.push(i);
    for (i = count - 1; i > 0; i--) {
      j = Math.floor(rng() * (i + 1));
      tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    for (mi = 0; mi < order.length; mi++) {
      stepMonster(state, state.monsters[order[mi]]);
    }
  }

  function stepMonster(state, m) {
    var px = state.player.x;
    var py = state.player.y;
    var dx = px - m.x;
    var dy = py - m.y;
    var dist = Math.abs(dx) + Math.abs(dy);
    var tryDirs = [];
    var d;
    var dd;
    var nx;
    var ny;
    if (state.level > 1 && dist > 0 && dist <= 5 && rngBias(state) > 0.35) {
      if (Math.abs(dx) >= Math.abs(dy)) {
        tryDirs.push(dx > 0 ? 1 : 3);
        tryDirs.push(dy > 0 ? 2 : 0);
      } else {
        tryDirs.push(dy > 0 ? 2 : 0);
        tryDirs.push(dx > 0 ? 1 : 3);
      }
    } else {
      tryDirs.push(m.dir);
      tryDirs.push((m.dir + 1) % 4);
      tryDirs.push((m.dir + 3) % 4);
    }
    for (d = 0; d < tryDirs.length; d++) {
      dd = dirDelta(tryDirs[d]);
      nx = m.x + dd.dx;
      ny = m.y + dd.dy;
      if (tileAt(state, nx, ny) === 0 && !monsterAt(state, nx, ny)) {
        m.x = nx;
        m.y = ny;
        m.dir = tryDirs[d];
        return;
      }
    }
  }

  function rngBias(state) {
    return state._rng();
  }

  function hurtPlayer(state) {
    state.hearts -= 1;
    state.flash = 8;
    state.player.x = state.spawn.x;
    state.player.y = state.spawn.y;
    state.currentSum = 0;
    var p;
    for (p = 0; p < state.pickups.length; p++) state.pickups[p].taken = false;
    resetMonsters(state);
    if (state.hearts <= 0) {
      state.phase = 'lost';
    }
  }

  function applyCollision(state) {
    var i;
    for (i = 0; i < state.monsters.length; i++) {
      if (state.monsters[i].x === state.player.x && state.monsters[i].y === state.player.y) {
        hurtPlayer(state);
        return true;
      }
    }
    return false;
  }

  function resetMonsters(state) {
    var i;
    for (i = 0; i < state.monsters.length; i++) {
      state.monsters[i].x = state.monsters[i].homeX;
      state.monsters[i].y = state.monsters[i].homeY;
    }
  }

  function levelPickupsAvailable(levelData) {
    var vals = [];
    var i;
    for (i = 0; i < levelData.pickups.length; i++) {
      vals.push(levelData.pickups[i].value);
    }
    return vals;
  }

  function canSumTarget(values, target) {
    var n = values.length;
    var mask;
    var sum;
    var i;
    var maxMask = 1 << n;
    for (mask = 1; mask < maxMask; mask++) {
      sum = 0;
      for (i = 0; i < n; i++) {
        if (mask & (1 << i)) sum += values[i];
      }
      if (sum === target) return true;
    }
    return false;
  }

  function assertLevelsSolvable() {
    var i;
    var vals;
    for (i = 0; i < LEVELS.length; i++) {
      vals = levelPickupsAvailable(parseLevel(i));
      if (!canSumTarget(vals, LEVELS[i].target)) {
        throw new Error('Level ' + i + ' target not solvable');
      }
    }
  }

  assertLevelsSolvable();

  function freshState(seed, levelIndex, carry) {
    carry = carry || {};
    var lvl = parseLevel(levelIndex);
    var rng = mulberry32((seed + levelIndex * 997) >>> 0);
    return {
      width: W,
      height: H,
      level: levelIndex + 1,
      target: lvl.target,
      tiles: lvl.tiles.slice(),
      pickups: clone(lvl.pickups),
      monsters: clone(lvl.monsters),
      exit: clone(lvl.exit),
      player: { x: lvl.start.x, y: lvl.start.y },
      spawn: { x: lvl.start.x, y: lvl.start.y },
      currentSum: 0,
      hearts: typeof carry.hearts === 'number' ? carry.hearts : 3,
      score: carry.score || 0,
      phase: 'playing',
      message: '',
      flash: 0,
      seed: seed,
      _rng: rng
    };
  }

  function snapshot(state) {
    return {
      width: state.width,
      height: state.height,
      level: state.level,
      target: state.target,
      tiles: state.tiles.slice(),
      pickups: clone(state.pickups),
      monsters: clone(state.monsters),
      exit: clone(state.exit),
      player: clone(state.player),
      currentSum: state.currentSum,
      hearts: state.hearts,
      score: state.score,
      phase: state.phase,
      flash: state.flash,
      message: state.message || ''
    };
  }

  function codeToDir(code) {
    if (code === KEY.UP || code === KEY.N8) return 0;
    if (code === KEY.RIGHT || code === KEY.N6) return 1;
    if (code === KEY.DOWN || code === KEY.N2) return 2;
    if (code === KEY.LEFT || code === KEY.N4) return 3;
    return -1;
  }

  function tryMove(state, dir) {
    if (state.phase !== 'playing') return false;
    state.message = '';
    var dd = dirDelta(dir);
    var nx = state.player.x + dd.dx;
    var ny = state.player.y + dd.dy;
    if (tileAt(state, nx, ny) !== 0) return false;
    if (monsterAt(state, nx, ny)) {
      state.player.x = nx;
      state.player.y = ny;
      hurtPlayer(state);
      if (state.flash > 0) state.flash -= 1;
      return true;
    }
    state.player.x = nx;
    state.player.y = ny;
    moveMonsters(state);
    applyCollision(state);
    if (state.flash > 0) state.flash -= 1;
    checkWin(state);
    return true;
  }

  function tryPick(state) {
    if (state.phase !== 'playing') return false;
    var p = pickupAt(state, state.player.x, state.player.y);
    if (!p) return false;
    var next = state.currentSum + p.value;
    var remaining = state.pickups.filter(function (item) { return item !== p && !item.taken; }).map(function (item) { return item.value; });
    if (next > state.target || (next < state.target && !canSumTarget(remaining, state.target - next))) {
      state.message = 'Try another number'; return false;
    }
    state.message = '';
    p.taken = true;
    state.currentSum = next;
    moveMonsters(state);
    applyCollision(state);
    checkWin(state);
    return true;
  }

  function checkWin(state) {
    if (state.phase !== 'playing') return;
    if (state.currentSum !== state.target) return;
    if (state.player.x !== state.exit.x || state.player.y !== state.exit.y) return;
    state.score += state.level * 100 + state.hearts * 25;
    if (state.level >= LEVELS.length) {
      state.phase = 'won';
      return;
    }
    var next = freshState(state.seed, state.level, { hearts: state.hearts, score: state.score });
    next.level = state.level + 1;
    mergeRunState(state, next);
  }

  function mergeRunState(state, next) {
    var k;
    for (k in next) {
      if (next.hasOwnProperty(k)) state[k] = next[k];
    }
    state.level = next.level;
    state.phase = 'playing';
  }

  function retryLevel(state) {
    var carry = { hearts: state.hearts, score: state.score };
    var idx = state.level - 1;
    var next = freshState(state.seed, idx, carry);
    mergeRunState(state, next);
    state.phase = 'playing';
  }

  function createNumberRoverModel(seed) {
    seed = (seed == null ? 42 : seed) >>> 0;
    var state = freshState(seed, 0, {});

    function dispatchKey(code) {
      if (code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE) {
        return { type: 'close' };
      }
      if (state.phase === 'lost' || state.phase === 'won') {
        if (code === KEY.ENTER || code === KEY.SPACE) {
          if (state.phase === 'lost') {
            state.hearts = 3;
            state.score = 0;
            var restart = freshState(seed, 0, {});
            mergeRunState(state, restart);
          } else {
            return { type: 'close' };
          }
          return { type: 'state' };
        }
        return { type: 'noop' };
      }
      var dir = codeToDir(code);
      if (dir >= 0) {
        tryMove(state, dir);
        return { type: 'state' };
      }
      if (code === KEY.ENTER || code === KEY.SPACE) {
        tryPick(state);
        return { type: 'state' };
      }
      if (code === KEY.ZERO && state.phase === 'playing') {
        retryLevel(state);
        return { type: 'state' };
      }
      return { type: 'noop' };
    }

    return {
      getState: function () { return snapshot(state); },
      dispatchKey: dispatchKey,
      retry: function () { retryLevel(state); return snapshot(state); },
      _canSumTarget: canSumTarget,
      _parseLevel: parseLevel,
      LEVELS: LEVELS
    };
  }

  /* ---------- overlay (browser) ---------- */

  function createOverlayApi(createModel) {
    var openFlag = false;
    var model = null;
    var onCloseCb = null;
    var onStateCb = null;
    var rootEl = null;
    var canvas = null;
    var ctx = null;
    var animId = 0;

    var PAL = {
      wall: '#3d2a6b',
      wallHi: '#6b4fd4',
      floor: '#1a3d5c',
      floorHi: '#2a6d9c',
      player: '#ffe566',
      exit: '#3ee07a',
      monster: ['#ff5ad1', '#5af0ff', '#ffb547', '#c6ff4a'],
      num: ['#ff4b4b', '#4aa3ff', '#ffcc33', '#ff8a3d', '#d9d4ff', '#ffffff']
    };

    function ensureDom() {
      if (rootEl) return;
      rootEl = document.createElement('div');
      rootEl.id = 'onto-rover-overlay';
      rootEl.className = 'onto-rover-overlay';
      rootEl.setAttribute('role', 'dialog');
      rootEl.setAttribute('aria-label', 'Number Rover');

      var hud = document.createElement('div');
      hud.className = 'onto-rover-hud';

      var hearts = document.createElement('div');
      hearts.className = 'onto-rover-hearts';
      hearts.setAttribute('aria-label', 'Hearts');

      var score = document.createElement('div');
      score.className = 'onto-rover-score';
      score.setAttribute('aria-label', 'Score');

      var sumRow = document.createElement('div');
      sumRow.className = 'onto-rover-sum';
      var sumLabel = document.createElement('span');
      sumLabel.className = 'onto-rover-sum-label';
      sumLabel.textContent = 'sum';
      var sumVal = document.createElement('span');
      sumVal.className = 'onto-rover-sum-val';
      sumRow.appendChild(sumLabel);
      sumRow.appendChild(sumVal);

      var targetRow = document.createElement('div');
      targetRow.className = 'onto-rover-target';
      var targetLabel = document.createElement('span');
      targetLabel.className = 'onto-rover-target-label';
      targetLabel.textContent = 'goal';
      var targetVal = document.createElement('span');
      targetVal.className = 'onto-rover-target-val';
      targetRow.appendChild(targetLabel);
      targetRow.appendChild(targetVal);

      var lvl = document.createElement('div');
      lvl.className = 'onto-rover-level';
      lvl.setAttribute('aria-label', 'Level');

      hud.appendChild(hearts);
      hud.appendChild(sumRow);
      hud.appendChild(targetRow);
      hud.appendChild(score);
      hud.appendChild(lvl);

      canvas = document.createElement('canvas');
      canvas.className = 'onto-rover-board';
      canvas.width = 900;
      canvas.height = 700;

      var hint = document.createElement('div');
      hint.className = 'onto-rover-hint';
      hint.textContent = '\u2190\u2191\u2192\u2193 move \u00b7 OK pick \u00b7 0 retry \u00b7 Return close';

      rootEl.appendChild(hud);
      rootEl.appendChild(canvas);
      rootEl.appendChild(hint);
      document.body.appendChild(rootEl);
      ctx = canvas.getContext('2d');
      window.addEventListener('resize', fitBoard);
      fitBoard();
    }

    function fitBoard() {
      if (!canvas) return;
      var top = rootEl.querySelector('.onto-rover-hud').offsetHeight + 18;
      var available = Math.max(70, window.innerHeight - top - rootEl.querySelector('.onto-rover-hint').offsetHeight - 36);
      var width = Math.min(window.innerWidth - 32, available * 9 / 7, 1050);
      canvas.style.width = Math.max(90, width) + 'px';
      canvas.style.height = Math.max(70, width * 7 / 9) + 'px';
      canvas.style.marginLeft = -Math.max(90, width) / 2 + 'px';
      canvas.style.marginTop = '0';
      canvas.style.top = (top + Math.max(0, available - width * 7 / 9) / 2) + 'px';
    }

    function drawHeart(x, y, filled) {
      ctx.fillStyle = filled ? '#ff4b4b' : '#4a3050';
      ctx.beginPath();
      ctx.arc(x - 6, y - 2, 7, 0, Math.PI * 2);
      ctx.arc(x + 6, y - 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 12, y);
      ctx.lineTo(x, y + 14);
      ctx.lineTo(x + 12, y);
      ctx.closePath();
      ctx.fill();
    }

    function paintBoard(st) {
      if (!ctx) return;
      var cw = canvas.width / W;
      var ch = canvas.height / H;
      var x;
      var y;
      var i;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
          i = y * W + x;
          if (st.tiles[i]) {
            ctx.fillStyle = ((x + y) % 2) ? PAL.wall : PAL.wallHi;
            ctx.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);
            ctx.strokeStyle = '#120820';
            ctx.lineWidth = 2;
            ctx.strokeRect(x * cw + 3, y * ch + 3, cw - 6, ch - 6);
          } else {
            ctx.fillStyle = ((x + y) % 2) ? PAL.floor : PAL.floorHi;
            ctx.fillRect(x * cw, y * ch, cw, ch);
          }
        }
      }
      if (st.exit) {
        ctx.fillStyle = PAL.exit;
        ctx.beginPath();
        ctx.arc(st.exit.x * cw + cw / 2, st.exit.y * ch + ch / 2, Math.min(cw, ch) * 0.32, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0d2818';
        ctx.font = 'bold ' + Math.round(ch * 0.28) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GO', st.exit.x * cw + cw / 2, st.exit.y * ch + ch / 2);
      }
      for (i = 0; i < st.pickups.length; i++) {
        if (st.pickups[i].taken) continue;
        ctx.fillStyle = PAL.num[st.pickups[i].value % PAL.num.length];
        ctx.beginPath();
        ctx.arc(st.pickups[i].x * cw + cw / 2, st.pickups[i].y * ch + ch / 2, Math.min(cw, ch) * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1b1020';
        ctx.font = '800 ' + Math.round(ch * 0.38) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(st.pickups[i].value), st.pickups[i].x * cw + cw / 2, st.pickups[i].y * ch + ch / 2);
      }
      for (i = 0; i < st.monsters.length; i++) {
        ctx.fillStyle = PAL.monster[i % PAL.monster.length];
        var mx = st.monsters[i].x * cw + cw / 2;
        var my = st.monsters[i].y * ch + ch / 2;
        var r = Math.min(cw, ch) * 0.36;
        ctx.beginPath();
        ctx.arc(mx, my - r * 0.15, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1b1020';
        ctx.beginPath();
        ctx.arc(mx - r * 0.35, my - r * 0.2, r * 0.18, 0, Math.PI * 2);
        ctx.arc(mx + r * 0.35, my - r * 0.2, r * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(mx - r * 0.35, my - r * 0.25, r * 0.07, 0, Math.PI * 2);
        ctx.arc(mx + r * 0.35, my - r * 0.25, r * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
      var px = st.player.x * cw + cw / 2;
      var py = st.player.y * ch + ch / 2;
      if (st.flash && st.flash % 2 === 0) {
        ctx.globalAlpha = 0.45;
      }
      ctx.fillStyle = PAL.player;
      ctx.beginPath();
      ctx.arc(px, py, Math.min(cw, ch) * 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#3a2800';
      ctx.font = 'bold ' + Math.round(ch * 0.22) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('R', px, py + 1);
    }

    function updateHud(st) {
      if (!rootEl) return;
      var heartsEl = rootEl.querySelector('.onto-rover-hearts');
      var scoreEl = rootEl.querySelector('.onto-rover-score');
      var sumEl = rootEl.querySelector('.onto-rover-sum-val');
      var targetEl = rootEl.querySelector('.onto-rover-target-val');
      var lvlEl = rootEl.querySelector('.onto-rover-level');
      var h = '';
      var i;
      for (i = 0; i < 3; i++) {
        h += i < st.hearts ? '\u2665' : '\u2661';
      }
      heartsEl.textContent = h;
      scoreEl.textContent = 'pts ' + st.score;
      sumEl.textContent = String(st.currentSum);
      targetEl.textContent = String(st.target);
      lvlEl.textContent = 'L' + st.level;
      rootEl.querySelector('.onto-rover-hint').textContent = st.message || '\u2190\u2191\u2192\u2193 move · OK collect · Green gate when sum = goal · Return';
      if (st.phase === 'won') {
        rootEl.setAttribute('data-phase', 'won');
      } else if (st.phase === 'lost') {
        rootEl.setAttribute('data-phase', 'lost');
      } else {
        rootEl.removeAttribute('data-phase');
      }
    }

    function emitState() {
      var st = model.getState();
      updateHud(st);
      fitBoard();
      paintBoard(st);
      if (onStateCb) onStateCb(st);
    }

    function frame() {
      if (!openFlag) return;
      emitState();

    }

    function open(onClose, onState) {
      if (openFlag) return;
      ensureDom();
      if (!document.getElementById('onto-rover-styles')) {
        var link = document.createElement('link');
        link.id = 'onto-rover-styles';
        link.rel = 'stylesheet';
        link.href = 'number-rover.css';
        document.head.appendChild(link);
      }
      model = createModel(Date.now() >>> 0);
      onCloseCb = onClose || null;
      onStateCb = onState || null;
      openFlag = true;
      rootEl.className = 'onto-rover-overlay onto-rover-open';
      fitBoard();
      emitState();

    }

    function close() {
      if (!openFlag) return;
      openFlag = false;
      if (animId) {
        window.cancelAnimationFrame(animId);
        animId = 0;
      }
      if (rootEl) rootEl.className = 'onto-rover-overlay';
      model = null;
      if (onCloseCb) {
        var cb = onCloseCb;
        onCloseCb = null;
        cb();
      }
    }

    function handleKey(code, player) {
      if (!openFlag || !model) return false;
      if (player && player !== 0) return false;
      var result = model.dispatchKey(code);
      if (result.type === 'close') {
        close();
        return true;
      }
      if (result.type === 'state') emitState();
      return result.type !== 'noop';
    }

    function isOpen() {
      return openFlag;
    }

    return {
      open: open,
      close: close,
      handleKey: handleKey,
      isOpen: isOpen
    };
  }

  return {
    createNumberRoverModel: createNumberRoverModel,
    createOverlayApi: createOverlayApi,
    KEY: KEY,
    canSumTarget: canSumTarget,
    parseLevel: parseLevel,
    LEVELS: LEVELS
  };
}));
