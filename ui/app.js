const api = window.tv;
const $ = id => document.getElementById(id);
let mode = 'local';
let latestTv;
let busy = false;
let loadedLibrary = null;

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
  mode = value;
  $('local-view').hidden = mode !== 'local';
  $('tv-view').hidden = mode !== 'tv';
  for (const name of ['local', 'tv']) {
    $('mode-' + name).classList.toggle('selected', name === mode);
    $('mode-' + name).setAttribute('aria-pressed', String(name === mode));
  }
  message();
  if (mode === 'tv' && latestTv) renderTv(latestTv);
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderTv(state) {
  latestTv = state;
  $('room').textContent = state.tvHost ? `Samsung · ${state.tvHost}` : 'Connect a TV below.';
  if (mode === 'tv') {
    message(state.error || (state.status === 'preparing' ? 'Getting it ready for the TV…'
      : state.status === 'paused' ? 'Paused on the TV.' : state.status === 'finished' ? 'All done.'
      : state.current ? 'Playing on the TV.' : ''), !!state.error);
  }
  $('deck').hidden = !state.current && !state.upcoming.length && state.status !== 'preparing';
  $('now-title').textContent = state.current?.title || 'Waiting';
  const pos = state.current?.positionSeconds || 0;
  const dur = state.current?.durationSeconds || 0;
  $('now-time').textContent = `${clock(pos)} / ${clock(dur)}`;
  $('progress').value = dur ? Math.min(100, pos / dur * 100) : 0;
  $('pause').hidden = state.status === 'paused' || !state.current;
  $('resume').hidden = state.status !== 'paused';
  $('queue').replaceChildren(...state.upcoming.map(item => {
    const li = document.createElement('li'); li.textContent = item.title; return li;
  }));
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
async function loadChannels() {
  const result = await api.openShuffler();
  $('channel-player').onload = () => {
    if (result.exportToken) $('channel-player').contentWindow.postMessage({type:'onto:export', token:result.exportToken}, '*');
  };
  $('channel-player').src = result.url;
}
$('library-toggle').onclick = () => { $('library-settings').hidden = !$('library-settings').hidden; };
$('library-close').onclick = () => { $('library-settings').hidden = true; };
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
$('gate').onclick = () => act(async () => renderTv(await api.choose()));
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
  if (paths.length) void act(async () => renderTv(await api.addFiles(paths)));
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
  if (event.data.type === 'onto:cast-pause') void act(() => api.pause());
  if (event.data.type === 'onto:cast-resume') void act(() => api.resume());
  if (event.data.type === 'onto:cast-stop') void act(() => api.stop());
});
