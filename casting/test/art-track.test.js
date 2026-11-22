import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyYouTubeItem, rememberArtTrack, isKnownArtTrack } from '../src/art-track.js';

describe('classifyYouTubeItem', () => {
  it('treats MUSIC_VIDEO_TYPE_ATV as an Art Track', () => {
    assert.deepEqual(
      classifyYouTubeItem({ videoDetails: { videoId: 'abc', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' } }),
      { videoId: 'abc', isArtTrack: true },
    );
  });

  it('does not guess from a Topic channel name when the type field is missing', () => {
    assert.deepEqual(
      classifyYouTubeItem({
        videoDetails: { videoId: 'def', author: 'Daft Punk - Topic', title: 'Get Lucky' },
      }),
      { videoId: 'def', isArtTrack: false },
    );
  });

  it('fails open on malformed player JSON', () => {
    assert.deepEqual(classifyYouTubeItem(null), { videoId: null, isArtTrack: false });
    assert.deepEqual(classifyYouTubeItem({}), { videoId: null, isArtTrack: false });
  });
});

describe('Art Track memory', () => {
  it('keeps a positive match sticky if a later partial response omits the field', () => {
    rememberArtTrack('abc', true);
    rememberArtTrack('abc', false);
    assert.equal(isKnownArtTrack('abc'), true);
  });
});
