/* Local, best-effort diagnostics. Never transmit content names, paths or error text. */
(function () {
  'use strict';
  var config = window.ONTO_CONFIG || {}, server = (location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : ''), queue = [], busy = false;
  var session = 'tv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  var sample = function () { return {}; };
  var handled = {}, commandAck = null;
  var state = { page: 'home', engine: 'video', state: 'starting', position: 0, duration: 0, paused: true };
  var keys = ['page', 'engine', 'state', 'position', 'duration', 'paused', 'hidden', 'game', 'input', 'errorCode', 'controller', 'uke'];
  function flush() {
    if (busy || !server || !config.token || !queue.length) return;
    busy = true;
    var body = queue.shift();
    try {
      var request = new XMLHttpRequest();
      request.open('POST', server.replace(/\/$/, '') + '/api/diagnostics', true);
      request.timeout = 3000;
      request.setRequestHeader('Content-Type', 'application/json');
      request.setRequestHeader('X-Onto-Token', config.token);
      request.onloadend = function () {
        busy = false;
        if (request.status >= 200 && request.status < 300) {
          var reply; try { reply = JSON.parse(request.responseText); } catch (ignored) {}
          if (reply && reply.command) runCommand(reply.command);
          flush();
        }
      };
      request.send(JSON.stringify(body));
    } catch (e) { busy = false; }
  }
  function emit(event, fields) {
    try {
      var current = {};
      try { current = sample() || {}; } catch (e) { current = { state: 'error' }; }
      var body = { session: session, build: config.build || 'dev', event: event };
      fields = fields || {};
      keys.forEach(function (key) {
        if (key !== 'errorCode' && current[key] !== undefined) state[key] = current[key];
        if (key !== 'errorCode' && fields[key] !== undefined) state[key] = fields[key];
        if (state[key] !== undefined) body[key] = state[key];
      });
      if (window.ontoGamepad) body.controller = window.ontoGamepad.sample();
      body.hidden = !!document.hidden;
      if (commandAck) body.commandAck = commandAck;
      if (fields.errorCode) body.errorCode = fields.errorCode;
      if (event === 'heartbeat') queue = queue.filter(function (item) { return item.event !== 'heartbeat'; });
      queue.push(body);
      if (queue.length > 32) queue.shift();
      flush();
    } catch (e) { /* Observability must never interfere with the player. */ }
  }
  function runCommand(command) {
    if (!command || typeof command.id !== 'string' || command.id.length > 64 ||
        ['uke-open','uke-phone','uke-follow','uke-state'].indexOf(command.action) < 0 ||
        typeof command.expiresAt !== 'number' || command.expiresAt <= Date.now() || handled[command.id]) return;
    handled[command.id] = true;
    var ids=Object.keys(handled); if(ids.length>32) delete handled[ids[0]];
    Promise.resolve().then(function () {
      if (!window.ontoTVAction) throw Error('Unavailable');
      return window.ontoTVAction(command.action);
    }).then(function (uke) {
      commandAck={id:command.id,status:'done'}; emit('uke_state',{uke:uke});
    },function () {
      commandAck={id:command.id,status:'failed'}; emit('uke_state');
    });
  }
  window.ontoDiagnostics = {
    emit: emit,
    connect: function (base) { server = base; flush(); },
    sample: function (fn) { sample = fn; }
  };
  window.addEventListener('error', function (event) {
    emit('script_error', { state: 'error', errorCode: event.target && event.target !== window ? 'resource' : 'runtime' });
  }, true);
  window.addEventListener('unhandledrejection', function () { emit('script_error', { state: 'error', errorCode: 'unhandled' }); });
  setInterval(function () { emit('heartbeat'); }, 15000);
  emit('startup');
})();
