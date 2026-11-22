/* The TV owns the game; a paired laptop can only send player-two game buttons. */
(function () {
  'use strict';
  var generation = 0, session = '', base = '', token = '', timer = 0, creating = false, after = 0, box = null;
  function label(text) {
    if (!box) { box = document.createElement('aside'); box.id = 'game-pairing'; document.body.appendChild(box); }
    box.hidden = false; box.textContent = text;
  }
  function request(method, path, body, callback, address, credential) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, (address || base) + path, true); xhr.timeout = 3000;
    xhr.setRequestHeader('X-Onto-Token', credential || token);
    if (body) xhr.setRequestHeader('Content-Type', 'application/json');
    var done = false;
    function finish(error) {
      if (done) return; done = true;
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (e) {}
      callback(error || xhr.status < 200 || xhr.status >= 300, result || {});
    }
    xhr.onload = function () { finish(false); };
    xhr.onerror = xhr.ontimeout = function () { finish(true); };
    xhr.send(body ? JSON.stringify(body) : null);
  }
  function close() {
    generation++; clearTimeout(timer); creating = false;
    if (session) request('DELETE', '/api/game/session?session=' + encodeURIComponent(session), null, function () {});
    session = ''; after = 0;
    if (box) box.hidden = true;
  }
  function poll(id, code, expected) {
    if (expected !== generation) return;
    request('GET', '/api/game/events?session=' + encodeURIComponent(id) + '&after=' + after, null, function (error, result) {
      if (expected !== generation) return;
      if (error) { label('Laptop disconnected · choose 1 player, then 2 to reconnect'); return; }
      label(result.controller ? 'Player 2 · Laptop connected' : 'Player 2 · ' + base + '/controller/  ·  ' + code);
      (result.events || []).forEach(function (event) {
        if (event.seq <= after) return;
        after = event.seq;
        if (document.hidden || !window.ontoGames.isOpen()) return;
        var keys = { up: 38, down: 40, left: 37, right: 39, ok: 13 };
        var key = keys[event.action];
        if (/^digit[0-9]$/.test(event.action)) key = 48 + Number(event.action.slice(-1));
        if (key !== undefined) window.ontoGames.handleKey(key, 2);
        if (window.ontoDiagnostics) window.ontoDiagnostics.emit('game_input', { page: 'games', input: 'laptop' });
      });
      timer = setTimeout(function () { poll(id, code, expected); }, document.hidden ? 2000 : 200);
    });
  }
  function update(address, credential, state) {
    if (state.players !== 2) { if (session || creating) close(); return; }
    if (session || creating) return;
    if (!credential) { label('Laptop pairing is available in the installed TV app'); return; }
    base = address; token = credential; creating = true;
    var expected = generation;
    label('Connecting laptop controls…');
    request('POST', '/api/game/session', {}, function (error, result) {
      if (expected !== generation) {
        if (result.session) request('DELETE', '/api/game/session?session=' + encodeURIComponent(result.session), null, function () {}, address, credential);
        return;
      }
      creating = false;
      if (error) { label('Laptop unavailable · TV remote still works'); return; }
      session = result.session; poll(session, result.code, expected);
    });
  }
  window.addEventListener('pagehide', close);
  window.ontoGameBridge = { update: update, close: close };
})();
