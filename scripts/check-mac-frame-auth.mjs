// Offscreen Electron check of the Mac app's Channels frame against a TV server that refuses unpaired devices.
//   ./node_modules/.bin/electron scripts/check-mac-frame-auth.mjs
// A real TV server (enforce mode) is reached as tvbox.local (mapped to loopback, so the server sees another
// device). A file: page frames the server's TV page the way ui/channels.js does, and the window's session has
// the app's own token hook (addTvTokenHook from src/tv-home-client.js). Passes when the frame is allowed by the
// server's frame-ancestors policy, its lineup, household, pictures and a video load with no 401/403, and the
// page itself never holds the token. Muted; never contacts a real server.
import { app, BrowserWindow } from 'electron';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

const freePort = () => new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const port = await freePort();
const dir = await mkdtemp(path.join(tmpdir(), 'onto-frame-check-'));
// This Mac's household names the server's home origin; the hook sends the token there once it has proved itself.
await writeFile(path.join(dir, 'household.json'), JSON.stringify({ network: { homeOrigin: `http://tvbox.local:${port}`, tailnetOrigin: 'https://tv-mac.example.ts.net:8443' } }));
process.env.ONTO_HOUSEHOLD = path.join(dir, 'household.json');
const { createFileStorage, createTvLibrary, createTvServer } = await import('../src/tv-server.js');
const { loadPlaybackHistory } = await import('../src/playback-history.js');
const { addTvTokenHook } = await import('../src/tv-home-client.js');

app.commandLine.appendSwitch('host-resolver-rules', 'MAP tvbox.local 127.0.0.1');
app.commandLine.appendSwitch('mute-audio');
app.dock?.hide();
app.on('window-all-closed', () => {});

const TOKEN = 'frame-token-' + Math.random().toString(16).slice(2);
const media = path.join(dir, 'media');
await mkdir(path.join(media, 'Bluey'), { recursive: true });
const videos = [];
for (let e = 1; e <= 3; e++) {
  const src = `Bluey/Bluey S01E0${e}.mp4`;
  await writeFile(path.join(media, src), Buffer.alloc(32 * 1024, e));
  videos.push({ src, file: path.join(media, src), title: `Bluey S01E0${e}`, channel: 'Bluey', tier: 'shared', duration: 420 });
}
const still = path.join(dir, 'art.jpg');
await writeFile(still, Buffer.alloc(16));
const history = await loadPlaybackHistory(path.join(dir, 'history.json'));
const storage = await createFileStorage(path.join(dir, 'taste.json'));
const library = createTvLibrary({ videos, history, storage, random: () => 0 });
const logs = [];
const server = createTvServer({ library, history, storage, uiRoot: fileURLToPath(new URL('../tv', import.meta.url)), token: TOKEN, authMode: 'enforce',
  artwork: { get: async () => still }, remoteLog: { record: async () => ({ ok: true }) }, watchEvents: { record: () => ({ accepted: false }), flush: async () => {} },
  playNextFile: path.join(dir, 'play-next.json'), log: line => logs.push(line) });
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const base = `http://tvbox.local:${port}`;
const frameUrl = `${base}/?desktop=1&n=1&viewers=kid1%2Cadult2%2Cadult1&play=${encodeURIComponent(videos[0].src)}&title=Bluey&show=Bluey`;
await writeFile(path.join(dir, 'parent.html'), `<!doctype html><meta charset="utf-8"><title>parent</title>
<iframe id="channel-player" sandbox="allow-scripts allow-same-origin" allow="autoplay *" style="width:960px;height:540px" src="${frameUrl}"></iframe>`);

let failed = false;
const fail = message => { failed = true; console.error('FAIL ' + message); };
// Electron emits ready only after this module has finished loading, so the rest runs from the ready handler.
app.whenReady().then(async () => {
const win = new BrowserWindow({ show: false, width: 1000, height: 600, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
addTvTokenHook(win.webContents.session, { token: async () => TOKEN, homeProved: () => true });
const seen = [];
win.webContents.session.webRequest.onCompleted({ urls: ['http://*/*'] }, details => {
  const url = new URL(details.url);
  if (url.host === `tvbox.local:${port}`) seen.push({ path: url.pathname, status: details.statusCode, t: url.searchParams.has('t') });
});
try {
  await win.loadURL(pathToFileURL(path.join(dir, 'parent.html')).href);
  const deadline = Date.now() + 20000;
  let frame = null, state = null;
  while (Date.now() < deadline) {
    frame = win.webContents.mainFrame.frames.find(f => f.url.startsWith(base));
    if (frame) {
      state = await frame.executeJavaScript(`({ player: !!document.getElementById('player') && !document.getElementById('player').hidden,
        token: (window.ONTO_CONFIG && window.ONTO_CONFIG.token) || '', theme: document.body.className })`).catch(() => null);
      if (state && seen.some(row => row.path === '/media')) break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const refused = seen.filter(row => row.status === 401 || row.status === 403);
  const paths = [...new Set(seen.map(row => `${row.path}:${row.status}`))];
  console.log(JSON.stringify({ framed: !!frame, state, paths, refused }, null, 1));
  if (!frame) fail('the server page was not framed (frame-ancestors?)');
  if (refused.length) fail('refused: ' + JSON.stringify(refused));
  for (const want of ['/:200', '/api/household:200', '/api/scenes:200']) if (!paths.includes(want)) fail('missing ' + want);
  if (!paths.some(row => /^\/media:20[06]$/.test(row))) fail('the video did not load');
  if (state && state.token) fail('the framed page holds the token');
  if (logs.some(line => line.includes(TOKEN))) fail('the token reached the log');
} catch (error) { fail(error.stack || error.message); }
finally {
  win.destroy();
  await new Promise(resolve => server.close(resolve));
  console.log(failed ? 'check-mac-frame-auth: FAILED' : 'check-mac-frame-auth: ok');
  app.exit(failed ? 1 : 0);
}
});
