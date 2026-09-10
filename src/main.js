import { createTasteWriter } from './taste.js';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { createLiveSession } from './live.js';
import { loadConfig } from '../casting/src/config.js';
import { filesFromArgv } from './launch-files.js';
import { defaults, readSettings, writeSettings, validateTvSettings } from './settings.js';
import { playerExists, buildPlayer, prepareChannels } from './shuffler.js';
import { playOnTv, tvNotice } from './channel-cast.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const uiUrl = pathToFileURL(join(appRoot, 'ui/index.html')).href;
// Finder does not inherit a shell's Homebrew PATH.
process.env.PATH = [...new Set([process.env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
const pendingFiles = [];
let win, session, settings, settingsPath, unsubscribe;
let building = false;
let quitting = false;
let changingTv = false;
let catalogue = null;
let channelCasting = false;
let sentFinished = false;

function send(channel, value) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
}
function sendState(state) { send('drop:state', state); }

function forwardChannel(state) {
  sendState(state);
  if (!channelCasting) return;
  const notice = tvNotice(catalogue, state);
  if (!notice) return;
  if (notice.type === 'onto:tv' && notice.tv?.status === 'finished') {
    if (sentFinished) return;
    sentFinished = true;
  } else {
    sentFinished = false;
  }
  send('channel:notice', notice);
  if (notice.type === 'onto:cast-off') channelCasting = false;
}

function newSession() {
  unsubscribe?.();
  channelCasting = false;
  session = createLiveSession(loadConfig(process.env, settings));
  unsubscribe = session.onChange(forwardChannel);
}

async function takeOverFromChannel() {
  if (!channelCasting) return;
  channelCasting = false;
  send('channel:notice', { type: 'onto:cast-off', reason: 'Playing a dropped file on the TV.' });
  await session.stop();
}

async function snapshot() {
  return { ...settings, hasPlayer: await playerExists(settings), building, tv: session.getState() };
}

async function persist() { await writeSettings(settingsPath, settings); }

async function queueOrAdd(paths) {
  if (!paths.length) return;
  if (!session) { pendingFiles.push(...paths); return; }
  if (changingTv) { sendState({ ...session.getState(), error: 'Wait for TV settings to finish saving, then try again.' }); return; }
  await takeOverFromChannel();
  send('app:mode', 'tv');
  try { await session.addFiles(paths); }
  catch (error) { sendState({ ...session.getState(), error: error.message }); }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
      throw new Error('Untrusted app request.');
    }
    return fn(...args);
  });
}

async function createWindow() {
  settingsPath = join(app.getPath('userData'), 'settings.json');
  let settingsError;
  try { settings = await readSettings(settingsPath); }
  catch (error) { settings = defaults(); settingsError = error.message; }
  newSession();
  win = new BrowserWindow({
    width: 980, height: 720, minWidth: 520, minHeight: 560,
    backgroundColor: '#17130f', title: 'Onto the TV', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 }, show: false,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(
    wc === win.webContents && permission === 'fullscreen'));
  win.once('ready-to-show', () => win.show());
  await win.loadURL(uiUrl);
  if (settingsError) win.webContents.send('app:error', settingsError);
  if (pendingFiles.length) await queueOrAdd(pendingFiles.splice(0));
}

let tasteWriter;
handle('taste:save', input => {
  tasteWriter ||= createTasteWriter(app.getPath('userData'));
  return tasteWriter(input);
});
handle('app:get', snapshot);
handle('drop:add', async (paths) => {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  if (!Array.isArray(paths) || paths.length > 1000 || paths.some(p => typeof p !== 'string' || !isAbsolute(p))) {
    throw new Error('Choose local video files.');
  }
  await takeOverFromChannel();
  return session.addFiles(paths);
});
handle('drop:pause', () => session.pause());
handle('drop:resume', () => session.resume());
handle('drop:stop', () => {
  const handed = channelCasting;
  channelCasting = false;
  if (handed) send('channel:notice', { type: 'onto:cast-off', reason: 'The TV stopped playing.' });
  return session.stop();
});
handle('drop:choose', async () => {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Video or audio', extensions: ['mp4', 'mkv', 'm4v', 'mov', 'webm', 'avi', 'm4a', 'mp3'] }] });
  if (result.canceled) return session.getState();
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  await takeOverFromChannel();
  return session.addFiles(result.filePaths);
});
handle('channel:play', async (src, seconds) => {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  channelCasting = true;
  sentFinished = false;
  try {
    return await playOnTv(session, catalogue, src, seconds);
  } catch (error) {
    channelCasting = false;
    send('channel:notice', { type: 'onto:cast-off', reason: error.message });
    throw error;
  }
});
handle('settings:tv', async (input) => {
  if (changingTv) throw new Error('TV settings are already being saved.');
  if (session.getState().count || session.getState().status === 'preparing') throw new Error('Stop TV playback before changing the TV address.');
  const updated = { ...settings, ...validateTvSettings(input) };
  changingTv = true;
  try {
    await writeSettings(settingsPath, updated);
    await session.close();
    settings = updated;
    newSession();
    return snapshot();
  } finally { changingTv = false; }
});
handle('shuffler:open', async () => {
  if (!await playerExists(settings)) throw new Error('Choose a folder, then refresh the library.');
  const result = await prepareChannels(appRoot, settings, app.getPath('userData'));
  catalogue = result.catalogue;
  return { url: result.url, count: result.count, exportToken: result.exportToken };
});
handle('shuffler:choose', async (kind) => {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  if (building) throw new Error('Wait for the player to finish building.');
  if (!['library', 'player', 'tiers', 'sources'].includes(kind)) throw new Error('Unknown selection.');
  const result = await dialog.showOpenDialog(win, {
    title: { library: 'Choose the video library', player: 'Choose an existing library',
      tiers: 'Choose show groups', sources: 'Choose extra video sources' }[kind],
    properties: [kind === 'library' ? 'openDirectory' : 'openFile'],
    ...(kind === 'library' ? {} : { filters: [{ name: kind === 'player' ? 'HTML player' : 'JSON configuration', extensions: [kind === 'player' ? 'html' : 'json'] }] }),
  });
  if (result.canceled) return snapshot();
  if (changingTv || building) throw new Error('Wait for the current operation to finish, then choose again.');
  const path = result.filePaths[0];
  if (kind === 'library') { settings.library = path; settings.playerPath = join(path, 'kids-shuffler.html'); }
  else settings[{ player: 'playerPath', tiers: 'tiersPath', sources: 'sourcesPath' }[kind]] = path;
  await persist();
  return snapshot();
});
handle('shuffler:build', async () => {
  if (building) throw new Error('The player is already being built.');
  building = true;
  try {
    const message = await buildPlayer(appRoot, settings);
    building = false;
    return { message, state: await snapshot() };
  } finally { building = false; }
});

app.setName('Onto the TV');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    void queueOrAdd(filesFromArgv(argv, { appRoot }));
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.on('open-file', (event, path) => { event.preventDefault(); void queueOrAdd([path]); });
  pendingFiles.push(...filesFromArgv(process.argv, { appRoot }));
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('Onto the TV could not start', error.message); app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    Promise.resolve(session?.close()).catch(error => console.error('TV cleanup:', error.message)).finally(() => app.quit());
  });
}
