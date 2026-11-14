/* Playback remote: the map for the One For All Samsung remote in the lounge (owner, 14 Nov 2026). ES5.
   The arrows only ever move focus; they never change what is on (one arrow press lost a live set).
   Every other action sits on the key printed for it:
       arrows         watching: show the controls (focus on play / pause). In the controls: move.
                      transport row: Up to the Continue strip, Down closes.
       OK             watching: pause and open the controls. In the controls: press the focused button.
       RETURN         close the controls, else leave (or undo the last change of show)
       CH up / down   channel up / down          0-9   channel number          PRE-CH   back to what was on
       GUIDE, CH LIST the channel grid (home)
       rewind / fwd   seek mode: the picture holds, each press moves the marker 10 s (faster while held);
                      OK or play goes there, RETURN goes back to where it was. Arrows do nothing here.
       pause play stop   as printed
       A red          previous        B green   like        D blue   next
       TOOLS          options         SUBT.     subtitles
   INFO (the remote guide) is handled by the app before this map, on every page. */
window.ontoRemoteMap = (function () {
  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232,
    CH_UP: 427, CH_DOWN: 428, SPACE: 32, INFO: 457,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    TOOLS: 10135, GUIDE: 458, CH_LIST: 10073, PRE_CH: 10190, SUBT: 10221
  };

  function decide(state, keyCode) {
    var focus = state && state.focus ? state.focus : '';
    var repeat = !!(state && state.repeat);
    var key = keyCode;
    var once = function (action) { return repeat ? { type: 'none' } : action; };

    // Seeking: the two keys printed for it, and nothing else. Held keys keep stepping.
    if (key === KEY.FF || key === KEY.RW) return { type: 'scrub', direction: key === KEY.FF ? 1 : -1, held: repeat };
    if (focus === 'seek') {
      if (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE || key === KEY.PLAY || key === KEY.PAUSE) return once({ type: 'scrub-commit' });
      if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) return once({ type: 'scrub-cancel' });
      if (key === KEY.UP || key === KEY.DOWN || key === KEY.LEFT || key === KEY.RIGHT) return { type: 'none' };
    }
    if (key === KEY.CH_UP || key === KEY.CH_DOWN) return once({ type: 'tune', direction: key === KEY.CH_UP ? 1 : -1 });
    if (key >= 48 && key <= 57) return once({ type: 'digit', digit: key - 48 });
    if (key === KEY.PLAY) return once({ type: 'play' });
    if (key === KEY.PAUSE) return once({ type: 'pause' });
    if (key === KEY.STOP) return once({ type: 'stop' });
    if (key === KEY.NEXT || key === KEY.BLUE) return once({ type: 'next' });
    if (key === KEY.PREV || key === KEY.RED) return once({ type: 'previous' });
    if (key === KEY.GREEN) return once({ type: 'like' });
    if (key === KEY.TOOLS) return once({ type: 'options' });
    if (key === KEY.SUBT) return once({ type: 'subs' });
    if (key === KEY.GUIDE || key === KEY.CH_LIST) return once({ type: 'home' });
    if (key === KEY.PRE_CH) return once({ type: 'last' });
    if (key === KEY.BACK || key === KEY.ESC || key === KEY.BACKSPACE) return once({ type: focus ? 'close' : 'back' });
    if (key === KEY.ENTER || key === KEY.PLAYPAUSE || key === KEY.SPACE) {
      if (focus === 'transport' || focus === 'continue') return once({ type: 'activate' });
      return once({ type: 'open' });
    }
    // Arrows: focus only.
    if (key === KEY.UP || key === KEY.DOWN) {
      if (repeat) return { type: 'none' };
      if (!focus) return { type: 'focus', row: 'transport', fresh: true };
      if (focus === 'transport') return key === KEY.UP ? { type: 'focus', row: 'continue' } : { type: 'close' };
      if (focus === 'continue') return key === KEY.DOWN ? { type: 'focus', row: 'transport' } : { type: 'none' };
      return { type: 'none' };
    }
    if (key === KEY.LEFT || key === KEY.RIGHT) {
      if (repeat) return { type: 'none' };
      if (!focus) return { type: 'focus', row: 'transport', fresh: true };
      if (focus === 'transport' || focus === 'continue') return { type: 'move', row: focus, delta: key === KEY.RIGHT ? 1 : -1 };
      return { type: 'none' };
    }
    return { type: 'none' };
  }

  return { KEY: KEY, decide: decide };
}());
