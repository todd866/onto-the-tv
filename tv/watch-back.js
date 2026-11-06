/* Per-profile continue list and a 60s undo stack. ES5: the TV's Chromium 47. */
window.ontoWatchBack = (function () {
  var UNDO_MS = 60000;
  var UNDO_MAX = 5;
  var CONTINUE_MAX = 6;

  function text(value) {
    return String(value || '').replace(/^\s+|\s+$/g, '').slice(0, 120);
  }

  function copy(entry, at) {
    var channel = entry && entry.channel || {};
    var position = entry && entry.positionSeconds;
    if (typeof position !== 'number' || position !== position || position < 0) position = 0;
    return {
      src: text(entry && entry.src),
      title: text(entry && (entry.title || entry.show)),
      show: text(entry && (entry.show || entry.title)),
      art: text(entry && entry.art),
      positionSeconds: position,
      duration: entry && typeof entry.duration === 'number' && entry.duration > 0 ? entry.duration : 0,
      channel: { id: text(channel.id), number: channel.number, name: text(channel.name) },
      mode: entry && entry.mode === 'single' ? 'single' : 'channel',
      leftAt: at
    };
  }

  function create() {
    var recent = {};
    var stacks = {};

    function list(store, profile) {
      if (!store[profile]) store[profile] = [];
      return store[profile];
    }

    function prune(profile, at) {
      var stack = list(stacks, profile);
      var live = [];
      var i;
      for (i = 0; i < stack.length; i++) if (at - stack[i].leftAt < UNDO_MS) live.push(stack[i]);
      stacks[profile] = live.slice(-UNDO_MAX);
      return stacks[profile];
    }

    return {
      leave: function (profile, entry, at) {
        var snap = copy(entry, at);
        if (!snap.src) return null;
        var stack = prune(profile, at);
        var top = stack.length ? stack[stack.length - 1] : null;
        if (top && top.src === snap.src) stack[stack.length - 1] = snap;
        else stack.push(snap);
        if (stack.length > UNDO_MAX) stack.shift();
        this.note(profile, snap);
        return snap;
      },
      note: function (profile, entry) {
        var snap = copy(entry, entry && entry.leftAt || 0);
        if (!snap.src) return;
        var row = list(recent, profile);
        var kept = [];
        var i;
        for (i = 0; i < row.length; i++) if (row[i].src !== snap.src) kept.push(row[i]);
        kept.unshift(snap);
        recent[profile] = kept.slice(0, CONTINUE_MAX);
      },
      chip: function (profile, at) {
        var stack = prune(profile, at);
        return stack.length ? stack[stack.length - 1] : null;
      },
      undo: function (profile, at) {
        var stack = prune(profile, at);
        if (!stack.length) return null;
        return stack.pop();
      },
      continueList: function (profile) {
        var row = list(recent, profile);
        var copyRow = [];
        var i;
        for (i = 0; i < row.length && i < CONTINUE_MAX; i++) copyRow.push(row[i]);
        return copyRow;
      },
      save: function () {
        return { recent: recent, stacks: stacks };
      },
      load: function (saved) {
        recent = saved && saved.recent || {};
        stacks = saved && saved.stacks || {};
      }
    };
  }

  return { create: create, UNDO_MS: UNDO_MS, UNDO_MAX: UNDO_MAX, CONTINUE_MAX: CONTINUE_MAX };
})();
