/* A channel press shows its card at once and tunes after DELAY_MS (long enough only to flip past channels
   without loading each one; it was 1.5 s until 14 Nov 2026, which read as a slow TV), or at once on OK. ES5. */
window.ontoChannelArm = (function () {
  var DELAY_MS = 350;

  function create() {
    var armed = null;

    function clear() { armed = null; }

    return {
      delay: DELAY_MS,
      press: function (target, now) {
        if (!target || !target.id) return { type: 'none' };
        if (armed && armed.target.id === target.id) {
          clear();
          return { type: 'cancel' };
        }
        armed = { target: target, at: now };
        return { type: 'preview', target: target, commitAt: now + DELAY_MS };
      },
      ok: function () {
        if (!armed) return { type: 'none' };
        var target = armed.target;
        clear();
        return { type: 'commit', target: target };
      },
      tick: function (now) {
        if (!armed) return { type: 'none' };
        if (now < armed.at + DELAY_MS) return { type: 'wait', commitAt: armed.at + DELAY_MS };
        var target = armed.target;
        clear();
        return { type: 'commit', target: target };
      },
      target: function () { return armed ? armed.target : null; },
      cancel: function () { clear(); }
    };
  }

  return { create: create, DELAY_MS: DELAY_MS };
})();
