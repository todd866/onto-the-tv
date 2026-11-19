import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTasteAppender, tasteArgs, tasteListenerFor } from './music-taste.js';

const video = { src: 'music/Phantogram/Phantogram - Fall In Love [RsQjC5zVnt8].mp4', title: 'Phantogram - Fall In Love', channel: 'Phantogram', tier: 'music' };

test('TV likes are the household\'s unless one mapped viewer is watching', () => {
  assert.equal(tasteListenerFor(['mum', 'dad']), 'household-tv');
  assert.equal(tasteListenerFor('dad'), 'household-tv');
  assert.equal(tasteListenerFor('dad', { dad: 'ian' }), 'ian');
  assert.equal(tasteListenerFor(['dad', 'mum'], { dad: 'ian' }), 'household-tv');
});

test('only music videos are logged, named by YouTube id and artist/title', () => {
  assert.equal(tasteArgs({ item: { ...video, tier: 'shows' }, liked: true }), null);
  const args = tasteArgs({ item: video, liked: false, viewers: 'mum,dad' });
  assert.deepEqual(args.slice(0, 7), ['append', '--listener', 'household-tv', '--app', 'onto-the-tv', '--kind', 'unlike']);
  assert.ok(args.includes('RsQjC5zVnt8') && args.includes('Fall In Love'));
});

test('appender never throws and does nothing without the tool', () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push(args); cb(new Error('boom')); };
  const logs = [];
  const rec = createTasteAppender({ tool: '/x/musicstore.py', python: '/x/python3', run, exists: () => true, log: m => logs.push(m) });
  assert.equal(rec({ item: video, liked: true, viewers: 'dad' }), true);
  assert.equal(calls.length, 1);
  assert.match(logs[0], /boom/);
  const off = createTasteAppender({ tool: '/x/musicstore.py', run, exists: () => false });
  assert.equal(off({ item: video, liked: true }), false);
});
