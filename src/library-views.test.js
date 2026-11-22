import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryViews, historySignature } from './library-views.js';
import { showsView } from './tv-library-api.js';
import { TV_VIEWERS } from './tv-server.js';

const adults = TV_VIEWERS.filter(viewer => !viewer.ceiling).map(viewer => viewer.id);

function bigLibrary(shows = 400, episodes = 60) {
  const videos = [];
  for (let s = 0; s < shows; s++) for (let e = 1; e <= episodes; e++) {
    const show = `Show ${s}`;
    const src = s % 2 ? `${show}/${show} S01E${String(e).padStart(2, '0')}.mp4` : `${show}/Video number ${e}.mp4`;
    videos.push({ src, file: `/m/Movies/kids/${src}`, title: src.split('/')[1].replace('.mp4', ''), channel: show, tier: s % 3 ? 'grownup' : 'shared', duration: 1300 });
  }
  return videos;
}

for (const useWorker of [true, false]) {
  test(`views are cached per audience; the second call is fast (${useWorker ? 'worker' : 'inline'})`, async () => {
    const videos = bigLibrary();
    let list = [{ path: videos[63].file, positionSeconds: 100, durationSeconds: 1300, completed: false, updatedAt: '2026-11-20T00:00:00.000Z' }];
    const views = createLibraryViews({ catalogue: () => videos, history: () => list, useWorker });
    try {
      let t = performance.now();
      const first = await views.json('shows', adults.join(','));
      const cold = performance.now() - t;
      t = performance.now();
      const second = await views.json('shows', adults.slice().reverse().join(','));
      const warm = performance.now() - t;
      assert.equal(second, first, 'same audience in another order is the same view');
      assert.ok(warm < 5, `cached call took ${warm.toFixed(1)} ms (cold ${cold.toFixed(1)} ms)`);
      assert.deepEqual(JSON.parse(first), showsView({ videos, history: list, viewers: adults.join(',') }));
      // Concurrent asks share one build.
      const [a, b] = await Promise.all([views.json('library', undefined), views.json('library', undefined)]);
      assert.equal(a, b);
      // A history change makes a fresh view.
      list = [{ ...list[0], positionSeconds: 400, updatedAt: '2026-11-21T00:00:00.000Z' }];
      const moved = JSON.parse(await views.json('shows', adults.join(',')));
      assert.ok(JSON.stringify(moved).includes('"at":400'));
    } finally { views.close(); }
  });
}

test('a new catalogue array invalidates every view', async () => {
  let videos = bigLibrary(2, 2);
  const views = createLibraryViews({ catalogue: () => videos, history: () => [], useWorker: false });
  const before = JSON.parse(await views.json('shows', adults.join(','))).shows.length;
  videos = bigLibrary(6, 2);
  assert.ok(JSON.parse(await views.json('shows', adults.join(','))).shows.length > before);
});

test('the worker keeps the event loop free while it builds', async () => {
  const videos = bigLibrary(1200, 60);
  const views = createLibraryViews({ catalogue: () => videos, history: () => [], useWorker: true });
  try {
    await views.json('shows', undefined);  // the worker starts and holds the catalogue
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    const t = performance.now();
    await views.json('library', 'x');
    const took = performance.now() - t;
    clearInterval(timer);
    if (took > 60) assert.ok(ticks >= Math.floor(took / 5) * 0.5, `${ticks} ticks in ${took.toFixed(0)} ms`);
  } finally { views.close(); }
});

test('the history fingerprint changes when an entry moves to the front', () => {
  assert.equal(historySignature([]), '0');
  const a = historySignature([{ path: '/a', updatedAt: '1', positionSeconds: 1 }]);
  assert.notEqual(a, historySignature([{ path: '/a', updatedAt: '2', positionSeconds: 1 }]));
  assert.notEqual(a, historySignature([{ path: '/a', updatedAt: '1', positionSeconds: 1 }, { path: '/b' }]));
});
