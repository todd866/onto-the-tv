import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSamsungCompatible, decidePipeline } from '../src/probe.js';

describe('isSamsungCompatible', () => {
  it('accepts 1080p H.264 High@L4.1 with AAC in MP4', () => {
    assert.equal(
      isSamsungCompatible({
        container: 'mp4',
        videoCodec: 'h264',
        videoProfile: 'High',
        videoLevel: 41,
        width: 1920,
        height: 1080,
        audioCodec: 'aac',
        audioChannels: 2,
      }),
      true,
    );
  });

  it('serves 1080p HEVC in Matroska as-is: the MU8000 decodes it natively', () => {
    assert.equal(
      isSamsungCompatible({
        container: 'matroska',
        videoCodec: 'hevc',
        videoLevel: 120,
        width: 1920,
        height: 800,
        audioCodec: 'aac',
        audioChannels: 6,
      }),
      true,
    );
  });

  it('rejects 4K, high H.264 levels, and unknown codecs so the TV gets a transcode instead', () => {
    assert.equal(
      isSamsungCompatible({
        container: 'mp4',
        videoCodec: 'h264',
        videoLevel: 51,
        width: 3840,
        height: 2160,
        audioCodec: 'aac',
      }),
      false,
    );
    assert.equal(
      isSamsungCompatible({
        container: 'mp4',
        videoCodec: 'hevc',
        width: 3840,
        height: 2160,
        audioCodec: 'aac',
      }),
      false,
    );
    assert.equal(
      isSamsungCompatible({
        container: 'mkv',
        videoCodec: 'vp9',
        width: 1920,
        height: 1080,
        audioCodec: 'opus',
      }),
      false,
    );
  });

  it('accepts audio-only AAC or MP3', () => {
    assert.equal(
      isSamsungCompatible({ container: 'm4a', audioCodec: 'aac', audioChannels: 2 }),
      true,
    );
    assert.equal(
      isSamsungCompatible({ container: 'mp3', audioCodec: 'mp3' }),
      true,
    );
  });
});

describe('decidePipeline', () => {
  it('serves a compatible local file as-is', () => {
    assert.equal(
      decidePipeline({ source: 'file', compatible: true, hasVideo: true }).action,
      'serve',
    );
  });

  it('transcodes incompatible video to H.264/AAC MP4', () => {
    assert.deepEqual(
      decidePipeline({ source: 'file', compatible: false, hasVideo: true }),
      { action: 'transcode', container: 'mp4', video: 'h264', audio: 'aac' },
    );
  });

  it('plays Art Tracks as audio so the TV never opens the YouTube app', () => {
    assert.deepEqual(
      decidePipeline({ source: 'youtube', isArtTrack: true }),
      { action: 'audio', container: 'm4a', audio: 'aac' },
    );
  });
});
