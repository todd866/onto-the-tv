/* Tap versus hold, and where a scene jump lands. ES5: the TV's Chromium 47. */
window.ontoNav = (function () {
  var HOLD_MS = 600;
  var COMMIT_MS = 700;

  function initial() {
    return { down: null, pending: 0, commitAt: 0 };
  }

  function copy(state) {
    return {
      down: state.down ? { key: state.down.key, at: state.down.at, held: state.down.held } : null,
      pending: state.pending || 0,
      commitAt: state.commitAt || 0
    };
  }

  function wakeAt(state) {
    var at = 0;
    if (state.down && !state.down.held) at = state.down.at + HOLD_MS;
    if (state.pending && !state.down && (!at || state.commitAt < at)) at = state.commitAt;
    return at;
  }

  function clearPending(state) {
    state.pending = 0;
    state.commitAt = 0;
  }

  function fireHold(state, actions, key) {
    if (key === 'left' || key === 'right' || key === 'play') clearPending(state);
    actions.push({ type: 'hold', key: key });
  }

  function fireTap(state, actions, key, time, ad) {
    if ((key === 'right' || key === 'play') && ad) {
      actions.push({ type: 'skip-break' });
      return;
    }
    if (key === 'left' || key === 'right') {
      state.pending += key === 'right' ? 1 : -1;
      state.commitAt = time + COMMIT_MS;
      actions.push({ type: 'queue', delta: state.pending });
      return;
    }
    actions.push({ type: 'tap', key: key });
  }

  function release(state, actions, time, ad) {
    var down = state.down;
    state.down = null;
    if (!down || down.held) return;
    if (time - down.at >= HOLD_MS) fireHold(state, actions, down.key);
    else fireTap(state, actions, down.key, time, ad);
  }

  function maybeHold(state, actions, time) {
    if (!state.down || state.down.held) return;
    if (time - state.down.at < HOLD_MS) return;
    state.down.held = true;
    fireHold(state, actions, state.down.key);
  }

  function step(state, event) {
    var next = copy(state || initial());
    var actions = [];
    var type = event && event.type;
    var key = event && event.key;
    var time = event && event.time || 0;
    if (type === 'down' && key) {
      if (next.down && next.down.key === key) maybeHold(next, actions, time);
      else {
        if (next.down) release(next, actions, time, event.ad);
        next.down = { key: key, at: time, held: false };
      }
    } else if (type === 'up' && key) {
      if (next.down && next.down.key === key) release(next, actions, time, event.ad);
    } else if (type === 'tick') {
      if (next.down && !next.down.held) maybeHold(next, actions, time);
      if (!next.down && next.pending && time >= next.commitAt) {
        actions.push({ type: 'commit', delta: next.pending });
        clearPending(next);
      }
    }
    return { state: next, actions: actions, wakeAt: wakeAt(next) };
  }

  function scenePoints(cuts, duration) {
    var dur = (typeof duration === 'number' && duration > 1) ? duration : 0;
    var points = [0];
    var i, cut;
    if (!cuts) return points;
    for (i = 0; i < cuts.length; i++) {
      cut = Number(cuts[i]);
      if (cut > 0.05 && (!dur || cut < dur - 0.5)) points.push(cut);
    }
    return points;
  }

  function sceneTarget(time, duration, cuts, delta) {
    var dur = (typeof duration === 'number' && duration > 1) ? duration : 0;
    var points = scenePoints(cuts, dur);
    var jumped, index, into, back, target, i;
    if (points.length < 2) {
      jumped = time + delta * 60;
      if (jumped < 0) jumped = 0;
      if (dur && jumped > dur - 1) jumped = dur - 1;
      return jumped;
    }
    index = 0;
    for (i = 0; i < points.length; i++) if (points[i] <= time + 0.25) index = i;
    into = time - points[index];
    target = index;
    if (delta > 0) target = index + delta;
    else if (delta < 0) {
      back = -delta;
      if (into > 3) back = back - 1;
      target = index - back;
    }
    if (target < 0) target = 0;
    if (target > points.length - 1) target = points.length - 1;
    return points[target];
  }

  function segmentAt(time, segments) {
    var i, seg;
    if (!segments) return null;
    for (i = 0; i < segments.length; i++) {
      seg = segments[i];
      if (!seg) continue;
      if (time >= seg.start && time < seg.end) return seg;
    }
    return null;
  }

  return {
    HOLD_MS: HOLD_MS,
    COMMIT_MS: COMMIT_MS,
    initial: initial,
    step: step,
    scenePoints: scenePoints,
    sceneTarget: sceneTarget,
    segmentAt: segmentAt
  };
}());
