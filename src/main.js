import { loadPlaybackHistory } from './playback-history.js';
import { createTasteWriter } from './taste.js';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { createLiveSession } from './live.js';
import { loadConfig } from '../casting/src/config.js';
import { createFileOpenBatcher } from './file-open-batch.js';
import { filesFromArgv } from './launch-files.js';
import { defaults, readSettings, writeSettings, validateTvSettings, preserveUnreadableSettings } from './settings.js';
import { playerExists, buildPlayer, prepareChannels, readCatalogue } from './shuffler.js';
import { playOnTv, queueOnTv, tvNotice, recordLocalHistory } from './channel-cast.js';
import { buildLibrary, scanMediaLibrary } from './library.js';
import { createArtworkCache, pruneArtwork } from './library-artwork.js';
import { createAmbientSources, validateAmbientOptions } from './ambient-sources.js';
import { createAmbientPlayer } from './ambient-player.js';
import { buildAmbientVideo } from './ambient-video.js';
import { createAmbientCapture } from './ambient-capture.js';
import { readIsobarProgramme } from './weather-channel.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const uiUrl = pathToFileURL(join(appRoot, 'ui/index.html')).href;
// Finder does not inherit a shell's Homebrew PATH.
process.env.PATH = [...new Set([process.env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
const pendingFiles = [];
const finderFiles = createFileOpenBatcher(paths => queueOrAdd(paths), {
  onError: error => send('app:error', error.message),
});
let win, session, settings, settingsPath, unsubscribe;
let building = false;
let settingsReadOnly = false;
let quitting = false;
let changingTv = false;
let catalogue = null;
let playbackHistory;
let channelCasting = false;
let sentFinished = false;
let libraryPaths = new Set();
let artwork;
let ambient;
const ambientSources = createAmbientSources();

async function ambientContent(options) {
  const result = await ambientSources.snapshot(options);
  if (options.weather) {
    try {
      result.weatherVideo = await readIsobarProgramme();
      if (!result.weatherVideo) result.issues.push('Weather maps are preparing. Local forecast is available.');
    } catch (error) { result.issues.push(error.message); }
  }
  return result;
}

async function ambientSnapshot(input) {
  const options = validateAmbientOptions({ ...settings.ambient, ...input,
    photoFolder: settings.ambient.photoFolder });
  const content = await ambientContent(options);
  return { options, slides:[...(content.weatherVideo ? [content.weatherVideo.slide] : []), ...content.slides],
    locations:content.locations, issues:content.issues };
}

async function libraryIndex() {
  const history = playbackHistory?.list() || [];
  let videos = [];
  try { videos = readCatalogue(await readFile(settings.playerPath, 'utf8'), settings.playerPath, settings.playerPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const scanned = await scanMediaLibrary([...(settings.mediaFolders || []), ...history.map(item => item.path)]);
  libraryPaths = new Set([...videos.map(item => item.file), ...scanned.map(item => item.path)]);
  return { ...buildLibrary(videos, history.filter(item => libraryPaths.has(item.path)), scanned),
    truncated: Boolean(scanned.truncated) };
}

function send(channel, value) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
}
function sendState(state) { send('drop:state', state); }

function forwardChannel(state) {
  sendState(state);
  if (!channelCasting) return false;
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
  const history = playbackHistory && { ...playbackHistory,
    set: (path, data) => { if (!ambient?.owns(path)) playbackHistory.set(path, data); },
  };
  session = createLiveSession(loadConfig(process.env, settings), history);
  ambient = createAmbientPlayer({ session,
    beforePlay: takeOverFromChannel,
    onStatus: state => send('ambient:state', state),
    build: async (options, signal) => {
      const snapshot = await ambientContent(options);
      signal.throwIfAborted();
      if (!snapshot.slides.length && !snapshot.weatherVideo) throw new Error(snapshot.issues.join(' ') || 'Choose a screensaver source.');
      return buildAmbientVideo({ slides: snapshot.slides, pace: options.pace, signal,
        weatherVideo: snapshot.weatherVideo,
        capture: createAmbientCapture({ BrowserWindow, appRoot }),
        ffmpeg: loadConfig(process.env, settings).ffmpeg });
    },
  });
  unsubscribe = session.onChange(forwardChannel);
}

function takeOverFromChannel() {
  if (!channelCasting) return false;
  channelCasting = false;
  send('channel:notice', { type: 'onto:cast-off', reason: 'Playing a dropped file on the TV.' });
  return true;
}

async function snapshot() {
  return { ...settings, hasPlayer: await playerExists(settings), building, tv: session.getState() };
}

// Writes run one at a time and each saves the settings as they are when it runs.
let settingsWrites = Promise.resolve();
function persist() {
  if (settingsReadOnly) return Promise.reject(new Error('Settings could not be read, so changes are not being saved.'));
  const write = settingsWrites.catch(() => {}).then(() => writeSettings(settingsPath, settings));
  settingsWrites = write;
  return write;
}

async function queueOrAdd(paths) {
  if (!paths.length) return;
  if (!session) { pendingFiles.push(...paths); return; }
  if (changingTv) { sendState({ ...session.getState(), error: 'Wait for TV settings to finish saving, then try again.' }); return; }
  ambient?.cancel(); takeOverFromChannel();
  send('app:mode', 'tv');
  try { await session.playOnly(paths); }
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
  catch (error) {
    settings = defaults(); settingsError = error.message;
    // Keep the unreadable file before any later save replaces it with defaults.
    try {
      const kept = await preserveUnreadableSettings(settingsPath);
      if (kept) settingsError += ` A copy was kept at ${kept}.`;
    } catch (copyError) { settingsReadOnly = true; settingsError += ` Settings will not be saved: ${copyError.message}`; }
  }
  try { playbackHistory = await loadPlaybackHistory(join(app.getPath('userData'), 'playback-history.json')); }
  catch (error) { settingsError = [settingsError, error.message].filter(Boolean).join(' '); }
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
handle('history:record', async input => {
  if (await recordLocalHistory(playbackHistory, catalogue, input, { casting: channelCasting })) sendState(session.getState());
});
async function openFiles(paths, enqueue = false) {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  if (!Array.isArray(paths) || paths.length > 1000 || paths.some(p => typeof p !== 'string' || !isAbsolute(p))) {
    throw new Error('Choose local video files.');
  }
  const wasAmbient = ambient?.owns(session.getState().current?.path);
  ambient?.cancel();
  const wasChannel = takeOverFromChannel();
  send('app:mode', 'tv');
  return enqueue && !wasChannel && !wasAmbient ? session.addFiles(paths) : session.playOnly(paths);
}
handle('drop:open', paths => openFiles(paths));
handle('drop:add', paths => openFiles(paths, true));
handle('drop:seek', (seconds, path) => session.seek(seconds, path));
handle('drop:next', () => session.playNext());
handle('drop:add-point', (title, path) => session.addPoint(title, path));
handle('drop:remove-point', (id, path) => session.removePoint(id, path));
handle('drop:pause', () => session.pause());
handle('drop:resume', () => session.resume());
handle('drop:stop', () => {
  ambient?.cancel();
  const handed = channelCasting;
  channelCasting = false;
  if (handed) send('channel:notice', { type: 'onto:cast-off', reason: 'The TV stopped playing.' });
  return session.stop();
});
handle('drop:choose', async (enqueue = false) => {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Video or audio', extensions: ['mp4', 'mkv', 'm4v', 'mov', 'webm', 'avi', 'm4a', 'mp3'] }] });
  if (result.canceled) return session.getState();
  return openFiles(result.filePaths, enqueue === true);
});
handle('channel:play', async (src, seconds) => {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  ambient?.cancel();
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
handle('channel:queue-next', (src, currentSrc) => {
  if (!channelCasting || changingTv) return false;
  return queueOnTv(session, catalogue, src, currentSrc);
});
handle('library:get', () => libraryIndex());
handle('ambient:get', input => ambientSnapshot(input));
handle('ambient:save', async input => {
  settings.ambient = validateAmbientOptions({ ...input, photoFolder: settings.ambient.photoFolder });
  await persist(); return ambientSnapshot();
});
handle('ambient:photos', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose screensaver photos' });
  if (!result.canceled && result.filePaths[0]) {
    settings.ambient = { ...settings.ambient, photos: true, photoFolder: result.filePaths[0] };
    await persist();
  }
  return ambientSnapshot();
});
handle('ambient:start', async input => {
  if (changingTv) throw new Error('Wait for TV settings to finish saving.');
  if (!loadConfig(process.env, settings).avTransportUrl) throw new Error('Connect a TV first.');
  const options = validateAmbientOptions({ ...input, photoFolder: settings.ambient.photoFolder });
  settings.ambient = options; await persist();
  const state = await ambient.start(options);
  return { ...state, ambientActive: ambient.owns(state.current?.path) };
});
handle('ambient:cancel', () => ambient?.cancel());
handle('library:artwork', async path => {
  if (!libraryPaths.has(path)) return null;
  if (!artwork) {
    const { ffmpeg, ffprobe } = loadConfig(process.env, settings);
    const directory = join(app.getPath('userData'), 'artwork');
    artwork = createArtworkCache({ directory, ffmpeg, ffprobe });
    void pruneArtwork(directory).catch(() => {});
  }
  const file = await artwork.get(path);
  return file ? pathToFileURL(file).href : null;
});
handle('library:add-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Add videos to your library' });
  if (!result.canceled && result.filePaths[0]) {
    settings.mediaFolders = [...new Set([...(settings.mediaFolders || []), result.filePaths[0]])].slice(0, 128);
    await persist();
  }
  return libraryIndex();
});
handle('settings:tv', async (input) => {
  if (changingTv) throw new Error('TV settings are already being saved.');
  if (session.getState().count || session.getState().status === 'preparing') throw new Error('Stop TV playback before changing the TV address.');
  const tv = validateTvSettings(input);
  changingTv = true;
  try {
    ambient?.cancel();
    // Apply only the TV fields to the live settings so a concurrent ambient or
    // library change made during the awaits below is kept.
    const previous = Object.fromEntries(Object.keys(tv).map(key => [key, settings[key]]));
    Object.assign(settings, tv);
    try { await persist(); } catch (error) { Object.assign(settings, previous); throw error; }
    await session.close();
    await ambient?.close();
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
  app.on('second-instance', (_event, argv, workingDirectory) => {
    void queueOrAdd(filesFromArgv(argv, { appRoot, cwd: workingDirectory }));
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.on('open-file', (event, path) => { event.preventDefault(); finderFiles.add(path); });
  pendingFiles.push(...filesFromArgv(process.argv, { appRoot }));
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('Onto the TV could not start', error.message); app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true; finderFiles.cancel();
    ambient?.cancel();
    Promise.allSettled([session?.close(), artwork?.close()])
      .then(() => ambient?.close()).finally(() => app.quit());
  });
}
