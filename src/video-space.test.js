import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIDEO_AFFINITY_BONUS, loadVideoSpace, videoAffinity } from './video-space.js';

const SAMPLE = {
  version: 1,
  videos: {
    'grown-ups/Films/Die Hard (1988).mp4': {
      tier: 2,
      models: ['gemini', 'gemma'],
      next: [
        ['grown-ups/Films/Lethal Weapon (1987).mp4', 0.82],
        ['grown-ups/Films/Gremlins (1984).mp4', 0.51],
      ],
    },
    'grown-ups/Films/Lethal Weapon (1987).mp4': {
      tier: 2,
      models: ['gemini', 'gemma'],
      next: [['grown-ups/Films/Die Hard (1988).mp4', 0.82]],
    },
  },
};

test('videoAffinity lifts neighbours of recently watched items and stays neutral for unknowns', () => {
  const space = loadVideoSpace.from(SAMPLE);
  assert.ok(space);
  const score = videoAffinity(space, 'grown-ups/Films/Lethal Weapon (1987).mp4', ['grown-ups/Films/Die Hard (1988).mp4']);
  assert.ok(Math.abs(score - (1 + VIDEO_AFFINITY_BONUS * 0.82)) < 1e-6);
  assert.equal(videoAffinity(space, 'unknown/video.mp4', ['grown-ups/Films/Die Hard (1988).mp4']), 1);
  assert.equal(videoAffinity(space, 'grown-ups/Films/Die Hard (1988).mp4', ['grown-ups/Films/Die Hard (1988).mp4']), 1);
  assert.equal(videoAffinity(null, 'grown-ups/Films/Die Hard (1988).mp4', ['grown-ups/Films/Lethal Weapon (1987).mp4']), 1);
});

test('loadVideoSpace tolerates missing and corrupt files cleanly', () => {
  assert.equal(loadVideoSpace('/nonexistent/video-space.json'), null);
  const dir = mkdtempSync(join(tmpdir(), 'otv-vspace-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{broken');
  assert.equal(loadVideoSpace(bad), null);
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(SAMPLE));
  assert.ok(loadVideoSpace(good));
});
