// The TV shell: the Mac behind the TV runs this full screen instead of the
// Samsung's own smart TV. It shows the TV home screen from the TV server, opens
// YouTube's TV app, and tunes the Samsung's tuner for free-to-air channels.
//   electron src/tv-shell.js
// Settings: <app data>/tv-shell.json (see DEFAULTS). ONTO_SHELL_CAPTURE=<dir>
// runs hidden, saves screenshots of home and YouTube there, and quits.
import { app, BrowserWindow, WebContentsView, ipcMain, powerSaveBlocker } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSamsungRemote } from './samsung-remote.js';
import { createLiveTv } from './tv-live.js';

const here = dirname(fileURLToPath(import.meta.url));
const CAPTURE = process.env.ONTO_SHELL_CAPTURE || '';
// YouTube serves its remote-driven TV app only to TVs.
const TV_AGENT = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.0 TV Safari/537.36';
const YOUTUBE = 'https://www.youtube.com/tv';
const DEFAULTS = {
  server: 'http://127.0.0.1:8686/',
  tvHost: '192.168.20.14',
  macInput: 'KEY_HDMI',           // the key that puts the TV back on this Mac's input
  homeKeys: ['Home', 'BrowserHome', 'F13'],
  live: [{ lcn: '2', name: 'ABC' }, { lcn: '22', name: 'ABC Kids' }, { lcn: '3', name: 'SBS' },
    { lcn: '7', name: 'Seven' }, { lcn: '9', name: 'Nine' }, { lcn: '10', name: '10' }],
};
const BACK_KEYS = new Set(['Escape', 'Backspace', 'BrowserBack']);
const NO_CURSOR = '* { cursor: none !important; }';

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

async function readShellConfig() {
  const file = join(app.getPath('userData'), 'tv-shell.json');
  try { return { ...DEFAULTS, ...JSON.parse(await readFile(file, 'utf8')) }; }
  catch (error) {
    if (error.code !== 'ENOENT') log(`tv-shell.json unreadable, using defaults: ${error.message}`);
    return { ...DEFAULTS };
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
// A capture run stays out of the Dock and never takes the keyboard.
if (CAPTURE) app.setActivationPolicy?.('prohibited');

app.whenReady().then(async () => {
  const config = await readShellConfig();
  const live = createLiveTv({ remote: createSamsungRemote({ host: config.tvHost, log }), macInput: config.macInput });
  powerSaveBlocker.start('prevent-app-suspension');

  const win = new BrowserWindow({
    width: 1920, height: 1080, useContentSize: true, show: !CAPTURE, kiosk: !CAPTURE, backgroundColor: '#000', autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'tv-shell-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  let youtube = null;

  const notice = text => win.webContents.executeJavaScript(
    `window.ontoNotice && window.ontoNotice(${JSON.stringify(text)})`).catch(() => {});

  function showYouTube() {
    if (!youtube) {
      youtube = new WebContentsView({ webPreferences: { partition: 'persist:youtube', contextIsolation: true, sandbox: true,
        offscreen: !!CAPTURE } });
      youtube.webContents.setUserAgent(TV_AGENT);
      youtube.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      youtube.webContents.on('before-input-event', onKey);
      youtube.webContents.on('did-finish-load', () => youtube.webContents.insertCSS(NO_CURSOR));
      youtube.webContents.loadURL(YOUTUBE);
      win.contentView.addChildView(youtube);
    }
    youtube.setBounds({ x: 0, y: 0, ...sizeOf(win) });
    youtube.setVisible(true);
    youtube.webContents.focus();
  }

  // Home from anywhere: off live TV, out of YouTube (kept warm), back to the home screen.
  function goHome() {
    live.leave().catch(error => notice(`⚠ ${error.message}`));
    if (youtube) youtube.setVisible(false);
    win.webContents.focus();
    win.webContents.executeJavaScript('window.ontoHome && window.ontoHome()').catch(() => {});
  }

  function onKey(event, input) {
    if (input.type !== 'keyDown') return;
    if (config.homeKeys.includes(input.key)) { event.preventDefault(); return goHome(); }
    if (live.showing !== null) {
      // Live TV is on the screen, not this Mac: its keys belong to the TV.
      event.preventDefault();
      if (BACK_KEYS.has(input.key)) goHome(); else live.relay(input.key);
      return;
    }
    if (live.relay(input.key)) event.preventDefault();   // volume always goes to the TV
  }
  win.webContents.on('before-input-event', onKey);
  // The home screen is laid out for 1920×1080; scale it to whatever the TV's display is.
  const fit = () => {
    const { width, height } = sizeOf(win);
    win.webContents.setZoomFactor(Math.min(width / 1920, height / 1080));
    youtube?.setBounds({ x: 0, y: 0, width, height });
  };
  win.webContents.on('did-finish-load', () => { win.webContents.insertCSS(NO_CURSOR); fit(); });
  win.on('resize', fit);

  // Only the home screen may ask for these, not YouTube.
  const fromHome = event => event.sender === win.webContents;
  ipcMain.on('shell:config', event => { event.returnValue = fromHome(event) ? { live: config.live } : null; });
  ipcMain.on('shell:open', (event, what) => { if (fromHome(event) && what === 'youtube') showYouTube(); });
  ipcMain.on('shell:live', (event, lcn) => {
    if (!fromHome(event)) return;
    notice(`Switching to channel ${lcn}…`);
    live.tune(lcn).then(() => notice('')).catch(error => notice(`⚠ ${error.message}`));
  });

  await win.loadURL(config.server).catch(error => log(`home screen did not load: ${error.message}`));
  if (CAPTURE) await capture(win, showYouTube, () => youtube);
});

function sizeOf(win) { const [width, height] = win.getContentSize(); return { width, height }; }

// Hidden screenshots for checking the shell without putting a window on screen.
async function capture(win, showYouTube, view) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await mkdir(CAPTURE, { recursive: true });
    await pause(2500);
    await writeFile(join(CAPTURE, 'shell-home.png'), (await win.webContents.capturePage()).toPNG());
    showYouTube();
    await pause(12000);
    await writeFile(join(CAPTURE, 'shell-youtube.png'), (await view().webContents.capturePage()).toPNG());
    log('captured', CAPTURE);
  } catch (error) { log(`capture failed: ${error.message}`); }
  finally { app.quit(); }
}
