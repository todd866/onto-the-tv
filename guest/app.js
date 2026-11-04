// Phone web app: pick a channel, it plays; at the end the next video on that channel starts.
const $ = id => document.getElementById(id);
const video = $('video');
let channels = [], channel = null, current = null, lastSaved = 0;

const status = text => { $('status').textContent = text || ''; };

async function api(path, body) {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 401) throw new Error('Open your invite link again to sign in.');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function render() {
  const list = $('channels');
  list.replaceChildren(...channels.map(entry => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row' + (channel && entry.id === channel.id ? ' on' : '');
    row.setAttribute('aria-label', `${entry.number} ${entry.name}, now ${entry.now.show}`);
    for (const [cls, text] of [['num', entry.number], ['name', entry.name], ['now', entry.now.show]]) {
      const span = document.createElement('span');
      span.className = cls; span.textContent = text;
      row.append(span);
    }
    row.addEventListener('click', () => tune(entry));
    li.append(row);
    return li;
  }));
}

function save(completed = false) {
  if (!current || !Number.isFinite(video.currentTime)) return;
  lastSaved = Date.now();
  api('/api/progress', { src: current.src, positionSeconds: video.currentTime,
    durationSeconds: Number.isFinite(video.duration) ? video.duration : current.duration, completed }).catch(() => {});
}

async function play(entry, afterSrc) {
  status('');
  const item = await api('/api/next', afterSrc ? { channel: entry.id, current: afterSrc } : { channel: entry.id });
  current = item;
  $('player').hidden = false;
  $('ch-now').textContent = entry.number;
  $('title').textContent = item.show && !item.title.startsWith(item.show) ? `${item.show} · ${item.title}` : item.title;
  video.src = '/media?src=' + encodeURIComponent(item.src);
  video.addEventListener('loadedmetadata', () => { if (item.resume > 5) video.currentTime = item.resume; }, { once: true });
  await video.play().catch(() => {});
}

async function tune(entry) {
  if (current) save();
  channel = entry;
  render();
  try { await play(entry); } catch (error) { status(error.message); }
}

$('next').addEventListener('click', () => {
  if (!channel) return;
  save();
  play(channel, current && current.src).catch(error => status(error.message));
});
video.addEventListener('ended', () => {
  save(true);
  if (channel) play(channel, current && current.src).catch(error => status(error.message));
});
video.addEventListener('pause', () => save());
video.addEventListener('timeupdate', () => { if (Date.now() - lastSaved > 15000) save(); });
video.addEventListener('error', () => status('This video will not play on this device. Try ⏭ Next.'));

(async () => {
  try {
    const me = await api('/api/me');
    $('me').textContent = me.name;
    $('me').title = `${me.name} · up to ${me.rating} · until ${new Date(me.expires).toLocaleDateString()}`;
    channels = (await api('/api/home')).channels;
    render();
    if (!channels.length) status('Nothing to watch yet.');
  } catch (error) { status(error.message); }
})();
