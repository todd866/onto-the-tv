// Builds /api/library and /api/shows away from the server's event loop (src/library-views.js).
import { parentPort } from 'node:worker_threads';
import { libraryView, showsView } from './tv-library-api.js';

const VIEWS = { library: libraryView, shows: showsView };
let videos = [];
parentPort.on('message', message => {
  if (message.type === 'videos') { videos = Array.isArray(message.videos) ? message.videos : []; return; }
  if (message.type !== 'view') return;
  try {
    const view = VIEWS[message.kind];
    if (!view) throw new Error(`Unknown view ${message.kind}.`);
    parentPort.postMessage({ id: message.id, json: JSON.stringify(view({ videos, history: message.history, viewers: message.viewers, rating: message.rating, now: message.now })) });
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
});
