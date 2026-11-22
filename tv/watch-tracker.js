(function (root) {
  'use strict';
  root.ontoWatchTracker = function () {
    var last = null, lastWall = null;
    return {
      sample: function (time, playing, wall) {
        time = Number(time) || 0; wall = Number.isFinite(Number(wall)) ? Number(wall) : Date.now();
        if (last === null) { last = time; lastWall = wall; return 0; }
        var delta = time - last, wallDelta = wall - lastWall;
        last = time; lastWall = wall;
        if (!playing || delta <= 0 || delta > 5 || wallDelta < 0 || wallDelta > 20000) return 0;
        if (delta > wallDelta / 1000 * 1.5 + 0.5) return 0;
        return Math.min(delta, wallDelta / 1000);
      },
      rebase: function (time, wall) { last = Number(time) || 0; lastWall = Number.isFinite(Number(wall)) ? Number(wall) : Date.now(); }
    };
  };
}(window));
