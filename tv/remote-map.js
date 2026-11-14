/* Playback remote: the Samsung map (owner, 14 Nov 2026). ES5.
   Watching (nothing focused): every key acts at once.
       Up / Down      channel up / down          Left / Right   previous / next on this channel
       OK             pause and open the controls (OK again resumes)        Back   leave
   Controls open (something focused): the arrows navigate.
       transport row  Left / Right move, OK presses, Up to the progress line, Down or Back closes
       progress line  Left / Right seek 10 s (30 s while held), Down to the transport row, Up to Continue
   Seeking is deliberately out of the way: it is rare, and Left / Right are the best keys on the remote. */
window.ontoRemoteMap = (function () {
  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232,
    CH_UP: 427, CH_DOWN: 428, SPACE: 32, INFO: 457
  };

  function decide(state, keyCode) {
    var focus = state && state.focus ? state.focus : '';
    var repeat = !!(state && state.repeat);
    var key = keyCode;
    var delta;

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
      return { type: focus ? 'close' : 'back' };
    }
    if (key === KEY.INFO) return repeat ? { type: 'none' } : { type: 'focus', row: 'transport', fresh: true };
    if (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) {
      if (repeat) return { type: 'none' };
      if (focus === 'transport' || focus === 'continue') return { type: 'activate' };
      return { type: 'open' };
    }
    if (key === KEY.UP || key === KEY.DOWN) {
      if (repeat) return { type: 'none' };
      if (!focus) return { type: 'tune', direction: key === KEY.UP ? 1 : -1 };
      if (focus === 'transport') return key === KEY.UP ? { type: 'focus', row: 'scrub' } : { type: 'close' };
      if (focus === 'scrub') return { type: 'focus', row: key === KEY.UP ? 'continue' : 'transport' };
      return key === KEY.DOWN ? { type: 'focus', row: 'scrub' } : { type: 'none' };
    }
    if (key === KEY.LEFT || key === KEY.RIGHT) {
      delta = key === KEY.RIGHT ? 1 : -1;
      if (!focus) return repeat ? { type: 'none' } : { type: delta > 0 ? 'next' : 'previous' };
      if (focus === 'scrub') return { type: 'seek', seconds: (repeat ? 30 : 10) * delta };
      if (repeat) return { type: 'none' };
      return { type: 'move', row: focus, delta: delta };
    }
    return { type: 'none' };
  }

  return { KEY: KEY, decide: decide };
}());
