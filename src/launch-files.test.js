import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filesFromArgv } from './launch-files.js';

describe('filesFromArgv', () => {
  it('keeps dropped videos and ignores Electron’s own paths', () => {
    const files = filesFromArgv(
      [
        '/home/example/onto-the-tv/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        '/home/example/onto-the-tv',
        '/home/example/Videos/Luxo Jr. - Pixar (1986).mp4',
      ],
      { appRoot: '/home/example/onto-the-tv' },
    );
    assert.deepEqual(files, ['/home/example/Videos/Luxo Jr. - Pixar (1986).mp4']);
  });
});
