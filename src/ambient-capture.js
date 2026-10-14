import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Inject BrowserWindow so importing the video builder does not launch Electron.
export function createAmbientCapture({ BrowserWindow, appRoot }) {
  return async (slides, signal) => {
    signal?.throwIfAborted();
    const window = new BrowserWindow({ width: 1280, height: 720, useContentSize: true,
      show: false, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false,
        partition: 'ambient-render', contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const close = () => { if (!window.isDestroyed()) window.destroy(); };
    signal?.addEventListener('abort', close, { once: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    try {
      await window.loadURL(pathToFileURL(join(appRoot, 'ui/ambient-render.html')).href);
      window.webContents.on('will-navigate', event => event.preventDefault());
      const frames = [];
      for (const slide of slides) {
        signal?.throwIfAborted();
        await window.webContents.executeJavaScript(`window.setAmbientSlide(${JSON.stringify(slide)})`);
        const frame = await window.webContents.capturePage();
        if (frame.isEmpty()) throw new Error('Screensaver frame was empty.');
        frames.push(frame.toPNG());
      }
      return frames;
    } finally { signal?.removeEventListener('abort', close); close(); }
  };
}
