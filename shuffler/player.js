(function () {
  "use strict";
  const FLOOR = 0.15, CAP = 4, HISTORY_LIMIT = 50, SURF_SECONDS = 10, LONG_WATCH = 1.15;
  // Duration bias. A file at or under SHORT_TARGET is never down-weighted; longer
  // files fall off as 1/duration so a four-hour compilation stops dominating a
  // shuffle that treats every file as one equal draw. SHORT_FLOOR keeps them reachable.
  const SHORT_TARGET = 900, SHORT_FLOOR = 0.05;
  const LOG_KEY = "kidshuffle.log.v1", LOG_LIMIT = 3000, SHORT_KEY = "kidshuffle.preferShort.v1";
  const ADULT_KEY = "onto.adult.v1";
  // Stream id -> tiers, mirroring STREAMS in make_shuffler.py. No stream is a
  // superset of another by accident: widening one means naming a tier here.
  const STREAMS = { 2:["preschool", "shared"], 6:["shared", "big"], grown:["grownup"], mum:["grownup"], dad:["grownup"], both:["grownup"], music:["music"],
    all:["preschool", "shared", "big", "older", "grownup", "music"] };
  const STREAM_LABELS = { 2:"Little Kids 2+", 6:"Big Kids 6+", grown:"Grown-ups", mum:"Mum", dad:"Dad", both:"Both", music:"Music", all:"Everything" };
  const audienceFor = stream => String(stream).split(".")[0];
  const keyFor = age => "kidshuffle.weights.v2.s" + audienceFor(age);
  const clamp = value => Math.max(FLOOR, Math.min(CAP, value));
  const weightFor = (weights, src) => typeof weights[src] === "number" && Number.isFinite(weights[src]) ? clamp(weights[src]) : 1;
  const togetherWeight = (mum, dad, both = 1) => clamp((2 * clamp(mum) * clamp(dad) / (clamp(mum) + clamp(dad))) * clamp(both));
  const bookmarkKey = stream => ADULT_KEY + (audienceFor(stream) === "grown" ? "" : "." + audienceFor(stream));
  const encodePath = path => path.split("/").map(encodeURIComponent).join("/");
  const inStream = (video, age) => (STREAMS[String(age).split(".")[1] || age] || []).indexOf(video.tier) >= 0;
  function durationWeight(video, preferShort) {
    if (preferShort === false) return 1;
    const duration = video && video.duration;
    return Number.isFinite(duration) && duration > SHORT_TARGET ? Math.max(SHORT_FLOOR, SHORT_TARGET / duration) : 1;
  }

  function readStored(storage, age) {
    // The raw saved object is the base for a merging write.
    try {
      const data = JSON.parse(storage.getItem(keyFor(age)));
      return data && typeof data === "object" && !Array.isArray(data) ? data : Object.create(null);
    } catch (_) { return Object.create(null); }
  }
  function readWeights(storage, age, videos) {
    // A reload is not feedback: retain the exact saved preference.
    const weights = Object.create(null);
    try {
      const data = JSON.parse(storage.getItem(keyFor(age)));
      if (!data || typeof data !== "object" || Array.isArray(data)) return weights;
      for (const video of videos) {
        if (Object.prototype.hasOwnProperty.call(data, video.src) && typeof data[video.src] === "number" && Number.isFinite(data[video.src])) {
          weights[video.src] = clamp(data[video.src]);
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
  function learnedWeight(current, reason, time, duration, watched = time) {
    // Errors and initial playback never teach a preference. Only footage watched
    // during the visit counts, so resuming a bookmark near the end is not a
    // completion, and leaving at once after resuming teaches nothing.
    // Short episodes still complete before three minutes when most was watched.
    if (reason !== "skip" && reason !== "ended") return current;
    if (reason === "ended") return Math.min(CAP, current * 1.3);
    if (!Number.isFinite(time)) return current;
    const progress = Number.isFinite(watched) ? Math.max(0, watched) : 0;
    if (Number.isFinite(duration) && duration > 0 && time / duration >= 0.8) {
      return progress >= 180 || progress >= 0.8 * duration ? Math.min(CAP, current * 1.3) : current;
    }
    // Children surf with Next: most skips come about a second in and say only
    // "not this one right now". A real look that is then rejected is a dislike;
    // three minutes or more before moving on is a mild like.
    if (progress < SURF_SECONDS) return current;
    if (progress < 180) return Math.max(FLOOR, current * 0.7);
    return Math.min(CAP, current * LONG_WATCH);
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
    const represented = new Set(candidates.map(index => videos[index].channel || "Other"));
    const relief = new Map();
    for (const index of available) {
      const show = videos[index].channel || "Other";
      if (index === current || represented.has(show)) continue;
      if (!relief.has(show) || history.lastIndexOf(index) < history.lastIndexOf(relief.get(show))) relief.set(show, index);
    }
    const restored = new Set(relief.values());
    candidates.push(...restored);
    // Learned preference and length are independent: a loved episode stays likely,
    // a four-hour compilation stays rare, and a loved short episode wins outright.
    const pickWeight = index => weightFor(weights, videos[index].src) * durationWeight(videos[index], preferShort) * (restored.has(index) ? 0.25 : 1);
    const groups = new Map();
    for (const index of candidates) {
      const show = videos[index].channel || "Other";
      if (!groups.has(show)) groups.set(show, []);
      groups.get(show).push(index);
    }
    const shows = [...groups.keys()];
    const recentShows = history.slice(-2).map(index => videos[index].channel || "Other");
    // Variety is a soft preference: never force a rejected show merely because
    // the better-liked shows were played recently. Exhausted shows get one soft repeat.
    const recencyWeight = name => name === recentShows[recentShows.length - 1] ? 0.35
      : recentShows.includes(name) ? 0.65 : 1;
    // Pick a show by its mean preference, then a file. A 70-episode catalog
    // therefore has the same initial chance as a show with seven episodes.
    const show = weightedChoice(shows, name => {
      const files = groups.get(name);
      return recencyWeight(name) * files.reduce((total, index) => total + pickWeight(index), 0) / files.length;
    }, random);
    return weightedChoice(groups.get(show), pickWeight, random);
  }
  // Serial drama is watched in order: the shuffle chooses the show, the story
  // chooses the episode. A place under a minute is a sample, not a watch.
  const EPISODE = /\bS(\d{1,3})\s*E(\d{1,4})\b/i, WATCHING_SECONDS = 60;
  function episodeNumber(video) {
    const match = EPISODE.exec((video && (video.title || video.src)) || "");
    return match ? Number(match[1]) * 10000 + Number(match[2]) : null;
  }
  // Stopping during the credits finishes an episode as surely as reaching the end.
  const nearlyFinished = (time, duration) => Number.isFinite(time) && Number.isFinite(duration) && duration > 0
    && (time >= duration * 0.95 || (duration >= 1200 && duration - time <= 120));
  function watchedNow(place, video) {
    return !!place && place.time >= WATCHING_SECONDS && !nearlyFinished(place.time, video.duration);
  }
  function seriesNext(videos, available, show, places, finished, current = -1) {
    // places: src -> {time, updated}; finished: src -> when it was finished.
    const episodes = available.filter(index => (videos[index].channel || "Other") === show && episodeNumber(videos[index]) !== null)
      .sort((a, b) => episodeNumber(videos[a]) - episodeNumber(videos[b]));
    if (!episodes.length) return -1;
    const unfinished = position => episodes.slice(position).find(index => !finished.has(videos[index].src));
    let best = -1, bestAt = -Infinity, latest = -1, latestAt = -Infinity;
    episodes.forEach((index, position) => {
      const src = videos[index].src, place = places[src];
      if (watchedNow(place, videos[index]) && !finished.has(src) && (place.updated || 0) > bestAt) { best = index; bestAt = place.updated || 0; }
      if (finished.has(src) && finished.get(src) >= latestAt) { latest = position; latestAt = finished.get(src); }
    });
    if (latest >= 0 && latestAt >= bestAt) {
      const following = unfinished(latest + 1);
      if (following !== undefined) { best = following; bestAt = latestAt; }
    }
    if (best < 0) best = unfinished(0) ?? -1;
    // Skipping the current episode of a serial means the next one.
    if (best === current) best = unfinished(episodes.indexOf(current) + 1) ?? -1;
    return best;
  }

  function createPlayer(document, environment, videos) {
    const el = id => document.getElementById(id);
    const vid = el("vid"), splash = el("splash"), panel = el("panel");
    let storage;
    try { storage = environment.localStorage; } catch (_) { storage = null; }
    const state = { stream:null, pool:[], weights:Object.create(null), cur:-1, history:[], failed:new Set(), token:0, played:false,
      navigation:[], navIndex:-1, direction:1, pendingSeek:null, feedback:new Map(), dirty:new Set(),
      preferShort:true, avoidShow:null, visitLogged:false, visitStart:0, watchFrom:0, deferred:new Set(), scrubbing:false, cast:null };
    let toastTimer = null;
    let audience = null;
    const profileFlow = !!el("profiles");
    // Household names for the adult audiences; the defaults are only defaults.
    const names = Object.create(null);
    const configured = environment.ONTO_AUDIENCE_NAMES;
    if (configured && typeof configured === "object") for (const id of ["mum","dad","both"]) {
      const value = configured[id];
      if (typeof value === "string" && value.trim()) names[id] = value.trim().slice(0,40);
    }
    const labelFor = id => names[id] || STREAM_LABELS[id] || "Channel";
    for (const id of ["mum","dad","both"]) {
      if (!names[id]) continue;
      for (const button of [el("p" + id), el("s" + id)]) {
        const label = button && button.querySelector && button.querySelector(".channel-name");
        if (label) label.textContent = names[id];
      }
    }
    let controlsTimer = null, lastBookmarkSave = 0, resumeAfterSaved = false;
    let historyPlayedToken = null, lastHistorySave = -Infinity;
    let bookmarks = Object.create(null), exportEnabled = false;
    const TASTE_INTERVAL = 30000;
    let lastTaste = -Infinity, tasteTimer = null;
    function loadBookmarks() {
      bookmarks = Object.create(null);
      try {
        const raw = JSON.parse(storage.getItem(bookmarkKey(state.stream)));
        if (raw && typeof raw === 'object') for (const video of videos) {
          const value = raw[video.src];
          if (value && Number.isFinite(value.time) && value.time >= 0) {
            bookmarks[video.src] = {time:value.time, saved:!!value.saved, updated:Number(value.updated) || 0};
          }
        }
      } catch (_) {}
    }
    function publishTaste(force = false) {
      if (!exportEnabled || !environment.parent || environment.parent === environment) return;
      // Periodic position saves are batched; weight changes and leaving flush at once.
      const at = now();
      if (!force && at - lastTaste < TASTE_INTERVAL) {
        if (tasteTimer === null) tasteTimer = environment.setTimeout(() => { tasteTimer = null; publishTaste(true); }, TASTE_INTERVAL - (at - lastTaste));
        return;
      }
      environment.clearTimeout(tasteTimer); tasteTimer = null; lastTaste = at;
      const profiles = {};
      for (const id of ['grown','mum','dad','both']) {
        let places = {};
        try { places = JSON.parse(storage.getItem(bookmarkKey(id))) || {}; } catch (_) {}
        const weights = Object.create(null), clean = Object.create(null), raw = readStored(storage,id);
        for (const video of videos) {
          if (Number.isFinite(raw[video.src])) weights[video.src] = clamp(raw[video.src]);
          const value = places && places[video.src];
          if (value && Number.isFinite(value.time) && value.time >= 0) clean[video.src] = {
            time:value.time, saved:!!value.saved, updated:Number.isFinite(value.updated) && value.updated >= 0 ? value.updated : 0,
          };
        }
        profiles[id] = {weights, bookmarks:clean};
      }
      environment.parent.postMessage({type:'onto:taste', profiles}, '*');
    }
    function selectionWeights() {
      if (audienceFor(state.stream) !== 'both') return state.weights;
      const mum = readStored(storage,'mum'), dad = readStored(storage,'dad'), weights = Object.create(null);
      for (const video of videos) weights[video.src] = togetherWeight(weightFor(mum,video.src),weightFor(dad,video.src),weightFor(state.weights,video.src));
      return weights;
    }
    // While the TV has the channel, the TV's own reports are the playhead.
    const casting = () => state.cast !== null;
    const mediaTime = () => (casting() ? state.cast.position : vid.currentTime);
    const mediaDuration = () => {
      if (casting()) return state.cast.duration || (videos[state.cur] && videos[state.cur].duration) || 0;
      return vid.duration;
    };
    function tell(message) {
      if (!environment.parent || environment.parent === environment) return false;
      environment.parent.postMessage(message, '*');
      return true;
    }
    function reportState() {
      const current = state.cur >= 0 ? videos[state.cur] : null;
      const navigation = state.navigation.map(entry => {
        const video = videos[entry.index] || {};
        const factor = entry.feedback ? learnedWeight(1, entry.feedback.reason, entry.feedback.time, entry.feedback.duration, entry.feedback.watched) : 1;
        const current = entry === state.navigation[state.navIndex] && !state.pendingSeek;
        const time = current ? mediaTime() : entry.time;
        const watched = (entry.watched || 0) + (current ? Math.max(0, time - state.watchFrom) : 0);
        return { index:entry.index, src:video.src, time:time || 0, watched, played:!!entry.played,
          completed:!!entry.completed, graded:!!entry.graded, feedback:factor };
      });
      let viewingLog = [];
      try { const raw = JSON.parse(storage?.getItem(LOG_KEY)); if (Array.isArray(raw)) viewingLog = raw.slice(-50); } catch (_) {}
      return {
        stream: state.stream === null ? null : { id:state.stream, label:labelFor(audienceFor(state.stream)) + (String(state.stream).endsWith('.music') ? ' · Music' : '') },
        current: current ? { src:current.src, title:current.title, channel:current.channel, tier:current.tier, duration:mediaDuration() || current.duration || 0 } : null,
        mediaTime: Number.isFinite(mediaTime()) ? mediaTime() : 0, paused: casting() ? state.cast.status === 'paused' : !!vid.paused,
        preferShort:!!state.preferShort, navigation, navIndex:state.navIndex,
        history:state.history.slice(-20).map(index => videos[index]?.src).filter(Boolean),
        failed:[...state.failed].map(index => videos[index]?.src || index), deferred:[...state.deferred].map(index => videos[index]?.src || index),
        weights:Object.fromEntries(state.navigation.map(entry => videos[entry.index]?.src).filter(Boolean).map(src => [src, weightFor(state.weights, src)])),
        viewingLog, cast: state.cast ? {casting:true, plannedNext:state.cast.next ? {...state.cast.next, src:videos[state.cast.next.index]?.src || null} : null, lastTvStatus:lastTvStatus} : {casting:false, plannedNext:null, lastTvStatus:lastTvStatus},
        poolSize:state.pool.length,
      };
    }
    const reportSnapshots = new Map();
    let reportSequence = 0;
    function report(source) {
      const at = new Date(now()).toISOString();
      const reportId = String(++reportSequence);
      const snapshot = JSON.parse(JSON.stringify(reportState()));
      reportSnapshots.set(reportId, snapshot);
      if (reportSnapshots.size > 20) reportSnapshots.delete(reportSnapshots.keys().next().value);
      tell({type:'onto:report', source, at, reportId, state:snapshot});
    }
    function blackboxNotice(event, extra = {}) { tell({type:'onto:blackbox', event, ...extra}); }
    let reportFolder = null, reportIdle = null, lastTvStatus = null;
    function dismissReport() {
      const row = el('reportSaved'); if (!row) return;
      row.hidden = true; environment.clearTimeout(reportIdle); reportFolder = null;
    }
    function showReportSaved(data) {
      const row = el('reportSaved'); if (!row) return;
      reportFolder = data.folder || null;
      const at = data.at ? new Date(data.at) : new Date();
      const stamp = el('reportSavedAt'); if (stamp) { stamp.textContent = at.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false}); stamp.title = reportFolder || ''; }
      const input = el('reportNote'); if (input) input.value = '';
      row.hidden = false;
      environment.clearTimeout(reportIdle); reportIdle = environment.setTimeout(dismissReport, 20000);
    }
    function resetReportIdle() {
      if (!reportFolder) return;
      environment.clearTimeout(reportIdle); reportIdle = environment.setTimeout(dismissReport, 20000);
    }
    function saveReportNote() {
      if (!reportFolder) return dismissReport();
      const input = el('reportNote');
      tell({type:'onto:report-note', folder:reportFolder, note:input ? input.value : ''});
      dismissReport();
    }
    const random = environment.random || Math.random;
    const now = environment.now || (() => Date.now());
    function publishHistory(force = false, completed = false, reset = false) {
      // A new selection is only an intention until the local player or TV
      // confirms playback. In particular, pending cast attempts are not watches.
      if (state.cur < 0 || state.pendingSeek || historyPlayedToken !== state.token) return;
      const position = mediaTime(), duration = mediaDuration(), at = now();
      if (!Number.isFinite(position) || position < 0 || (!force && at - lastHistorySave < 5000)) return;
      const video = videos[state.cur];
      // Leaving during the credits finishes it; periodic saves stay positions.
      if (force && !reset && duration >= 1200 && duration - position <= 120) completed = true;
      if (tell({ type:'onto:history', src:video.src, title:video.title,
        positionSeconds:position, durationSeconds:Number.isFinite(duration) && duration > 0 ? duration : 0, completed, ...(reset ? {reset:true} : {}) })) lastHistorySave = at;
    }
    const adult = () => ['grown','mum','dad','both'].includes(audienceFor(state.stream));
    const clock = time => {
      const seconds = Math.max(0, Math.floor(Number(time) || 0));
      const hours = Math.floor(seconds / 3600);
      return (hours ? hours + ':' + String(Math.floor(seconds / 60) % 60).padStart(2,'0') : Math.floor(seconds / 60)) + ':' + String(seconds % 60).padStart(2,'0');
    };
    function saveBookmarks() {
      // Rows for files outside the current library are kept for when they return,
      // and saved-for-Later rows outrank automatic positions at the cap.
      const known = new Set(videos.map(video => video.src));
      const rows = [];
      try {
        const raw = JSON.parse(storage.getItem(bookmarkKey(state.stream)));
        if (raw && typeof raw === 'object') for (const [src, value] of Object.entries(raw)) {
          if (!known.has(src) && value && Number.isFinite(value.time) && value.time >= 0) {
            rows.push([src, {time:value.time, saved:!!value.saved, updated:Number(value.updated) || 0}]);
          }
        }
      } catch (_) {}
      rows.push(...Object.entries(bookmarks));
      rows.sort((a,b) => (b[1].saved - a[1].saved) || (b[1].updated - a[1].updated));
      const kept = rows.slice(0,500);
      bookmarks = Object.assign(Object.create(null), Object.fromEntries(kept.filter(([src]) => known.has(src))));
      try { storage.setItem(bookmarkKey(state.stream), JSON.stringify(Object.fromEntries(kept))); publishTaste(); return true; }
      catch (_) { showToast('Could not save your place.'); return false; }
    }
    function rememberPosition(finished = false, saved = false) {
      if (!adult() || state.cur < 0) return;
      const src = videos[state.cur].src;
      if (finished) delete bookmarks[src];
      else {
        const entry = state.navigation[state.navIndex];
        const time = state.pendingSeek ? entry.time : mediaTime();
        bookmarks[src] = { time:Number.isFinite(time) ? Math.max(0,time) : 0,
          saved:saved || !!bookmarks[src]?.saved, updated:now() };
      }
      return saveBookmarks();
    }
    function revealControls() {
      const controls = el('controls');
      controls.classList?.remove('dimmed');
      document.documentElement.classList?.remove('cursor-idle');
      environment.clearTimeout(controlsTimer);
      if (!adult() && !document.fullscreenElement) return;
      controlsTimer = environment.setTimeout(() => {
        const saved = el('savedPanel');
        if (!vid.paused && !casting() && !state.scrubbing && panel.hidden && (!saved || saved.hidden) && (el('reportSaved')?.hidden !== false) && !controls.querySelector?.(':focus-visible')) {
          controls.classList?.add('dimmed');
          if (document.fullscreenElement) document.documentElement.classList?.add('cursor-idle');
        }
      }, 3000);
    }
    function updateTimeline() {
      const seek = el('seek');
      if (!seek || !adult()) return;
      const length = mediaDuration(), position = mediaTime();
      const duration = Number.isFinite(length) && length > 0 ? length : 0;
      seek.disabled = !duration || state.cur < 0 || !!state.pendingSeek;
      seek.max = duration || 1;
      if (!state.scrubbing) seek.value = Number.isFinite(position) ? position : 0;
      el('elapsed').textContent = clock(seek.value);
      el('duration').textContent = clock(duration);
    }
    function seekTo(time) {
      const duration = mediaDuration();
      if (!adult() || state.cur < 0 || state.pendingSeek || !Number.isFinite(duration) || duration <= 0) return;
      const entry = state.navigation[state.navIndex];
      entry.sought = true;
      capturePosition();
      const target = Math.max(0,Math.min(duration,Number(time) || 0));
      if (casting()) {
        tell({ type:'onto:cast-seek', seconds:target });
        state.cast.position = target;
      } else {
        try { vid.currentTime = target; }
        catch (_) { showToast('Seeking is not available yet.'); }
      }
      if (Number.isFinite(mediaTime())) state.watchFrom = mediaTime();
      state.scrubbing = false;
      capturePosition(); rememberPosition(); publishHistory(true, false, true); updateTimeline(); revealControls();
    }
    function later() {
      if (!adult() || state.cur < 0) return;
      const saved = rememberPosition(false, true);
      state.deferred.add(state.cur);
      next('later');
      publishTaste(true);
      showToast(saved ? 'Saved for later' : 'Saved for this session only');
    }
    function resumeSaved(index) {
      if (!adult() || !state.pool.includes(index)) return;
      capturePosition(); rememberPosition(); logDeparture('select');
      state.deferred.delete(index);
      el('savedPanel').hidden = true;
      state.navigation.splice(state.navIndex + 1);
      state.navigation.push({ index, time:bookmarks[videos[index].src]?.time || 0, duration:0,
        played:false, completed:false, graded:false, feedback:null });
      trimNavigation(); playEntry(state.navigation.length - 1, 1);
    }
    function showSaved(all = false) {
      if (!adult()) return;
      resumeAfterSaved = !vid.paused;
      vid.pause(); rememberPosition();
      const rows = el('savedRows'); rows.replaceChildren();
      const saved = state.pool.filter(index => all || bookmarks[videos[index].src]?.saved);
      if (all) saved.sort((a,b) => videos[a].channel.localeCompare(videos[b].channel) || videos[a].title.localeCompare(videos[b].title, undefined, {numeric:true}));
      if (el('savedTitle')) el('savedTitle').textContent = all ? 'Episodes' : 'Later';
      for (const index of saved) {
        const button = document.createElement('button');
        const time = bookmarks[videos[index].src]?.time || 0;
        button.textContent = (index === state.cur ? '▶ ' : '') + videos[index].title + (time ? ' · Resume ' + clock(time) : ' · Play');
        button.addEventListener('click', () => resumeSaved(index)); rows.appendChild(button);
      }
      if (all && state.cur >= 0) {
        const current = videos[state.cur];
        const following = saved.find(index => videos[index].channel === current.channel && videos[index].title.localeCompare(current.title, undefined, {numeric:true}) > 0);
        if (following !== undefined) {
          const button = document.createElement('button');
          button.textContent = 'Next episode · ' + videos[following].title;
          button.addEventListener('click', () => resumeSaved(following)); rows.insertBefore(button, rows.firstChild);
        }
      }
      el('savedEmpty').hidden = saved.length > 0;
      el('savedPanel').hidden = false; revealControls();
    }
    function closeSaved() {
      el('savedPanel').hidden = true;
      if (resumeAfterSaved && state.cur >= 0) attemptPlay();
      revealControls();
    }
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
      // Preserve saved preferences when loading; Reset replaces them deliberately.
      if (!saveWeights(storage, state.stream, state.weights)) showToast("Preferences cannot be saved.");
      publishTaste(true);
    }
    function save() {
      // Merge, so a second open tab's learning is never discarded by this one.
      const stored = readStored(storage, state.stream);
      for (const src of state.dirty) stored[src] = state.weights[src];
      if (!saveWeights(storage, state.stream, stored)) showToast("Preferences cannot be saved.");
      publishTaste(true);
    }
    function logDeparture(reason) {
      // One record per visit to a video: what was reached, and where it began.
      if (state.stream === null || state.cur < 0) return;
      publishHistory(true, reason === 'ended');
      if (state.visitLogged) return;
      const entry = state.navigation[state.navIndex];
      const time = state.pendingSeek ? (entry ? entry.time : 0) : mediaTime();
      const duration = state.pendingSeek ? (entry ? entry.duration : 0) : mediaDuration();
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
    function updatePause() {
      const paused = casting() ? state.cast.status === 'paused' : vid.paused;
      const grown = adult();
      el("pause").textContent = paused ? (grown ? "Play" : "▶") : (grown ? "Pause" : "⏸");
    }
    function stopVideo() {
      hideUpNext();
      state.scrubbing = false;
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
        if (!state.failed.has(state.navigation[index].index) && (direction < 0 || !state.deferred.has(state.navigation[index].index))) return index;
      }
      return -1;
    }
    function updateNavigation() {
      el("back").disabled = state.stream === null || historyIndex(-1) < 0;
      el("skip").disabled = state.stream === null || !state.pool.some(index => !state.failed.has(index) && !state.deferred.has(index));
      el("pause").disabled = state.cur < 0;
      if (el('later')) el('later').disabled = state.cur < 0;
    }
    function capturePosition() {
      const entry = state.navigation[state.navIndex];
      // A rapid second navigation must preserve the intended seek until metadata
      // arrives, rather than replacing it with the new element's initial zero.
      if (!entry || state.cur < 0) return;
      entry.played = entry.played || state.played;
      if (!state.pendingSeek) {
        const at = mediaTime(), length = mediaDuration();
        if (Number.isFinite(at)) {
          entry.time = Math.max(0, at);
          // Footage watched since arriving or since the last seek, never a resumed position.
          entry.watched = (entry.watched || 0) + Math.max(0, at - state.watchFrom);
          state.watchFrom = at;
        }
        if (Number.isFinite(length) && length > 0) entry.duration = length;
      }
    }
    function applyFeedback(value, event) {
      return learnedWeight(value, event.reason, event.time, event.duration, event.watched);
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
      // Moving the playhead is not evidence of watching the intervening footage.
      // Keep that visit neutral; a fresh uninterrupted visit can still teach us.
      if (adult() && entry.sought) return;
      const video = videos[entry.index];
      const time = state.pendingSeek ? entry.time : mediaTime();
      // Before metadata arrives the catalogue duration keeps the verdict consistent.
      const catalogue = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const duration = (state.pendingSeek ? entry.duration : mediaDuration()) || catalogue;
      const watched = entry.watched || 0;
      if (!entry.played && !state.played && !(watched > 0) && reason !== "ended") return;
      // An unobserved or neutral departure is not a final judgement. Returning
      // and finishing this entry must still be able to earn its first reward.
      if (learnedWeight(1, reason, time, duration, watched) === 1) return;
      entry.graded = true;
      const src = video.src;
      if (!state.feedback.has(src)) state.feedback.set(src, { base:weightFor(state.weights, src), events:[] });
      // Keep even saturated/no-op events: removing an earlier skip may make
      // a later completion relevant when its floor/cap is recalculated.
      const factor = learnedWeight(1, reason, time, duration, watched);
      // A skip's verdict (early penalty or long-watch like) is provisional: Back undoes it.
      entry.feedback = { reason, time, duration, watched, penalty:factor < 1, undoable:factor < 1 || factor === LONG_WATCH, retired:false };
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
      if (!entry.feedback || !entry.feedback.undoable) return;
      const src = videos[entry.index].src, ledger = state.feedback.get(src);
      ledger.events = ledger.events.filter(event => event !== entry.feedback);
      entry.feedback = null;
      entry.graded = false;
      recomputeFeedback(src);
      compactFeedback(src);
      // Returning cancels a skip's provisional verdict. A later completion can
      // earn its reward; skipping again records one fresh, non-compounding vote.
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
        state.watchFrom = time;
        const entry = state.navigation[state.navIndex];
        if (Number.isFinite(vid.duration) && vid.duration > 0) entry.duration = vid.duration;
        state.pendingSeek = null;
      } catch (_) { /* Retry once playable if this browser cannot seek yet. */ }
    }
    function playEntry(index, direction, tv) {
      hideUpNext();
      state.scrubbing = false;
      state.navIndex = index;
      const entry = state.navigation[index];
      state.cur = entry.index;
      state.direction = direction;
      state.token++;
      state.played = false;
      lastHistorySave = -Infinity;
      state.pendingSeek = { token:state.token, time:entry.completed ? 0 : entry.time };
      state.visitLogged = false;
      state.visitStart = entry.completed ? 0 : entry.time;
      state.watchFrom = state.visitStart;
      entry.watched = 0;
      entry.sought = false;
      entry.completed = false;
      state.history.push(entry.index);
      state.history = state.history.slice(-20);
      updateNavigation();
      const video = videos[entry.index];
      blackboxNotice('navigation', {src:video.src, index:entry.index, reason:direction < 0 ? 'back' : 'play'});
      showToast((video.channel ? video.channel + " — " : "") + video.title);
      if (casting()) {
        state.cast = { path:video.src, position:state.pendingSeek ? state.pendingSeek.time : 0, duration:video.duration || 0, status:'playing' };
        state.pendingSeek = null;
        state.played = true;
        if (tv) {
          // The renderer already advanced. Adopting it must never send Play
          // again and restart the episode underneath the remote.
          state.cast.position = tv.positionSeconds || 0;
          state.cast.status = tv.status;
          state.cast.acked = true;
          state.watchFrom = 0;
          historyPlayedToken = state.token;
        } else tell({ type:'onto:cast-play', src:video.src, seconds:Math.round(state.watchFrom) || 0 });
      } else {
        vid.src = encodePath(video.path || video.src);
        attemptPlay();
      }
      updateTimeline(); revealControls();
    }
    function finishedEpisodes(includeCurrent) {
      // What this audience has finished, from the viewing log and from places
      // left in the credits. An unlogged finish still keeps the story moving.
      const finished = new Map();
      try {
        const log = JSON.parse(storage.getItem(LOG_KEY));
        if (Array.isArray(log)) for (const entry of log) {
          if (!entry || audienceFor(entry.s) !== audienceFor(state.stream)) continue;
          if (entry.r === "ended" || nearlyFinished(entry.w, entry.d)) finished.set(entry.v, Number(entry.t) || 0);
        }
      } catch (_) {}
      for (const video of videos) {
        const place = bookmarks[video.src];
        if (place && nearlyFinished(place.time, video.duration)) finished.set(video.src, Math.max(finished.get(video.src) || 0, place.updated));
      }
      // A replay after finishing reopens the episode only once it is properly under way.
      for (const video of videos) if (finished.has(video.src) && watchedNow(bookmarks[video.src], video) && bookmarks[video.src].updated > finished.get(video.src)) finished.delete(video.src);
      if (includeCurrent && state.cur >= 0) finished.set(videos[state.cur].src, now());
      return finished;
    }
    function pickNext(reason) {
      const available = state.pool.filter(index => !state.deferred.has(index) && !state.failed.has(index));
      if (adult() && reason === "start") {
        // Opening a channel picks up whatever this person was last watching.
        let latest = -1;
        for (const index of available) {
          const place = bookmarks[videos[index].src];
          if (watchedNow(place, videos[index]) && (latest < 0 || place.updated > bookmarks[videos[latest].src].updated)) latest = index;
        }
        if (latest >= 0) return latest;
      }
      // "Something else" leaves this show, unless it is all there is.
      const avoid = state.avoidShow; state.avoidShow = null;
      if (avoid !== null && available.some(index => (videos[index].channel || "Other") !== avoid)) {
        const others = available.filter(index => (videos[index].channel || "Other") !== avoid);
        available.length = 0; available.push(...others);
      }
      const ending = avoid === null && reason === "ended" && state.cur >= 0 && episodeNumber(videos[state.cur]) !== null;
      // Finishing an episode plays the next one; otherwise the shuffle picks the show.
      if (adult() && ending) {
        const following = seriesNext(videos, available, videos[state.cur].channel || "Other", bookmarks, finishedEpisodes(true), state.cur);
        if (following >= 0) return following;
      }
      const selected = pickVideo(videos, available, selectionWeights(), state.cur, state.failed, state.history.slice(-6), random, state.preferShort);
      if (!adult() || selected < 0 || episodeNumber(videos[selected]) === null) return selected;
      const story = seriesNext(videos, available, videos[selected].channel || "Other", bookmarks, finishedEpisodes(reason === "ended"), state.cur);
      return story >= 0 ? story : selected;
    }
    function chooseNew(selected = pickNext(), tv) {
      if (!state.pool.includes(selected) || state.failed.has(selected)) selected = pickNext();
      if (selected < 0) {
        stopVideo();
        updateNavigation();
        status(!state.pool.some(index => !state.deferred.has(index)) && state.deferred.size ? 'Everything’s saved for later.' : !state.pool.length ? 'No episodes on this channel.' : 'These episodes could not be played.', false);
        return;
      }
      state.navigation.push({ index:selected, time:adult() ? bookmarks[videos[selected].src]?.time || 0 : 0,
        duration:0, played:false, completed:false, graded:false, feedback:null });
      state.navIndex = state.navigation.length - 1;
      trimNavigation();
      playEntry(state.navIndex, 1, tv);
    }
    function next(reason, tv) {
      if (state.stream === null) return;
      blackboxNotice('navigation', {reason, src:state.cur >= 0 ? videos[state.cur]?.src : null});
      const planned = state.cast?.next;
      capturePosition();
      rememberPosition(reason === 'ended');
      logDeparture(reason);
      if (reason === "error" && state.cur >= 0) {
        state.failed.add(state.cur);
        gradeEntry("error");
        let direction = state.direction, target = historyIndex(direction);
        if (target < 0 && direction < 0) { direction = 1; target = historyIndex(1); }
        if (target >= 0) {
          if (direction < 0) { state.deferred.delete(state.navigation[target].index); undoSkip(state.navigation[target]); }
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
      if (target >= 0) playEntry(target, 1, tv);
      else chooseNew(planned ? planned.index : pickNext(reason), tv);
    }
    // A finished serial offers its next episode, counting down, or a change of show.
    const UP_NEXT_SECONDS = 10;
    let upNextTimer = null, upNextLeft = 0, upNextCount = null;
    function hideUpNext() {
      environment.clearTimeout(upNextTimer); upNextTimer = null;
      if (el('upNext')) el('upNext').hidden = true;
    }
    function upNextTick() {
      if (upNextCount) upNextCount.textContent = String(upNextLeft);
      if (upNextLeft <= 0) { hideUpNext(); next('ended'); return; }
      upNextLeft--;
      upNextTimer = environment.setTimeout(upNextTick, 1000);
    }
    function endOfEpisode() {
      const current = state.cur >= 0 ? videos[state.cur] : null;
      const available = state.pool.filter(index => !state.deferred.has(index) && !state.failed.has(index));
      const following = current && adult() && el('upNext') && episodeNumber(current) !== null
        ? seriesNext(videos, available, current.channel || "Other", bookmarks, finishedEpisodes(true), state.cur) : -1;
      if (following < 0) { next('ended'); return; }
      const button = el('upNextPlay'), label = document.createElement('span');
      label.textContent = '▶ Next episode · ' + videos[following].title;
      upNextCount = document.createElement('span'); upNextCount.className = 'count';
      button.replaceChildren(label, upNextCount);
      button.title = 'Plays in ' + UP_NEXT_SECONDS + ' s (Enter). Esc stays here.';
      el('upNext').hidden = false; revealControls();
      button.focus?.();
      upNextLeft = UP_NEXT_SECONDS; upNextTick();
    }
    function somethingElse() {
      if (state.cur < 0) return;
      hideUpNext();
      state.avoidShow = videos[state.cur].channel || "Other";
      next('ended');
    }
    function back() {
      if (state.stream === null) return;
      const target = historyIndex(-1);
      if (target < 0) return;
      capturePosition();
      rememberPosition();
      logDeparture("back");
      state.deferred.delete(state.navigation[target].index);
      undoSkip(state.navigation[target]);
      playEntry(target, -1);
    }
    function startStream(age) {
      blackboxNotice('stream-switch', {stream:age});
      rememberPosition(); logDeparture("switch");
      stopVideo();
      if (casting()) state.cast.next = null;
      state.stream = age;
      loadBookmarks();
      state.deferred = new Set(videos.map((video,index) => bookmarks[video.src]?.saved ? index : -1).filter(index => index >= 0));
      if (el('adultTools')) el('adultTools').hidden = !adult();
      if (el('adultTimeline')) el('adultTimeline').hidden = !adult();
      if (el('savedPanel')) el('savedPanel').hidden = true;
      state.pool = videos.map((_, index) => index).filter(index => inStream(videos[index], age));
      // Opening or switching channels is not new evidence about taste.
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
      updateChrome();
      saveFull();
      next("start");
    }
    function switchStream() {
      blackboxNotice('stream-switch', {stream:null, previous:state.stream});
      rememberPosition();
      logDeparture("switch");
      if (casting()) stopCasting('Back on the laptop', { resume:false });
      publishTaste(true);
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
      if (profileFlow) {
        el('profiles').hidden = false;
        el('streams').hidden = true;
        el('pickerTitle').textContent = 'Who’s watching?';
        el('audienceSwitch').hidden = true;
      }
      updateChrome();
      if (el('savedPanel')) el('savedPanel').hidden = true;
      updateNavigation();
      environment.clearTimeout(toastTimer);
      el("toast").style.opacity = "0";
      if (document.fullscreenElement && document.exitFullscreen) Promise.resolve(document.exitFullscreen()).catch(() => {});
    }
    function togglePause() {
      if (state.cur < 0) return;
      if (casting()) {
        const playing = state.cast.status !== 'paused';
        tell({ type: playing ? 'onto:cast-pause' : 'onto:cast-resume' });
        state.cast.status = playing ? 'paused' : 'playing';
        updatePause();
        return;
      }
      if (vid.paused) attemptPlay(); else vid.pause();
      updatePause();
    }
    function startCasting() {
      if (state.cur < 0 || casting()) return;
      capturePosition();
      const video = videos[state.cur];
      const position = state.pendingSeek ? state.pendingSeek.time : vid.currentTime;
      const seconds = Math.max(0, Math.round(Number.isFinite(position) ? position : 0));
      if (!tell({ type:'onto:cast-play', src:video.src, seconds })) { showToast('The TV is only available in the app.'); return; }
      vid.pause();
      state.cast = { path:video.src, position:seconds, duration:mediaDuration() || video.duration || 0, status:'playing' };
      state.pendingSeek = null;
      state.watchFrom = seconds;
      updateChrome(); updatePause(); updateTimeline();
      showToast('Playing on the TV');
    }
    function stopCasting(reason, { fromTv = false, resume = true, play = true } = {}) {
      if (!casting()) return;
      const at = state.cast.position;
      if (!fromTv) tell({ type:'onto:cast-stop' });
      state.cast = null;
      // Pick the episode back up on the laptop where the TV had reached. When
      // another source took the TV, keep that place but stay paused: this
      // channel may be hidden behind the app's other views.
      if (resume && state.cur >= 0) {
        const entry = state.navigation[state.navIndex];
        if (entry) entry.time = at;
        state.token++;
        state.pendingSeek = { token:state.token, time:at };
        state.watchFrom = at;
        vid.src = encodePath(videos[state.cur].path || videos[state.cur].src);
        if (play) attemptPlay();
      }
      updateChrome(); updatePause(); updateTimeline();
      showToast(reason || 'Back on the laptop');
    }
    function castReport(tv) {
      if (!tv) return;
      lastTvStatus = JSON.parse(JSON.stringify(tv));
      if (!casting()) return;
      if (tv.status === 'finished') {
        // A later poll of the same empty renderer must not skip again.
        if (state.cast.done || !state.cast.acked) return;
        state.cast.done = true;
        next('ended');
        return;
      }
      if (tv.status === 'idle') {
        stopCasting(tv.error || 'The TV stopped playing.', { fromTv:true });
        return;
      }
      if (tv.path && tv.path !== state.cast.path) {
        const planned = state.cast.next;
        const transition = tv.transition;
        if (!planned || videos[planned.index].src !== tv.path ||
            transition?.fromPath !== state.cast.path || transition.toPath !== tv.path ||
            !['playing','paused'].includes(tv.status)) return;
        if (Number.isFinite(transition.positionSeconds)) state.cast.position = transition.positionSeconds;
        if (Number.isFinite(transition.durationSeconds) && transition.durationSeconds > 0) state.cast.duration = transition.durationSeconds;
        next(transition.completed ? 'ended' : 'skip', tv);
      }
      state.cast.acked = true;
      state.cast.status = tv.status;
      if (Number.isFinite(tv.positionSeconds)) state.cast.position = tv.positionSeconds;
      if (Number.isFinite(tv.durationSeconds) && tv.durationSeconds > 0) state.cast.duration = tv.durationSeconds;
      if (tv.path === state.cast.path && tv.status === 'playing') historyPlayedToken = state.token;
      capturePosition(); rememberPosition(); publishHistory(); updatePause(); updateTimeline();
      queueCastNext();
    }
    function queueCastNext() {
      if (!casting() || !state.cast.acked) return;
      if (!state.cast.next) {
        const forward = historyIndex(1);
        // The lookahead is what follows a natural end on the TV.
        const index = forward >= 0 ? state.navigation[forward].index : pickNext("ended");
        if (index < 0 || index === state.cur) return;
        // A native next-track starts at zero. Keep resumed adult entries on the
        // existing software path so their saved places are not lost.
        const time = forward >= 0 ? (state.navigation[forward].completed ? 0 : state.navigation[forward].time) : (adult() ? bookmarks[videos[index].src]?.time || 0 : 0);
        state.cast.next = { index, software:time > 5, attempts:0 };
      }
      const plan = state.cast.next;
      if (plan.software || plan.pending || plan.queued || plan.attempts >= 2) return;
      plan.attempts++;
      plan.pending = tell({ type:'onto:cast-queue-next', src:videos[plan.index].src, currentSrc:state.cast.path, requestId:state.token });
    }
    function castQueueResult(result) {
      const plan = state.cast?.next;
      if (!plan || result.requestId !== state.token || result.currentSrc !== state.cast.path || result.src !== videos[plan.index].src) return;
      plan.pending = false;
      plan.queued = result.queued === true;
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
      el("panelTitle").textContent = "Preferences — " + labelFor(audienceFor(state.stream));
      const box = el("preferShort");
      if (box) box.checked = state.preferShort;
      const rows = el("weightRows");
      rows.replaceChildren();
      const shown = selectionWeights();
      const sorted = state.pool.slice().sort((a, b) => weightFor(shown, videos[b].src) - weightFor(shown, videos[a].src));
      for (const index of sorted) {
        const video = videos[index], row = document.createElement("tr");
        for (const text of [video.channel, video.title, weightFor(shown, video.src).toFixed(2)]) {
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
    vid.addEventListener("ended", () => { if (isCurrentSource() && vid.ended) endOfEpisode(); });
    // Source clearing/replacement can leave queued events from the old media.
    vid.addEventListener("error", () => { if (vid.error && isCurrentSource()) next("error"); });
    vid.addEventListener("loadedmetadata", restorePosition);
    vid.addEventListener("playing", () => { if (!casting() && isCurrentSource()) { restorePosition(); state.played = true; historyPlayedToken = state.token; publishHistory(); status("", false); updatePause(); revealControls(); } });
    vid.addEventListener("pause", () => { updatePause(); rememberPosition(); publishHistory(true); revealControls(); });
    vid.addEventListener('timeupdate', () => {
      if (!isCurrentSource()) return;
      updateTimeline();
      publishHistory();
      if (adult() && now() - lastBookmarkSave > 5000) { rememberPosition(); lastBookmarkSave = now(); }
    });
    vid.addEventListener('loadedmetadata', updateTimeline);
    document.addEventListener('pointermove', revealControls);
    document.addEventListener('pointerdown', revealControls);
    document.addEventListener('focusin', revealControls);
    document.addEventListener('visibilitychange', revealControls);
    if (el('seek')) {
      el('seek').addEventListener('input', () => { state.scrubbing = true; updateTimeline(); revealControls(); });
      el('seek').addEventListener('change', () => seekTo(el('seek').value));
      el('rewind').addEventListener('click', () => seekTo(mediaTime() - 10));
      el('forward').addEventListener('click', () => seekTo(mediaTime() + 10));
      el('later').addEventListener('click', later);
      el('saved').addEventListener('click', () => showSaved());
      el('closeSaved').addEventListener('click', closeSaved);
    }
    function chooseAudience(id) {
      if (!Object.prototype.hasOwnProperty.call(STREAMS,id) || ['music','all'].includes(id)) return;
      audience = String(id);
      try { storage.setItem('onto.audience.v1',audience); } catch (_) {}
      showChannels();
      // A child has one channel, so tapping their face starts it. Music is a
      // button on the player, not a menu standing between them and a show.
      if (['2','6'].includes(audience) && videos.some(video => inStream(video,audience))) startStream(audience);
    }
    function showChannels() {
      el('profiles').hidden = true; el('streams').hidden = false;
      el('pickerTitle').textContent = 'What’s on?';
      el('audienceSwitch').textContent = labelFor(audience).replace(/ [26]\+$/, '');
      el('audienceSwitch').hidden = false;
      for (const age of Object.keys(STREAMS)) {
        const button = el('s' + age); if (!button) continue;
        const allowed = ['2','6'].includes(audience) ? age === audience || age === 'music' : ['grown','music','all'].includes(age);
        button.hidden = !allowed || !videos.some(video => inStream(video,age));
      }
      const label = el('sgrown').querySelector?.('.channel-name');
      if (label) label.textContent = 'For you';
    }
    function musicStream() {
      // The music channel beside whichever audience is watching.
      if (!audience || !videos.some(video => video.tier === 'music')) return null;
      return audience === 'music' ? null : audience + '.music';
    }
    function updateChrome() {
      const grown = adult();
      const music = el('music');
      if (music) {
        const available = !grown && !!musicStream() && state.stream !== null;
        music.hidden = !available;
        music.textContent = audienceFor(state.stream) === audience && String(state.stream).endsWith('.music') ? 'Shows' : 'Music';
      }
      // Learned-preference tables are grown-up furniture; children get a show.
      if (el('preferences')) el('preferences').hidden = !grown;
      el('controls').className = grown ? '' : 'kid';
      el('back').textContent = grown ? 'Back' : '⏮';
      el('skip').textContent = grown ? 'Next' : '⏭';
      updatePause();
      const cast = el('cast');
      if (cast) {
        cast.hidden = state.stream === null || !environment.parent || environment.parent === environment;
        cast.textContent = casting() ? 'Stop the TV' : 'Onto the TV';
        cast.className = casting() ? 'utility casting' : 'utility';
      }
    }
    function toggleMusic() {
      const target = musicStream();
      if (!target || state.stream === null) return;
      startStream(String(state.stream).endsWith('.music') ? audience : target);
    }
    function chooseChannel(age) {
      if (!profileFlow) return startStream(age);
      if (!audience) return;
      const allowed = ['2','6'].includes(audience) ? age === audience || age === 'music' : ['grown','music','all'].includes(age);
      if (!allowed) return;
      startStream(age === 'grown' || age === audience ? audience : audience + '.' + age);
    }
    for (const age of Object.keys(STREAMS)) {
      const button = el("s" + age);
      if (!button) continue;
      const enabled = environment.ONTO_AUDIENCES === true;
      const stocked = (age === "grown" ? !enabled : ["mum","dad","both"].includes(age) ? enabled : true) && videos.some(video => inStream(video, age));
      button.hidden = profileFlow || !stocked;
      if (profileFlow || stocked) button.addEventListener("click", () => chooseChannel(age));
      const profile = el('p' + age);
      if (profile) {
        const available = ['2','6'].includes(age) ? stocked : videos.length > 0 && (age === 'grown' ? !enabled : enabled);
        profile.hidden = !available;
        if (available) profile.addEventListener('click', () => chooseAudience(age));
      }
    }
    if (profileFlow) {
      el('audienceSwitch').addEventListener('click', () => {
        el('profiles').hidden = false; el('streams').hidden = true;
        el('pickerTitle').textContent = 'Who’s watching?'; el('audienceSwitch').hidden = true;
      });
      // Turning the app on is like turning a television on: the family-friendly
      // channel plays. Changing viewer or channel is a deliberate step from here.
      const opening = ['2','6','grown','mum','dad','both'].find(id => {
        const button = el('p'+id);
        return button && !button.hidden && videos.some(video => inStream(video,id));
      });
      if (opening) chooseAudience(opening);
    }
    if (el('music')) el('music').addEventListener('click', toggleMusic);
    if (el('cast')) el('cast').addEventListener('click', () => (casting() ? stopCasting() : startCasting()));
    el("skip").addEventListener("click", () => next("skip"));
    el("back").addEventListener("click", back);
    el("switch").addEventListener("click", switchStream);
    el("pause").addEventListener("click", togglePause);
    el("retry").addEventListener("click", attemptPlay);
    el("preferences").addEventListener("click", showWeights);
    el("closePanel").addEventListener("click", () => { panel.hidden = true; });
    el("fullscreen").addEventListener("click", toggleFullscreen);
    // A click on the picture pauses or plays; waiting out a double-click keeps
    // fullscreen from also flickering the pause. A tap only reveals the controls.
    let clickTimer = null;
    vid.addEventListener("click", event => {
      if (event.pointerType === "touch" || state.cur < 0) return;
      environment.clearTimeout(clickTimer);
      clickTimer = environment.setTimeout(() => { clickTimer = null; togglePause(); revealControls(); }, 250);
    });
    vid.addEventListener("dblclick", event => { event.preventDefault(); environment.clearTimeout(clickTimer); clickTimer = null; toggleFullscreen(); });
    if (el("episodes")) el("episodes").addEventListener("click", () => showSaved(true));
    if (el("upNextPlay")) el("upNextPlay").addEventListener("click", () => { hideUpNext(); next('ended'); });
    if (el("upNextOther")) el("upNextOther").addEventListener("click", somethingElse);
    if (el("report")) el("report").addEventListener("click", () => report('button'));
    if (el("reportDone")) el("reportDone").addEventListener("click", saveReportNote);
    if (el("reportNote")) el("reportNote").addEventListener("input", resetReportIdle);
    if (el("reportNote")) el("reportNote").addEventListener("keydown", event => { resetReportIdle(); if (event.key === 'Enter') { event.preventDefault(); saveReportNote(); } else if (event.key === 'Escape') { event.preventDefault(); dismissReport(); } });
    if (el("reportSaved")) el("reportSaved").addEventListener("pointerdown", resetReportIdle);
    const shortBox = el("preferShort");
    if (shortBox && shortBox.addEventListener) shortBox.addEventListener("change", () => setPreferShort(shortBox.checked));
    // Closing the tab is the commonest way a long compilation ends; record it.
    if (environment.addEventListener) environment.addEventListener("pagehide", () => { rememberPosition(); publishTaste(true); logDeparture("hide"); });
    el("reset").addEventListener("click", () => {
      if (state.stream !== null && environment.confirm("Reset learned preferences for the episodes on this channel?")) {
        // Only this channel's episodes: the audience's other channels share the key.
        for (const index of state.pool) delete state.weights[videos[index].src];
        state.feedback = new Map();
        state.dirty = new Set();
        for (const entry of state.navigation) { entry.feedback = null; entry.graded = true; }
        saveFull();
        panel.hidden = true;
        showWeights();
        showToast("Preferences reset");
      }
    });
    document.addEventListener("fullscreenchange", () => { revealControls(); el("fullscreen").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; });
    document.addEventListener("keydown", event => {
      revealControls();
      if (event.key === 'Escape' && document.fullscreenElement) { event.preventDefault(); Promise.resolve(document.exitFullscreen()).catch(() => {}); }
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (event.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === "r") { event.preventDefault(); report('key'); return; }
      if (key === "escape" && el('reportSaved') && !el('reportSaved').hidden) { dismissReport(); return; }
      if (state.stream === null) return;
      if (key === "escape" && el('upNext') && !el('upNext').hidden) { hideUpNext(); return; }
      if (key === "escape") { if (el('reportSaved') && !el('reportSaved').hidden) dismissReport(); panel.hidden = true; if (el('savedPanel') && !el('savedPanel').hidden) closeSaved(); return; }
      if (el('savedPanel') && !el('savedPanel').hidden) return;
      if (key === "w") { event.preventDefault(); showWeights(); return; }
      if (!panel.hidden) return;
      if (key === " " || event.code === "Space") { event.preventDefault(); togglePause(); }
      else if (key === "arrowleft") { event.preventDefault(); if (adult() && event.shiftKey) seekTo(mediaTime() - 10); else back(); }
      else if (key === "arrowright" || key === "s") { event.preventDefault(); if (adult() && event.shiftKey && key === 'arrowright') seekTo(mediaTime() + 10); else next("skip"); }
      else if (key === 'l' && adult()) { event.preventDefault(); later(); }
      else if (key === "f") { event.preventDefault(); toggleFullscreen(); }
    });
    if (environment.addEventListener) environment.addEventListener("message", event => {
      if (event.source !== environment.parent || !event.data) return;
      if (event.data.type === 'onto:export' && environment.ONTO_TASTE_TOKEN && event.data.token === environment.ONTO_TASTE_TOKEN) {
        exportEnabled = true; publishTaste(true);
      }
      if (event.data.type === 'onto:tv') castReport(event.data.tv);
      if (event.data.type === 'onto:cast-queue-result') castQueueResult(event.data);
      if (event.data.type === 'onto:cast-off') stopCasting(event.data.reason || 'The TV stopped playing.', { fromTv:true, play:event.data.resume !== false });
      if (event.data.type === "onto:pause") vid.pause();
      if (event.data.type === 'onto:report-state') {
        const reportId = event.data.reportId;
        const snapshot = reportId ? reportSnapshots.get(reportId) || {unavailable:true} : reportState();
        tell({type:'onto:report-state-result', requestId:event.data.requestId, state:snapshot});
        if (reportId) reportSnapshots.delete(reportId);
      }
      if (event.data.type === 'onto:report-saved') showReportSaved(event.data);
      if (event.data.type === 'onto:report-dismiss') dismissReport();
    });
    if (environment.addEventListener) {
      environment.addEventListener('error', event => blackboxNotice('renderer-error', {message:String(event?.message || event || '').slice(0,240)}));
      environment.addEventListener('unhandledrejection', event => blackboxNotice('renderer-error', {message:String(event?.reason || '').slice(0,240)}));
    }
    updateNavigation();
    updateChrome();
    publishTaste();
    return { state, next, back, startStream, switchStream, showWeights, togglePause, setPreferShort, seekTo, later, showSaved, resumeSaved, chooseAudience, chooseChannel, toggleMusic, startCasting, stopCasting };
  }
  const api = { togetherWeight, bookmarkKey, keyFor, weightFor, encodePath, durationWeight, inStream, STREAMS, STREAM_LABELS,
    readWeights, readStored, saveWeights, appendLog, learnedWeight, pickVideo, episodeNumber, seriesNext, createPlayer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else createPlayer(document, window, VIDEOS);
})();
