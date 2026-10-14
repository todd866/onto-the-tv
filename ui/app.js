const api = window.tv;
const $ = id => document.getElementById(id);
let mode = 'local';
let latestTv;
let busy = false;
let loadedLibrary = null;
let seekTimer;
let pendingSeek = null;
let seekVersion = 0;
let scrubbing = false;
const historyRows = new Map();
let pointsSignature = '';
let libraryItems = [];
let libraryLoaded = false;
let libraryLoading;
let libraryFilter = 'home';
const libraryArtwork = new Map();
const libraryCards = new Set();
const artworkObserver = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    artworkObserver.unobserve(entry.target);
    const { path } = entry.target.dataset;
    if (!api?.libraryArtwork) continue;
    if (!libraryArtwork.has(path)) libraryArtwork.set(path, api.libraryArtwork(path).catch(() => null).then(url => {
      if (!url) libraryArtwork.delete(path);
      return url;
    }));
    void libraryArtwork.get(path).then(async url => {
      if (!url || !entry.target.isConnected) return;
      const image = entry.target.querySelector('img');
      image.src = url;
      try { await image.decode(); image.classList.add('ready'); } catch {}
    });
  }
}, { rootMargin:'200px' });

function message(text = '', fault = false) {
  $('status').textContent = text;
  $('status').classList.toggle('is-fault', fault);
}

async function act(work) {
  try { return await work(); }
  catch (error) { message(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
}

function setMode(value) {
  if (value !== 'local') $('channel-player').contentWindow?.postMessage({ type: 'onto:pause' }, '*');
  if (mode === 'ambient' && value !== 'ambient') window.ambientView?.leave();
  mode = value;
  $('local-view').hidden = mode !== 'local';
  $('tv-view').hidden = mode !== 'tv';
  $('history-view').hidden = mode !== 'history';
  $('library-view').hidden = mode !== 'library';
  $('ambient-view').hidden = mode !== 'ambient';
  for (const name of ['local', 'library', 'ambient', 'tv', 'history']) {
    $('mode-' + name).classList.toggle('selected', name === mode);
    $('mode-' + name).setAttribute('aria-pressed', String(name === mode));
  }
  message();
  if (mode === 'tv' && latestTv) renderTv(latestTv);
  if (mode === 'library') void act(() => loadLibrary());
  if (mode === 'ambient') window.ambientView?.enter();
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return total >= 3600 ? `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderTv(state) {
  if (latestTv?.current?.path !== state.current?.path) {
    clearTimeout(seekTimer); pendingSeek = null; scrubbing = false; seekVersion++;
  }
  latestTv = state;
  $('room').textContent = state.tvHost ? `Samsung · ${state.tvHost}` : 'Connect a TV below.';
  if (mode === 'tv') {
    message(state.error || (state.status === 'preparing' ? 'Getting it ready for the TV…'
      : state.status === 'finished' ? 'All done.' : ''), !!state.error);
  }
  $('deck').hidden = !state.current && !state.upcoming.length && state.status !== 'preparing';
  $('now-title').textContent = state.current?.title || 'Waiting';
  const pos = pendingSeek ?? state.current?.positionSeconds ?? 0;
  const dur = state.current?.durationSeconds || 0;
  if (!scrubbing) {
    $('now-time').textContent = `${clock(pos)} / ${clock(dur)}`;
    $('progress').max = Math.max(1, dur - 1);
    $('progress').value = pos;
    $('progress').setAttribute('aria-valuetext', `${clock(pos)} of ${clock(dur)}`);
  }
  const canSeek = !!state.current?.seekable && dur > 0 && state.status !== 'preparing';
  for (const id of ['rewind', 'forward', 'progress']) $(id).disabled = !canSeek;
  $('next').hidden = !state.current || !state.upcoming.length;
  $('enqueue').hidden = !state.current;
  $('gate').title = state.current ? 'Open another file and save your place in this one' : 'Open a video on the TV';
  $('pause').hidden = state.status === 'paused' || !state.current;
  $('resume').hidden = state.status !== 'paused';
  $('queue').replaceChildren(...state.upcoming.map(item => {
    const li = document.createElement('li'); li.textContent = item.title; return li;
  }));
  renderHistory(state.history || []);
  updateLibraryProgress(state.history || []);
  renderPoints(state.current);
}

function updateLibraryProgress(history) {
  const byPath = new Map(history.map(item => [item.path, item]));
  for (const item of libraryItems) {
    const saved = byPath.get(item.path);
    if (saved) for (const key of ['positionSeconds','durationSeconds','completed','updatedAt']) item[key] = saved[key];
  }
  for (const card of libraryCards) updateLibraryCard(card, card.libraryItem);
}

function updateLibraryCard(card, item) {
  const resume = !item.completed && item.positionSeconds > 5;
  const action = item.completed ? 'Replay' : resume ? 'Resume' : 'Play';
  card.setAttribute('aria-label', `${action} on TV ${item.title}`);
  card.querySelector('.library-item-action').textContent = action;
  const progress = card.querySelector('.library-progress');
  progress.hidden = !resume || !item.durationSeconds;
  progress.style.width = `${Math.min(100, 100 * (item.positionSeconds || 0) / (item.durationSeconds || 1))}%`;
}

function libraryTile(item) {
  const li = document.createElement('li');
  const card = document.createElement('button');
  card.type = 'button'; card.className = 'library-card'; card.dataset.path = item.path;
  card.libraryItem = item;
  const art = document.createElement('span'); art.className = 'library-art';
  const image = document.createElement('img'); image.alt = ''; image.decoding = 'async';
  const progress = document.createElement('span'); progress.className = 'library-progress';
  const title = document.createElement('span'); title.className = 'library-item-title'; title.textContent = item.title;
  const action = document.createElement('span'); action.className = 'library-item-action';
  art.append(image, progress); card.append(art, title, action); li.append(card);
  card.onclick = () => void act(async () => {
    card.disabled = true;
    try { setMode('tv'); renderTv(await api.openFiles([item.path])); }
    finally { card.disabled = false; }
  });
  libraryCards.add(card); updateLibraryCard(card, item); artworkObserver.observe(card);
  return li;
}

function renderLibrary() {
  artworkObserver.disconnect(); libraryCards.clear();
  const query = $('library-search').value.trim().toLocaleLowerCase();
  const matches = item => !query || `${item.title} ${item.channel}`.toLocaleLowerCase().includes(query);
  const sorted = [...libraryItems].sort((a,b) => a.title.localeCompare(b.title, undefined, {numeric:true}));
  const continued = libraryItems.filter(item => !item.completed && item.positionSeconds > 5).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const films = sorted.filter(item => item.kind === 'film');
  const home = !query && libraryFilter === 'home';
  $('library-home').hidden = !home;
  $('library-list').hidden = home;
  $('library-continue').hidden = !continued.length;
  $('library-films').hidden = !films.length;
  $('library-continue-list').replaceChildren(...(home ? continued.slice(0, 8).map(libraryTile) : []));
  $('library-films-list').replaceChildren(...(home ? films.map(libraryTile) : []));
  const selected = (libraryFilter === 'continue' ? continued : libraryFilter === 'film' ? films :
    libraryFilter === 'show' ? sorted.filter(item => item.kind === 'show' || item.kind === 'episode') : sorted).filter(matches);
  $('library-list').replaceChildren(...(home ? [] : selected.map(libraryTile)));
  $('library-empty').hidden = home ? continued.length + films.length > 0 : selected.length > 0;
  $('library-empty').textContent = !libraryItems.length ? 'Add a folder to start your library.' : 'No videos found.';
  $('library-count').textContent = query ? `${selected.length} ${selected.length === 1 ? 'video' : 'videos'}` : '';
  for (const button of document.querySelectorAll('[data-library-filter]')) {
    const active = button.dataset.libraryFilter === libraryFilter;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  }
}

async function loadLibrary(force = false) {
  if (!api?.getLibrary) return;
  if (libraryLoaded && !force) { renderLibrary(); return; }
  if (libraryLoading) return libraryLoading;
  if (force) libraryArtwork.clear();
  $('library-count').textContent = 'Loading…';
  libraryLoading = (async () => {
    const result = await api.getLibrary();
    libraryItems = result.items; libraryLoaded = true;
    updateLibraryProgress(latestTv?.history || []); renderLibrary();
  })();
  try { await libraryLoading; } finally { libraryLoading = null; }
}

function renderPoints(current) {
  const points = [...(current?.chapters || []), ...(current?.points || []).map(point => ({ ...point, startSeconds:point.positionSeconds }))]
    .sort((a,b) => a.startSeconds - b.startSeconds);
  $('points-summary').textContent = `Scenes & chapters${points.length ? ` (${points.length})` : ''}`;
  $('point-form').querySelector('button').disabled = !current;
  const signature = JSON.stringify([current?.path, points]);
  if (signature === pointsSignature) return;
  pointsSignature = signature;
  $('points-list').replaceChildren(...points.map(point => {
    const item = document.createElement('span'); item.className = 'scene-point';
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = `${clock(point.startSeconds)} · ${point.title}`;
    button.title = `Jump to ${point.title}`; button.disabled = !current?.seekable;
    button.onclick = () => scheduleSeek(point.startSeconds);
    item.append(button);
    if (point.id) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-point';
      remove.textContent = '×'; remove.setAttribute('aria-label', `Remove scene point ${point.title}`);
      remove.onclick = () => act(() => api.removePoint(point.id, current.path)); item.append(remove);
    }
    return item;
  }));
}

function renderHistory(entries) {
  $('history-empty').hidden = entries.length > 0;
  const activePaths = new Set(entries.map(entry => entry.path));
  for (const [path, row] of historyRows) if (!activePaths.has(path)) { row.remove(); historyRows.delete(path); }
  entries.forEach((entry, index) => {
    let row = historyRows.get(entry.path);
    if (!row) {
      row = document.createElement('li');
      const info = document.createElement('div');
      const title = document.createElement('p'); title.className = 'history-title';
      const detail = document.createElement('p'); detail.className = 'history-detail';
      const button = document.createElement('button');
      button.onclick = () => act(() => api.openFiles([entry.path]));
      info.append(title, detail); row.append(info, button); historyRows.set(entry.path, row);
    }
    row.querySelector('.history-title').textContent = entry.title;
    row.querySelector('.history-title').title = entry.path;
    const time = new Date(entry.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const progress = entry.completed ? 'Finished' : `${clock(entry.positionSeconds)} / ${clock(entry.durationSeconds)}`;
    row.querySelector('.history-detail').textContent = `${progress} · ${time}`;
    const button = row.querySelector('button');
    button.textContent = entry.completed ? 'Replay on TV' : entry.positionSeconds > 5 ? 'Resume on TV' : 'Play on TV';
    button.setAttribute('aria-label', `${button.textContent} ${entry.title}`);
    const atIndex = $('history-list').children[index];
    if (atIndex !== row) $('history-list').insertBefore(row, atIndex || null);
  });
}

function scheduleSeek(target) {
  if ($('progress').disabled) return;
  const duration = latestTv.current.durationSeconds;
  pendingSeek = Math.max(0, Math.min(Math.round(target), Math.max(0, duration - 1)));
  const version = ++seekVersion;
  clearTimeout(seekTimer);
  renderTv(latestTv);
  seekTimer = setTimeout(() => {
    const target = pendingSeek;
    void act(async () => {
      try {
        const result = await api.seek(target, latestTv?.current?.path);
        if (seekVersion === version && result?.current?.path === latestTv?.current?.path) renderTv(result);
      }
      finally { if (seekVersion === version) { pendingSeek = null; renderTv(latestTv); } }
    });
  }, 200);
}

function renderSettings(state) {
  $('tv-host').value = state.tvHost;
  $('av-transport').value = state.avTransportUrl;
  $('bind-host').value = state.bindHost;
  $('library-path').textContent = state.library;
  $('config-summary').textContent = [state.tiersPath ? 'Groups set.' : 'No groups yet.',
    state.sourcesPath ? 'Extra folders set.' : ''].filter(Boolean).join(' ');
  $('empty-library').hidden = state.hasPlayer;
  $('channel-player').hidden = !state.hasPlayer;
  if (state.hasPlayer && loadedLibrary !== state.playerPath) {
    loadedLibrary = state.playerPath;
    void act(() => loadChannels());
  }
  if (!state.hasPlayer) { loadedLibrary = null; $('channel-player').src = 'about:blank'; }
  if (!state.tvHost) $('tv-settings').open = true;
  renderTv(state.tv);
}

$('mode-local').onclick = () => setMode('local');
$('mode-tv').onclick = () => setMode('tv');
$('mode-history').onclick = () => setMode('history');
$('mode-library').onclick = () => setMode('library');
$('mode-ambient').onclick = () => setMode('ambient');
$('library-search').oninput = () => renderLibrary();
$('refresh-library').onclick = () => act(() => loadLibrary(true));
for (const button of document.querySelectorAll('[data-library-filter]')) button.onclick = () => {
  libraryFilter = button.dataset.libraryFilter; renderLibrary();
};
$('choose-media-folder').onclick = () => act(async () => {
  const result = await api.addLibraryFolder();
  libraryItems = result.items; libraryLoaded = true; renderLibrary();
});
async function loadChannels() {
  const result = await api.openShuffler();
  $('channel-player').onload = () => {
    if (result.exportToken) $('channel-player').contentWindow.postMessage({type:'onto:export', token:result.exportToken}, '*');
  };
  $('channel-player').src = result.url;
}
function showLibrary(open) {
  $('library-settings').hidden = !open;
  $('library-toggle').setAttribute('aria-expanded', String(open));
  (open ? $('library-close') : $('library-toggle')).focus();
}
$('library-toggle').onclick = () => showLibrary($('library-settings').hidden);
$('library-close').onclick = () => showLibrary(false);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('library-settings').hidden) { event.preventDefault(); showLibrary(false); }
});
$('start-library').onclick = () => { $('library-settings').hidden = false; $('choose-library').click(); };
for (const kind of ['library', 'player', 'tiers', 'sources']) {
  $('choose-' + kind).onclick = () => act(async () => renderSettings(await api.chooseShuffler(kind)));
}
$('build-shuffler').onclick = () => act(async () => {
  if (busy) return;
  busy = true;
  $('build-shuffler').disabled = true;
  message('Refreshing…');
  try {
    const result = await api.buildShuffler();
    renderSettings(result.state);
    await loadChannels();
    libraryLoaded = false;
    message('Library updated.');
  } finally { busy = false; $('build-shuffler').disabled = false; }
});
$('tv-form').onsubmit = event => {
  event.preventDefault();
  void act(async () => {
    const button = $('tv-form').querySelector('button[type=submit]');
    button.disabled = true;
    try {
      renderSettings(await api.saveTv({ tvHost: $('tv-host').value,
        avTransportUrl: $('av-transport').value, bindHost: $('bind-host').value }));
      message('Saved.');
    } finally { button.disabled = false; }
  });
};
$('gate').onclick = () => act(async () => renderTv(await api.choose(false)));
$('enqueue').onclick = () => act(async () => renderTv(await api.choose(true)));
$('next').onclick = () => act(() => api.next());
$('rewind').onclick = () => scheduleSeek((pendingSeek ?? latestTv?.current?.positionSeconds ?? 0) - 10);
$('forward').onclick = () => scheduleSeek((pendingSeek ?? latestTv?.current?.positionSeconds ?? 0) + 30);
$('point-form').onsubmit = event => {
  event.preventDefault();
  const title = $('point-title').value.trim();
  const path = latestTv?.current?.path;
  if (!title || !path) return;
  void act(async () => { await api.addPoint(title, path); $('point-title').value = ''; });
};
$('progress').oninput = () => {
  scrubbing = true;
  $('now-time').textContent = `${clock($('progress').value)} / ${clock(latestTv.current.durationSeconds)}`;
};
$('progress').onchange = () => { scrubbing = false; scheduleSeek(Number($('progress').value)); };
window.addEventListener('keydown', event => {
  if (mode !== 'tv' || !latestTv?.current || event.altKey || event.ctrlKey || event.metaKey ||
      event.target.closest('input, button, summary, textarea, select')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); $(event.key === 'ArrowLeft' ? 'rewind' : 'forward').click();
  }
});
for (const action of ['pause', 'resume', 'stop']) $(action).onclick = () => act(() => api[action]());
window.addEventListener('dragover', event => {
  event.preventDefault();
  if (mode !== 'tv') setMode('tv');
  $('gate').classList.add('over');
});
window.addEventListener('dragleave', event => {
  if (event.target === document.documentElement) $('gate').classList.remove('over');
});
window.addEventListener('drop', event => {
  event.preventDefault(); $('gate').classList.remove('over'); setMode('tv');
  const paths = [...(event.dataTransfer?.files || [])].map(file => api.pathFor(file)).filter(Boolean);
  if (paths.length) void act(async () => renderTv(await api.openFiles(paths)));
});

if (api) {
  api.onState(renderTv); api.onMode(setMode); api.onError(text => message(text, true));
  if (api.onCast) api.onCast(notice => $('channel-player').contentWindow?.postMessage(notice, '*'));
  void act(async () => renderSettings(await api.get()));
} else {
  message('Open this view with the Onto the TV app.');
  document.querySelectorAll('button').forEach(button => { if (!button.id.startsWith('mode-')) button.disabled = true; });
}

window.addEventListener('message', event => {
  if (!api || event.source !== $('channel-player').contentWindow || event.origin !== 'null' || !event.data) return;
  if (event.data.type === 'onto:taste' && api.saveTaste) void act(() => api.saveTaste(event.data.profiles));
  if (event.data.type === 'onto:cast-play' && api.castPlay) void act(() => api.castPlay(event.data.src, event.data.seconds));
  if (event.data.type === 'onto:cast-queue-next' && api.castQueueNext) {
    const { src, currentSrc, requestId } = event.data;
    // Background preparation must not abort the episode already on the TV.
    void Promise.resolve().then(() => api.castQueueNext(src, currentSrc)).catch(() => false).then(queued => {
      event.source.postMessage({ type:'onto:cast-queue-result', src, currentSrc, requestId, queued:queued === true }, '*');
    });
  }
  if (event.data.type === 'onto:history' && api.recordHistory) void act(() => api.recordHistory(event.data));
  if (event.data.type === 'onto:cast-seek') void act(() => api.seek(event.data.seconds, latestTv?.current?.path));
  if (event.data.type === 'onto:cast-pause') void act(() => api.pause());
  if (event.data.type === 'onto:cast-resume') void act(() => api.resume());
  if (event.data.type === 'onto:cast-stop') void act(() => api.stop());
});
