(function (root) {
  'use strict';
  root.ontoWatchDelivery = function (send, storage, scope, schedule, report) {
    report = report || function () {};
    var key = 'onto.watch.pending.v1', queue = [], busy = false, timer = null;
    schedule = schedule || function (fn, ms) { return setTimeout(fn, ms); };
    try { var saved = JSON.parse(storage.getItem(key)); if (saved && saved.scope === scope && Array.isArray(saved.events)) queue = saved.events.slice(0, 512); } catch (_) {}
    function persist() { try { storage.setItem(key, JSON.stringify({ scope: scope, events: queue })); return true; } catch (_) { report('watch-storage-unavailable'); return false; } }
    persist();
    try { var oldRejected = JSON.parse(storage.getItem(key + '.rejected')); if (!oldRejected || oldRejected.scope !== scope) storage.setItem(key + '.rejected', JSON.stringify({scope:scope,events:[]})); } catch (_) {}
    function drain() {
      if (busy || !queue.length) return;
      busy = true;
      var event = queue[0];
      Promise.resolve().then(function () { return send(event); }).then(function () {
        queue.shift(); persist(); busy = false; drain();
      }, function (error) {
        busy = false;
        if (error && (error.status === 400 || error.status === 404)) {
          // A removed video or expired event must not block every later session.
          // Retain bounded rejection evidence separately, and surface the loss.
          try {
            var rejected = JSON.parse(storage.getItem(key + '.rejected'));
            rejected = rejected && rejected.scope === scope && Array.isArray(rejected.events) ? rejected.events : [];
            rejected.push({event:event,status:error.status});
            storage.setItem(key + '.rejected', JSON.stringify({scope:scope,events:rejected.slice(-50)}));
          } catch (_) {}
          queue.shift(); persist(); report('watch-event-rejected-' + error.status); drain(); return;
        }
        if (!timer) timer = schedule(function () { timer = null; drain(); }, 5000);
      });
    }
    return {
      enqueue: function (event) {
        // A later cumulative progress heartbeat supersedes an unsent heartbeat,
        // but never a start, pause, ending or the request currently in flight.
        for (var i = queue.length - 1; i >= (busy ? 1 : 0); i--) {
          if (queue[i].sessionId === event.sessionId && queue[i].reason === 'progress' && event.reason === 'progress') { queue.splice(i, 1); break; }
        }
        if (queue.length >= 512) return false;
        queue.push(event); var saved = persist(); drain(); return saved;
      },
      drain: drain,
      pending: function () { return queue.length; }
    };
  };
}(window));
