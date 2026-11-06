/* A channel press shows a preview and commits after 1.5s, on OK, or cancels. ES5. */
window.ontoChannelArm = (function () {
  var DELAY_MS = 1500;

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
      cancel: function () { clear(); }
    };
  }

  return { create: create, DELAY_MS: DELAY_MS };
})();
