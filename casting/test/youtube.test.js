import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeId, pickYtDlpFormat } from '../src/youtube.js';

describe('parseYouTubeId', () => {
  it('extracts IDs from watch, youtu.be, and shorts URLs', () => {
    assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=4'), 'dQw4w9WgXcQ');
    assert.equal(parseYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseYouTubeId('/tmp/movie.mp4'), null);
  });
});

describe('pickYtDlpFormat', () => {
  it('prefers a progressive AVC/AAC MP4 when one exists', () => {
    const format = pickYtDlpFormat([
      { format_id: '18', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', ext: 'mp4', protocol: 'https', height: 360 },
      { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', ext: 'mp4', protocol: 'https', height: 1080 },
      { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', protocol: 'https' },
    ]);
    assert.equal(format.format_id, '18');
  });

  it('falls back to merging AVC video plus AAC audio', () => {
    const format = pickYtDlpFormat([
      { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', ext: 'mp4', protocol: 'https', height: 1080 },
      { format_id: '399', vcodec: 'av01.0.08M.08', acodec: 'none', ext: 'mp4', protocol: 'https', height: 1080 },
      { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', protocol: 'https' },
    ]);
    assert.equal(format.format_id, '137+140');
  });
});
