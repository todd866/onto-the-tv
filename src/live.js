import { traceRenderer } from './report-trace.js';
import { stat, readdir } from 'node:fs/promises';
import { loadConfig } from '../casting/src/config.js';
import { MediaServer } from '../casting/src/server.js';
import { SamsungRenderer } from '../casting/src/renderer.js';
import { prepareMedia } from '../casting/src/pipeline.js';
import { createSession } from './session.js';

export function createLiveSession(config = loadConfig(process.env), history, trace = () => {}) {
  return createSession({
    config, history,
    prepareMedia,
    createServer: (opts) => new MediaServer(opts),
    createRenderer: opts => traceRenderer(new SamsungRenderer(opts), trace),
    fs: { stat, readdir },
    pollMs: 2000,
  });
}
