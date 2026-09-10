(function () {
  "use strict";
  const FLOOR = 0.15, CAP = 4, HISTORY_LIMIT = 50;
  // Duration bias. A file at or under SHORT_TARGET is never down-weighted; longer
  // files fall off as 1/duration so a four-hour compilation stops dominating a
  // shuffle that treats every file as one equal draw. SHORT_FLOOR keeps them reachable.
  const SHORT_TARGET = 900, SHORT_FLOOR = 0.05;
  const LOG_KEY = "kidshuffle.log.v1", LOG_LIMIT = 3000, SHORT_KEY = "kidshuffle.preferShort.v1";
  // Stream id -> tiers, mirroring STREAMS in make_shuffler.py. No stream is a
  // superset of another by accident: widening one means naming a tier here.
  const STREAMS = { 2:["preschool", "shared"], 6:["shared", "big"], grown:["grownup"], music:["music"],
    all:["preschool", "shared", "big", "older", "grownup", "music"] };
  const STREAM_LABELS = { 2:"Little Kids 2+", 6:"Big Kids 6+", grown:"Grown-ups", music:"Music", all:"Everything" };
  const keyFor = age => "kidshuffle.weights.v2.s" + age;
  const clamp = value => Math.max(FLOOR, Math.min(CAP, value));
  const weightFor = (weights, src) => typeof weights[src] === "number" && Number.isFinite(weights[src]) ? clamp(weights[src]) : 1;
  const encodePath = path => path.split("/").map(encodeURIComponent).join("/");
  const inStream = (video, age) => (STREAMS[age] || []).indexOf(video.tier) >= 0;
  function durationWeight(video, preferShort) {
    if (preferShort === false) return 1;
    const duration = video && video.duration;
    return Number.isFinite(duration) && duration > SHORT_TARGET ? Math.max(SHORT_FLOOR, SHORT_TARGET / duration) : 1;
  }

  function readStored(storage, age) {
    // The raw saved object, with no decay applied: the base for a merging write.
    try {
      const data = JSON.parse(storage.getItem(keyFor(age)));
      return data && typeof data === "object" && !Array.isArray(data) ? data : Object.create(null);
    } catch (_) { return Object.create(null); }
  }
  function readWeights(storage, age, videos) {
    const weights = Object.create(null);
    try {
      const data = JSON.parse(storage.getItem(keyFor(age)));
      if (!data || typeof data !== "object" || Array.isArray(data)) return weights;
      for (const video of videos) {
        if (Object.prototype.hasOwnProperty.call(data, video.src) && typeof data[video.src] === "number" && Number.isFinite(data[video.src])) {
          weights[video.src] = clamp(data[video.src]) * 0.75 + 0.25;
        }
      }
    } catch (_) { /* Private browsing and damaged saved data must not stop a show. */ }
    return weights;
  }
  function saveWeights(storage, age, weights) {
    try { storage.setItem(keyFor(age), JSON.stringify(weights)); return true; }
    catch (_) { return false; }
  }
  function appendLog(storage, entry) {
    // Append-only viewing record. Read-modify-write, so a second tab's entries are
    // kept rather than overwritten, and only the newest LOG_LIMIT survive.
    try {
      let log = [];
      try {
        const parsed = JSON.parse(storage.getItem(LOG_KEY));
        if (Array.isArray(parsed)) log = parsed;
      } catch (_) { /* Damaged history is replaced, never left blocking new records. */ }
      log.push(entry);
      storage.setItem(LOG_KEY, JSON.stringify(log.length > LOG_LIMIT ? log.slice(-LOG_LIMIT) : log));
      return true;
    } catch (_) { return false; }
  }
  function learnedWeight(current, reason, time, duration) {
    // Errors and initial playback never teach a preference. Completion comes first,
    // including short episodes that are already 80% watched before three minutes.
    if (reason !== "skip" && reason !== "ended") return current;
    if (reason === "ended" || (Number.isFinite(duration) && duration > 0 && time / duration >= 0.8)) return Math.min(CAP, current * 1.3);
    if (reason === "skip" && Number.isFinite(time) && time < 180) return Math.max(FLOOR, current * 0.7);
    return current;
  }
  function weightedChoice(items, weight, random) {
    let remaining = random() * items.reduce((total, item) => total + weight(item), 0);
    for (const item of items) { remaining -= weight(item); if (remaining < 0) return item; }
    return items[items.length - 1];
  }
  function pickVideo(videos, pool, weights, current, failed, history, random = Math.random, preferShort = true) {
    const available = pool.filter(index => !failed.has(index));
    if (!available.length) return -1;
    if (available.length === 1) return available[0];
    const recentCount = Math.min(5, available.length - 2);
    const recent = new Set(recentCount ? history.slice(-recentCount) : []);
    let candidates = available.filter(index => index !== current && !recent.has(index));
    if (!candidates.length) candidates = available.filter(index => index !== current);
    // Learned preference and length are independent: a loved episode stays likely,
    // a four-hour compilation stays rare, and a loved short episode wins outright.
    const pickWeight = index => weightFor(weights, videos[index].src) * durationWeight(videos[index], preferShort);
    const groups = new Map();
    for (const index of candidates) {
      const show = videos[index].channel || "Other";
      if (!groups.has(show)) groups.set(show, []);
      groups.get(show).push(index);
    }
    let shows = [...groups.keys()];
    const recentShows = history.slice(-2).map(index => videos[index].channel || "Other");
    const freshShows = shows.filter(show => !recentShows.includes(show));
    if (freshShows.length) shows = freshShows;
    else if (shows.length > 1 && recentShows.length) shows = shows.filter(show => show !== recentShows[recentShows.length - 1]);
    // Pick a show by its mean preference, then a file. A 70-episode catalog
    // therefore has the same initial chance as a show with seven episodes.
    const show = weightedChoice(shows, name => {
      const files = groups.get(name);
      return files.reduce((total, index) => total + pickWeight(index), 0) / files.length;
    }, random);
    return weightedChoice(groups.get(show), pickWeight, random);
  }

  function createPlayer(document, environment, videos) {
    const el = id => document.getElementById(id);
    const vid = el("vid"), splash = el("splash"), panel = el("panel");
    let storage;
    try { storage = environment.localStorage; } catch (_) { storage = null; }
    const state = { stream:null, pool:[], weights:Object.create(null), cur:-1, history:[], failed:new Set(), token:0, played:false,
      navigation:[], navIndex:-1, direction:1, pendingSeek:null, feedback:new Map(), dirty:new Set(),
      preferShort:true, visitLogged:false, visitStart:0 };
    let toastTimer = null;
    const random = environment.random || Math.random;
    const now = environment.now || (() => Date.now());
    try { state.preferShort = storage.getItem(SHORT_KEY) !== "0"; } catch (_) { state.preferShort = true; }
    if (new URLSearchParams(environment.location.search).get("audioQa") === "silent") vid.muted = true;

    function showToast(text) {
      el("toast").textContent = text;
      el("toast").style.opacity = "1";
      environment.clearTimeout(toastTimer);
      toastTimer = environment.setTimeout(() => { el("toast").style.opacity = "0"; }, 4500);
    }
    function status(message, retry) {
      el("statusText").textContent = message;
      el("status").hidden = !message;
      el("retry").hidden = !retry;
    }
    function saveFull() {
      // A decayed reload and a reset replace the whole record deliberately.
      if (!saveWeights(storage, state.stream, state.weights)) showToast("Preferences work for this session; this browser cannot save them.");
    }
    function save() {
      // Merge, so a second open tab's learning is never discarded by this one.
      const stored = readStored(storage, state.stream);
      for (const src of state.dirty) stored[src] = state.weights[src];
      if (!saveWeights(storage, state.stream, stored)) showToast("Preferences work for this session; this browser cannot save them.");
    }
    function logDeparture(reason) {
      // One record per visit to a video: what was reached, and where it began.
      if (state.stream === null || state.cur < 0 || state.visitLogged) return;
      const entry = state.navigation[state.navIndex];
      const time = state.pendingSeek ? (entry ? entry.time : 0) : vid.currentTime;
      const duration = state.pendingSeek ? (entry ? entry.duration : 0) : vid.duration;
      if (!state.played && !(time > 0)) return;
      state.visitLogged = true;
      const video = videos[state.cur];
      const fallback = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      appendLog(storage, {
        t: now(), s: state.stream, v: video.src, r: reason,
        w: Math.round(Number.isFinite(time) && time > 0 ? time : 0),
        p: Math.round(state.visitStart),
        d: Math.round(Number.isFinite(duration) && duration > 0 ? duration : fallback),
      });
    }
    function updatePause() { el("pause").textContent = vid.paused ? "Play ▶" : "Pause ⏸"; }
    function stopVideo() {
      state.cur = -1;
      state.token++;
      state.played = false;
      state.pendingSeek = null;
      vid.pause();
      vid.removeAttribute("src");
      vid.load();
    }
    function attemptPlay() {
      if (state.cur < 0 || state.stream === null) return;
      const token = state.token;
      status("", false);
      const rejected = error => {
        if (token !== state.token || state.cur < 0) return;
        if (error && error.name === "NotSupportedError") { next("error"); return; }
        status("Playback is paused. Tap below to start this episode.", true);
        updatePause();
      };
      try { Promise.resolve(vid.play()).catch(rejected); }
      catch (error) { rejected(error); }
    }
    function historyIndex(direction, from = state.navIndex) {
      for (let index = from + direction; index >= 0 && index < state.navigation.length; index += direction) {
        if (!state.failed.has(state.navigation[index].index)) return index;
      }
      return -1;
    }
    function updateNavigation() {
      el("back").disabled = state.stream === null || historyIndex(-1) < 0;
      el("skip").disabled = state.stream === null || !state.pool.some(index => !state.failed.has(index));
      el("pause").disabled = state.cur < 0;
    }
    function capturePosition() {
      const entry = state.navigation[state.navIndex];
      // A rapid second navigation must preserve the intended seek until metadata
      // arrives, rather than replacing it with the new element's initial zero.
      if (!entry || state.cur < 0) return;
      entry.played = entry.played || state.played;
      if (!state.pendingSeek) {
        if (Number.isFinite(vid.currentTime)) entry.time = Math.max(0, vid.currentTime);
        if (Number.isFinite(vid.duration) && vid.duration > 0) entry.duration = vid.duration;
      }
    }
    function applyFeedback(value, event) {
      return learnedWeight(value, event.reason, event.time, event.duration);
    }
    function recomputeFeedback(src) {
      const ledger = state.feedback.get(src);
      const value = ledger.events.reduce(applyFeedback, ledger.base);
      const changed = weightFor(state.weights, src) !== value;
      state.weights[src] = value;
      if (changed) { state.dirty.add(src); save(); }
    }
    function gradeEntry(reason) {
      const entry = state.navigation[state.navIndex];
      if (!entry || entry.graded) return;
      if (reason !== "skip" && reason !== "ended") return;
      const time = state.pendingSeek ? entry.time : vid.currentTime;
      const duration = state.pendingSeek ? entry.duration : vid.duration;
      if (!entry.played && !state.played && !(time > 0) && reason !== "ended") return;
      // An unobserved or neutral departure is not a final judgement. Returning
      // and finishing this entry must still be able to earn its first reward.
      if (learnedWeight(1, reason, time, duration) === 1) return;
      entry.graded = true;
      const src = videos[entry.index].src;
      if (!state.feedback.has(src)) state.feedback.set(src, { base:weightFor(state.weights, src), events:[] });
      // Keep even saturated/no-op events: removing an earlier skip may make
      // a later completion relevant when its floor/cap is recalculated.
      entry.feedback = { reason, time, duration, penalty:learnedWeight(1, reason, time, duration) < 1, retired:false };
      state.feedback.get(src).events.push(entry.feedback);
      recomputeFeedback(src);
    }
    function compactFeedback(src) {
      const ledger = state.feedback.get(src);
      while (ledger.events.length && ledger.events[0].retired) {
        ledger.base = applyFeedback(ledger.base, ledger.events.shift());
      }
      if (!ledger.events.length) state.feedback.delete(src);
    }
    function undoSkip(entry) {
      if (!entry.feedback || !entry.feedback.penalty) return;
      const src = videos[entry.index].src, ledger = state.feedback.get(src);
      ledger.events = ledger.events.filter(event => event !== entry.feedback);
      entry.feedback = null;
      entry.graded = false;
      recomputeFeedback(src);
      compactFeedback(src);
      // Returning cancels only the early-skip penalty. A later completion can
      // earn a reward; skipping again records one fresh, non-compounding vote.
    }
    function trimNavigation() {
      while (state.navigation.length > HISTORY_LIMIT) {
        const removed = state.navigation.shift();
        state.navIndex--;
        if (!removed.feedback) continue;
        const src = videos[removed.index].src;
        removed.feedback.retired = true;
        // Retired events can no longer be undone. Fold only a chronological
        // prefix, retaining the effect of every later independent observation.
        compactFeedback(src);
      }
    }
    function restorePosition() {
      const pending = state.pendingSeek;
      if (!pending || pending.token !== state.token || !isCurrentSource() || vid.readyState < 1) return;
      let time = pending.time;
      // Finished episodes replay from the start instead of immediately ending.
      if (Number.isFinite(vid.duration) && time >= vid.duration) time = 0;
      try {
        vid.currentTime = time;
        const entry = state.navigation[state.navIndex];
        if (Number.isFinite(vid.duration) && vid.duration > 0) entry.duration = vid.duration;
        state.pendingSeek = null;
      } catch (_) { /* Retry once playable if this browser cannot seek yet. */ }
    }
    function playEntry(index, direction) {
      state.navIndex = index;
      const entry = state.navigation[index];
      state.cur = entry.index;
      state.direction = direction;
      state.token++;
      state.played = false;
      state.pendingSeek = { token:state.token, time:entry.completed ? 0 : entry.time };
      state.visitLogged = false;
      state.visitStart = entry.completed ? 0 : entry.time;
      entry.completed = false;
      state.history.push(entry.index);
      state.history = state.history.slice(-6);
      updateNavigation();
      const video = videos[entry.index];
      vid.src = encodePath(video.path || video.src);
      showToast((video.channel ? video.channel + " — " : "") + video.title);
      attemptPlay();
    }
    function chooseNew() {
      const selected = pickVideo(videos, state.pool, state.weights, state.cur, state.failed, state.history, random, state.preferShort);
      if (selected < 0) {
        stopVideo();
        updateNavigation();
        status(state.pool.length ? "These episodes could not be played. Use Switch to choose a playlist or try again." : "No episodes are available in this playlist. Use Switch to choose another.", false);
        return;
      }
      state.navigation.push({ index:selected, time:0, duration:0, played:false, completed:false, graded:false, feedback:null });
      state.navIndex = state.navigation.length - 1;
      trimNavigation();
      playEntry(state.navIndex, 1);
    }
    function next(reason) {
      if (state.stream === null) return;
      capturePosition();
      logDeparture(reason);
      if (reason === "error" && state.cur >= 0) {
        state.failed.add(state.cur);
        gradeEntry("error");
        let direction = state.direction, target = historyIndex(direction);
        if (target < 0 && direction < 0) { direction = 1; target = historyIndex(1); }
        if (target >= 0) {
          if (direction < 0) undoSkip(state.navigation[target]);
          playEntry(target, direction);
          return;
        }
        chooseNew();
        return;
      }
      if (state.cur >= 0) {
        gradeEntry(reason);
        if (reason === "ended") state.navigation[state.navIndex].completed = true;
      }
      const target = historyIndex(1);
      if (target >= 0) playEntry(target, 1);
      else chooseNew();
    }
    function back() {
      if (state.stream === null) return;
      const target = historyIndex(-1);
      if (target < 0) return;
      capturePosition();
      logDeparture("back");
      undoSkip(state.navigation[target]);
      playEntry(target, -1);
    }
    function startStream(age) {
      stopVideo();
      state.stream = age;
      state.pool = videos.map((_, index) => index).filter(index => inStream(videos[index], age));
      state.weights = readWeights(storage, age, videos);
      state.dirty = new Set();
      state.history = [];
      state.navigation = [];
      state.navIndex = -1;
      state.direction = 1;
      state.feedback = new Map();
      state.failed = new Set();
      panel.hidden = true;
      splash.hidden = true;
      el("controls").hidden = false;
      saveFull();
      if (!document.fullscreenElement) toggleFullscreen();
      next("start");
    }
    function switchStream() {
      logDeparture("switch");
      state.stream = null;
      stopVideo();
      state.pool = [];
      state.weights = Object.create(null);
      state.dirty = new Set();
      state.history = [];
      state.navigation = [];
      state.navIndex = -1;
      state.direction = 1;
      state.feedback = new Map();
      state.failed = new Set();
      panel.hidden = true;
      status("", false);
      el("controls").hidden = true;
      splash.hidden = false;
      updateNavigation();
      environment.clearTimeout(toastTimer);
      el("toast").style.opacity = "0";
      if (document.fullscreenElement && document.exitFullscreen) Promise.resolve(document.exitFullscreen()).catch(() => {});
    }
    function togglePause() {
      if (state.cur < 0) return;
      if (vid.paused) attemptPlay(); else vid.pause();
      updatePause();
    }
    function setPreferShort(value) {
      state.preferShort = !!value;
      try { storage.setItem(SHORT_KEY, state.preferShort ? "1" : "0"); } catch (_) { /* A session-only choice still works. */ }
      const box = el("preferShort");
      if (box) box.checked = state.preferShort;
      showToast(state.preferShort ? "Short episodes preferred" : "Long compilations just as likely");
    }
    function showWeights() {
      if (state.stream === null) return;
      if (!panel.hidden) { panel.hidden = true; return; }
      el("panelTitle").textContent = "Preferences — " + (STREAM_LABELS[state.stream] || "Stream " + state.stream);
      const box = el("preferShort");
      if (box) box.checked = state.preferShort;
      const rows = el("weightRows");
      rows.replaceChildren();
      const sorted = state.pool.slice().sort((a, b) => weightFor(state.weights, videos[b].src) - weightFor(state.weights, videos[a].src));
      for (const index of sorted) {
        const video = videos[index], row = document.createElement("tr");
        for (const text of [video.channel, video.title, weightFor(state.weights, video.src).toFixed(2)]) {
          const cell = document.createElement("td");
          cell.textContent = text;
          row.appendChild(cell);
        }
        rows.appendChild(row);
      }
      panel.hidden = false;
    }
    async function toggleFullscreen() {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
        else if (vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();
        else showToast("Full screen is unavailable in this browser.");
      } catch (_) { showToast("Full screen is unavailable. You can keep watching here."); }
    }
    const isCurrentSource = () => state.cur >= 0 && (!vid.currentSrc || vid.currentSrc === vid.src);
    vid.addEventListener("ended", () => { if (isCurrentSource() && vid.ended) next("ended"); });
    // Source clearing/replacement can leave queued events from the old media.
    vid.addEventListener("error", () => { if (vid.error && isCurrentSource()) next("error"); });
    vid.addEventListener("loadedmetadata", restorePosition);
    vid.addEventListener("playing", () => { if (isCurrentSource()) { restorePosition(); state.played = true; status("", false); updatePause(); } });
    vid.addEventListener("pause", updatePause);
    for (const age of Object.keys(STREAMS)) {
      const button = el("s" + age);
      if (!button) continue;
      // A stream with nothing in it is not offered, so no button is ever a dead end.
      const stocked = videos.some(video => inStream(video, age));
      button.hidden = !stocked;
      if (stocked) button.addEventListener("click", () => startStream(age));
    }
    el("skip").addEventListener("click", () => next("skip"));
    el("back").addEventListener("click", back);
    el("switch").addEventListener("click", switchStream);
    el("pause").addEventListener("click", togglePause);
    el("retry").addEventListener("click", attemptPlay);
    el("preferences").addEventListener("click", showWeights);
    el("closePanel").addEventListener("click", () => { panel.hidden = true; });
    el("fullscreen").addEventListener("click", toggleFullscreen);
    const shortBox = el("preferShort");
    if (shortBox && shortBox.addEventListener) shortBox.addEventListener("change", () => setPreferShort(shortBox.checked));
    // Closing the tab is the commonest way a long compilation ends; record it.
    if (environment.addEventListener) environment.addEventListener("pagehide", () => logDeparture("hide"));
    el("reset").addEventListener("click", () => {
      if (state.stream !== null && environment.confirm("Reset learned preferences for this stream?")) {
        state.weights = Object.create(null);
        state.feedback = new Map();
        state.dirty = new Set();
        for (const entry of state.navigation) { entry.feedback = null; entry.graded = true; }
        saveFull();
        panel.hidden = true;
        showWeights();
        showToast("Preferences reset");
      }
    });
    document.addEventListener("fullscreenchange", () => { el("fullscreen").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; });
    document.addEventListener("keydown", event => {
      if (state.stream === null || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === "escape") { panel.hidden = true; return; }
      if (key === "w") { event.preventDefault(); showWeights(); return; }
      if (!panel.hidden) return;
      if (key === " " || event.code === "Space") { event.preventDefault(); togglePause(); }
      else if (key === "arrowleft") { event.preventDefault(); back(); }
      else if (key === "arrowright" || key === "s") { event.preventDefault(); next("skip"); }
      else if (key === "f") { event.preventDefault(); toggleFullscreen(); }
    });
    updateNavigation();
    return { state, next, back, startStream, switchStream, showWeights, togglePause, setPreferShort };
  }
  const api = { keyFor, weightFor, encodePath, durationWeight, inStream, STREAMS, STREAM_LABELS,
    readWeights, readStored, saveWeights, appendLog, learnedWeight, pickVideo, createPlayer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else createPlayer(document, window, VIDEOS);
})();
