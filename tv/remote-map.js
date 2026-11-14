/* Playback remote: the Samsung map. Up and down never change channel. ES5. */
window.ontoRemoteMap = (function () {
  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232,
    CH_UP: 427, CH_DOWN: 428, SPACE: 32, INFO: 457
  };

  function decide(state, keyCode) {
    var overlay = state && state.overlay === 'open';
    var focus = overlay && state.focus ? state.focus : '';
    var repeat = !!(state && state.repeat);
    var key = keyCode;

    if (key === KEY.CH_UP || key === KEY.CH_DOWN) {
      if (repeat) return { type: 'none' };
      return { type: 'tune', direction: key === KEY.CH_UP ? 1 : -1 };
    }
    if (key >= 48 && key <= 57) {
      if (repeat) return { type: 'none' };
      return { type: 'digit', digit: key - 48 };
    }
    if (key === KEY.FF || key === KEY.RW) {
      if (repeat) return { type: 'none' };
      return { type: 'seek', seconds: key === KEY.FF ? 30 : -30 };
    }
    if (key === KEY.PLAY) return repeat ? { type: 'none' } : { type: 'play' };
    if (key === KEY.PAUSE) return repeat ? { type: 'none' } : { type: 'pause' };
    if (key === KEY.STOP) return repeat ? { type: 'none' } : { type: 'stop' };
    if (key === KEY.NEXT) return repeat ? { type: 'none' } : { type: 'next' };
    if (key === KEY.PREV) return repeat ? { type: 'none' } : { type: 'previous' };
    if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) {
      if (repeat) return { type: 'none' };
      return { type: overlay || focus ? 'close' : 'back' };
    }
    if (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) {
      if (repeat) return { type: 'none' };
      return { type: focus ? 'activate' : 'play-pause' };
    }
    if (key === KEY.UP || key === KEY.INFO) {
      if (repeat) return { type: 'none' };
      if (!overlay) return { type: 'show' };
      return { type: 'focus', row: 'transport' };
    }
    if (key === KEY.DOWN) {
      if (repeat) return { type: 'none' };
      if (!overlay) return { type: 'show' };
      return { type: 'focus', row: 'continue' };
    }
    if (key === KEY.LEFT || key === KEY.RIGHT) {
      var delta = key === KEY.RIGHT ? 1 : -1;
      if (focus === 'transport' || focus === 'continue') {
        if (repeat) return { type: 'none' };
        return { type: 'move', row: focus, delta: delta };
      }
      return { type: 'seek', seconds: (repeat ? 30 : 10) * delta };
    }
    return { type: 'none' };
  }

  return { KEY: KEY, decide: decide };
}());
