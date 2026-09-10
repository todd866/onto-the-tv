import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandPaths, normalizeUri, VIDEO_EXT } from './paths.js';

describe('expandPaths', () => {
  it('keeps video files and expands one folder level', async () => {
    const fs = {
      async stat(path) {
        if (path === '/media') return { isDirectory: () => true, isFile: () => false };
        return { isDirectory: () => false, isFile: () => true };
      },
      async readdir(path) {
        assert.equal(path, '/media');
        return ['clip.mp4', 'notes.txt', 'song.m4a'];
      },
    };
    const paths = await expandPaths(['/media', '/other/movie.mkv', '/secret.docx'], fs);
    assert.deepEqual(paths, ['/media/clip.mp4', '/media/song.m4a', '/other/movie.mkv']);
  });
});

describe('normalizeUri', () => {
  it('treats Samsung XML-escaped apostrophes as the same file', () => {
    const served = "http://192.0.2.20/x/Red's%20Dream.mp4";
    const fromTv = 'http://192.0.2.20/x/Red&apos;s%20Dream.mp4';
    assert.equal(normalizeUri(served), normalizeUri(fromTv));
  });
});

describe('VIDEO_EXT', () => {
  it('includes the containers we can send to the TV', () => {
    assert.ok(VIDEO_EXT.has('.mp4'));
    assert.ok(VIDEO_EXT.has('.mkv'));
    assert.equal(VIDEO_EXT.has('.txt'), false);
  });
});

it('accepts literal percent signs in TV-reported file names', () => {
  assert.equal(normalizeUri('http://host/100% fun.mp4'), 'http://host/100% fun.mp4');
});
