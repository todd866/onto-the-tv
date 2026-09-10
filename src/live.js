import { stat, readdir } from 'node:fs/promises';
import { loadConfig } from '../casting/src/config.js';
import { MediaServer } from '../casting/src/server.js';
import { SamsungRenderer } from '../casting/src/renderer.js';
import { prepareMedia } from '../casting/src/pipeline.js';
import { createSession } from './session.js';

export function createLiveSession(config = loadConfig(process.env)) {
  return createSession({
    config,
    prepareMedia,
    createServer: (opts) => new MediaServer(opts),
    createRenderer: (opts) => new SamsungRenderer(opts),
    fs: { stat, readdir },
    pollMs: 2000,
  });
}
