import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextQueueAction } from '../src/playlist.js';

describe('nextQueueAction', () => {
  const queue = [
    { url: 'http://host/a.mp4', title: 'A' },
    { url: 'http://host/b.mp4', title: 'B' },
    { url: 'http://host/c.mp4', title: 'C' },
  ];

  it('arms the first queued clip while something else is still playing', () => {
    assert.deepEqual(
      nextQueueAction({
        queue,
        armedIndex: -1,
        currentUri: 'http://old/luxo.mp4',
        state: 'PLAYING',
      }),
      { type: 'arm', index: 0 },
    );
  });

  it('arms the following clip once the queued item becomes current', () => {
    assert.deepEqual(
      nextQueueAction({
        queue,
        armedIndex: 0,
        currentUri: 'http://host/a.mp4',
        state: 'PLAYING',
      }),
      { type: 'arm', index: 1 },
    );
  });

  it('plays the next clip if the renderer stops instead of auto-advancing', () => {
    assert.deepEqual(
      nextQueueAction({
        queue,
        armedIndex: 0,
        currentUri: 'http://old/luxo.mp4',
        state: 'STOPPED',
      }),
      { type: 'play', index: 0 },
    );
  });
});
