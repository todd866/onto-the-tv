const api = window.tv;
const $ = id => document.getElementById(id);
let mode = 'local';
let latestTv;
let busy = false;

function message(text = '', fault = false) {
  $('status').textContent = text;
  $('status').classList.toggle('is-fault', fault);
}

async function act(work) {
  try { return await work(); }
  catch (error) { message(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
}

function setMode(value) {
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
  $('room').textContent = state.tvHost ? `Samsung · ${state.tvHost}` : 'Add your TV below to get started.';
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
  $('config-summary').textContent = [state.tiersPath ? 'Show groups selected.' : 'No show groups selected.',
    state.sourcesPath ? 'Extra sources selected.' : ''].filter(Boolean).join(' ');
  $('open-shuffler').disabled = !state.hasPlayer;
  if (!state.hasPlayer) $('library-settings').open = true;
  if (!state.tvHost) $('tv-settings').open = true;
  renderTv(state.tv);
}

$('mode-local').onclick = () => setMode('local');
$('mode-tv').onclick = () => setMode('tv');
$('open-shuffler').onclick = () => act(async () => { await api.openShuffler(); message('Opened in your browser.'); });
for (const kind of ['library', 'player', 'tiers', 'sources']) {
  $('choose-' + kind).onclick = () => act(async () => renderSettings(await api.chooseShuffler(kind)));
}
$('build-shuffler').onclick = () => act(async () => {
  if (busy) return;
  busy = true;
  $('build-shuffler').disabled = true;
  message('Checking the videos and building your player…');
  try {
    const result = await api.buildShuffler();
    renderSettings(result.state);
    message(result.message);
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
      message('TV settings saved. Choose a video when you’re ready.');
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
  void act(async () => renderSettings(await api.get()));
} else {
  message('Open this view with the Onto the TV app.');
  document.querySelectorAll('button').forEach(button => { if (!button.id.startsWith('mode-')) button.disabled = true; });
}
