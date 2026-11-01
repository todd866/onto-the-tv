/* Onto the TV: small couch games. ES5-compatible and deliberately offline. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.ontoGames = factory(root, root.document).controller(root, root.document);
}(typeof window !== 'undefined' ? window : this, function (root, document) {
  'use strict';

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    PAUSE: 19, PLAYPAUSE: 10252 };
  var digits = function (code) { return code >= 48 && code <= 57 ? code - 48 : -1; };

  function createNumberModel(players) {
    var values = [0, 1, 2, 3, 4, 5, 6, 7, 10], used = [], cursor = 0, turn = 1, score = [0, 0], target = 5, picks = 0;
    function nextTarget() {
      var available = [], i;
      for (i = 0; i < values.length; i++) if (!used[i]) available.push(values[i]);
      target = available.length ? available[(picks * 3 + 2) % available.length] : 0;
    }
    function choose(index) {
      if (index < 0 || index > 8 || used[index]) return { ok: false };
      var value = values[index], correct = value === target;
      if (!correct) return { ok: true, correct: false, value: value, target: target, turn: turn };
      used[index] = true; score[turn - 1] += 1;
      picks += 1;
      var result = { ok: true, correct: correct, value: value, target: target, turn: turn, score: score[turn - 1] };
      turn = players === 2 ? (turn === 1 ? 2 : 1) : 1;
      if (used.filter(Boolean).length === 9) { used = []; values = values.slice(1).concat(values.slice(0, 1)); }
      nextTarget();
      return result;
    }
    return { game: 'numbers', values: values, used: used, get target() { return target; }, get turn() { return turn; }, get score() { return score; }, get cursor() { return cursor; }, setCursor: function (value) { cursor = Math.max(0, Math.min(8, value)); }, choose: choose,
      snapshot: function () { return { target: target, prompt: picks % 2 ? Math.floor(target / 2) + ' + ' + (target - Math.floor(target / 2)) + ' = ?' : 'Find ' + target, turn: turn, score: score.slice(), cursor: cursor, used: used.slice(), values: values.slice() }; } };
  }

  function createMemoryModel(players) {
    var cards = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5], cursor = 0, selected = [], matched = [], score = [0, 0], turn = 1, mismatch = false;
    // A fixed, non-trivial layout makes the game deterministic and easy to explain.
    cards = [0, 3, 1, 5, 2, 4, 4, 2, 5, 1, 3, 0];
    function shuffle() { var i, j, held; for (i = cards.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); held = cards[i]; cards[i] = cards[j]; cards[j] = held; } }
    shuffle();
    function choose(index) {
      if (index < 0 || index > 11 || matched[index]) return { ok: false };
      if (mismatch) { selected = []; mismatch = false; }
      if (selected.indexOf(index) >= 0) return { ok: false };
      selected.push(index);
      if (selected.length < 2) return { ok: true, waiting: true, index: index, turn: turn };
      var first = selected[0], pair = cards[first] === cards[index];
      if (pair) { matched[first] = true; matched[index] = true; score[turn - 1] += 1; }
      else mismatch = true;
      var result = { ok: true, pair: pair, values: [cards[first], cards[index]], turn: turn, score: score[turn - 1] };
      selected = pair ? [] : selected;
      turn = players === 2 ? (turn === 1 ? 2 : 1) : 1;
      if (matched.filter(Boolean).length === 12) { matched = []; selected = []; mismatch = false; shuffle(); }
      return result;
    }
    return { game: 'memory', cards: cards, get cursor() { return cursor; }, get turn() { return turn; }, get score() { return score; }, get selected() { return selected; }, get mismatch() { return mismatch; }, setCursor: function (value) { cursor = Math.max(0, Math.min(11, value)); }, choose: choose,
      snapshot: function () { return { cards: cards.slice(), cursor: cursor, turn: turn, score: score.slice(), selected: selected.slice(), matched: matched.slice(), mismatch: mismatch }; } };
  }

  function controller(win, doc) {
    var rootEl = null, model = null, game = 'menu', players = 1, menuCursor = 0, cursors = [0, 0], activePlayer = 1, feedback = '', paused = false, onClose = function () {}, onState = function () {};
    function state(stateName) {
      var score = model ? model.score : [0, 0];
      onState({ game: game, state: stateName, players: players, turn: model ? model.turn : 1, score: score[0] + score[1], cursors: cursors.slice() });
    }
    function ensureRoot() {
      if (rootEl) return rootEl;
      rootEl = doc.createElement('div'); rootEl.id = 'onto-games'; rootEl.className = 'games-overlay'; rootEl.setAttribute('aria-label', 'Games');
      doc.body.appendChild(rootEl); return rootEl;
    }
    function button(text, cls) { var el = doc.createElement('div'); el.className = 'game-button ' + (cls || ''); el.textContent = text; return el; }
    function renderMenu() {
      rootEl.innerHTML = '';
      var panel = doc.createElement('div'); panel.className = 'games-panel';
      var title = doc.createElement('h1'); title.textContent = 'Games'; panel.appendChild(title);
      var sub = doc.createElement('p'); sub.textContent = 'Choose a game'; panel.appendChild(sub);
      var choices = ['Number Rover', 'Memory match', 'RC race'];
      for (var i = 0; i < choices.length; i++) { var b = button((i + 1) + '  ' + choices[i], i === menuCursor ? 'focused' : ''); b.setAttribute('data-menu', i); panel.appendChild(b); }
      var mode = button('Players: ' + players, 'mode' + (menuCursor === 3 ? ' focused' : '')); mode.setAttribute('data-menu', '3'); panel.appendChild(mode);
      var hint = doc.createElement('p'); hint.className = 'game-hint'; hint.textContent = 'Arrows  OK  1–9  Back'; panel.appendChild(hint); rootEl.appendChild(panel);
    }
    function renderNumbers() {
      rootEl.innerHTML = ''; var panel = doc.createElement('div'); panel.className = 'games-panel play-panel';
      var heading = doc.createElement('h1'); heading.textContent = 'Number grid'; panel.appendChild(heading);
      var snap = model.snapshot();
      var info = doc.createElement('div'); info.className = 'game-info'; info.textContent = (players === 2 ? 'Player ' + snap.turn + '  ·  ' : '') + snap.prompt + '  ·  Team ' + (snap.score[0] + snap.score[1]); info.setAttribute('data-target', snap.target); info.setAttribute('data-score', snap.score[0] + snap.score[1]); panel.appendChild(info);
      var grid = doc.createElement('div'); grid.className = 'number-grid';
      for (var i = 0; i < 9; i++) { var cell = button(String(snap.values[i]), 'number-cell' + (i === cursors[activePlayer - 1] ? ' focused' : '') + (snap.used[i] ? ' used' : '')); cell.setAttribute('data-index', i); cell.setAttribute('data-value', snap.values[i]);
        var shortcut = doc.createElement('small'); shortcut.className = 'game-shortcut'; shortcut.textContent = i + 1; cell.appendChild(shortcut); grid.appendChild(cell); }
      panel.appendChild(grid); var hint = doc.createElement('p'); hint.className = 'game-hint'; hint.textContent = feedback || 'Arrows + OK  ·  1–9 picks a square  ·  Return'; panel.appendChild(hint); rootEl.appendChild(panel);
    }
    function renderMemory() {
      rootEl.innerHTML = ''; var panel = doc.createElement('div'); panel.className = 'games-panel play-panel';
      var heading = doc.createElement('h1'); heading.textContent = 'Memory match'; panel.appendChild(heading);
      var info = doc.createElement('div'); info.className = 'game-info'; info.textContent = (players === 2 ? 'Player ' + model.turn + '  ·  ' : '') + 'Pairs ' + model.score[0] + (players === 2 ? ' / ' + model.score[1] : ''); panel.appendChild(info);
      var grid = doc.createElement('div'); grid.className = 'memory-grid'; var snap = model.snapshot();
      for (var i = 0; i < 12; i++) { var open = snap.matched[i] || snap.selected.indexOf(i) >= 0; var card = button(open ? String(snap.cards[i] + 1) : '?', 'memory-card' + (i === cursors[activePlayer - 1] ? ' focused' : '') + (open ? ' shape-' + snap.cards[i] : '')); card.setAttribute('data-index', i); grid.appendChild(card); }
      panel.appendChild(grid); var hint = doc.createElement('p'); hint.className = 'game-hint'; hint.textContent = 'Find matching pairs  ·  Arrows / 1–9  ·  Back'; panel.appendChild(hint); rootEl.appendChild(panel);
    }
    function bindButtons() {
      var buttons = rootEl.querySelectorAll('.game-button'), i;
      for (i = 0; i < buttons.length; i++) buttons[i].onclick = function () {
        var menu = this.getAttribute('data-menu'), index = this.getAttribute('data-index');
        if (menu !== null) choose(menu === '3' ? 0 : Number(menu) + 1, 1);
        else if (index !== null) choose(Number(index), 1);
      };
    }
    function render() {
      if (game === 'menu') renderMenu(); else if (game === 'numbers') renderNumbers(); else renderMemory();
      bindButtons();
      if (paused) { var pause = doc.createElement('div'); pause.className = 'games-paused'; pause.textContent = 'Paused  ·  OK to resume'; rootEl.appendChild(pause); }
    }
    function start(which) { feedback = ''; game = which; cursors = [0, 0]; activePlayer = 1; model = which === 'numbers' ? createNumberModel(players) : createMemoryModel(players); model.setCursor(0); render(); state('playing'); }
    function move(dx, dy, player) { var cols = game === 'memory' ? 4 : 3, max = game === 'memory' ? 11 : 8, cursor = cursors[player - 1], row = Math.floor(cursor / cols), col = cursor % cols; if (dx) col = Math.max(0, Math.min(cols - 1, col + dx)); if (dy) row = Math.max(0, Math.min(Math.floor(max / cols), row + dy)); cursors[player - 1] = Math.max(0, Math.min(max, row * cols + col)); model.setCursor(cursors[player - 1]); activePlayer = player; render(); }
    function choose(index, player) { if (game === 'menu') { if (index === 1) { players = 1; game = 'rover'; model = null; state('playing'); win.ontoRover.open(function () { game = 'menu'; render(); state('ready'); }, function () {}); } else if (index === 2) start('memory'); else if (index === 3) { if (win.ontoCouch) win.ontoCouch.open(); } else if (index === 0) { players = players === 1 ? 2 : 1; render(); state('ready'); } return; } if (players === 2 && player !== model.turn) return; if (index >= 0) { cursors[player - 1] = index; activePlayer = player; model.setCursor(index); var result = model.choose(index); feedback = result && result.correct === false ? 'Try another square' : ''; render(); state('playing'); } }
    function handleKey(code, player) {
      if (!rootEl || rootEl.hidden) return false;
      if (win.ontoRover && win.ontoRover.isOpen()) return win.ontoRover.handleKey(code, 0);
      if (win.ontoCouch && win.ontoCouch.isOpen()) return win.ontoCouch.key(code, true);
      player = player === 2 ? 2 : 1;
      if (code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE) { if (game !== 'menu') { game = 'menu'; model = null; paused = false; render(); state('ready'); } else close(); return true; }
      if (paused) { if (code === KEY.OK || code === KEY.PLAYPAUSE) { paused = false; state('playing'); render(); } return true; }
      if (code === KEY.PAUSE || code === KEY.PLAYPAUSE) { paused = true; state('paused'); render(); return true; }
      var d = digits(code); if (d >= 0) { if (game === 'menu') { if (player === 1) choose(d === 1 ? 1 : d === 2 ? 2 : d === 3 ? 3 : d === 0 ? 0 : -1); } else if (d <= 9 && d > 0) choose(d - 1, player); return true; }
      if (game !== 'menu' && players === 2 && player !== model.turn) return true;
      if (game === 'menu') {
        if (code === KEY.UP) menuCursor = Math.max(0, menuCursor - 1);
        else if (code === KEY.DOWN) menuCursor = Math.min(3, menuCursor + 1);
        else if (code === KEY.OK) { if (player !== 1) return true; choose(menuCursor === 3 ? 0 : menuCursor + 1); }
        else return false;
        render(); return true;
      }
      if (code === KEY.LEFT) move(-1, 0, player); else if (code === KEY.RIGHT) move(1, 0, player); else if (code === KEY.UP) move(0, -1, player); else if (code === KEY.DOWN) move(0, 1, player); else if (code === KEY.OK) choose(cursors[player - 1], player); else return false;
      return true;
    }
    function open(closeCallback, stateCallback) { onClose = closeCallback || function () {}; onState = stateCallback || function () {}; ensureRoot(); rootEl.hidden = false; game = 'menu'; paused = false; render(); state('ready'); }
    function close() { if (win.ontoRover) win.ontoRover.close(); if (win.ontoCouch) win.ontoCouch.close(); if (!rootEl) return; rootEl.hidden = true; model = null; onClose(); }
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', function () {
      if (rootEl && !rootEl.hidden && doc.hidden && !paused) { paused = true; state('paused'); }
    });
    return { open: open, close: close, isOpen: function () { return !!rootEl && !rootEl.hidden; }, handleKey: handleKey, setPlayers: function (count) { players = count === 2 ? 2 : 1; if (game === 'menu') { render(); state('ready'); } } };
  }
  return { controller: controller, createNumberModel: createNumberModel, createMemoryModel: createMemoryModel };
}));
