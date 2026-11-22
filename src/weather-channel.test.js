import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Resolved: the photo and weather readers reject symlinked folders, and macOS's tmpdir sits under one.
const TMP = realpathSync(tmpdir());
import { readIsobarProgramme } from './weather-channel.js';

const roots = [];
test.after(async () => Promise.all(roots.map(path => rm(path, { recursive: true, force: true }))));

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(TMP, 'weather-programme-'));
  roots.push(root);
  const generation = 'abc123-v2';
  const dir = join(root, 'generations', generation);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'fronts.mp4'), 'mp4');
  const now = Date.parse('2026-09-27T04:00:00Z');
  await writeFile(join(dir, 'fronts.json'), JSON.stringify({ generatedAt: '2026-09-27T03:00:00Z', validFrom: '2026-09-27T03:00:00Z', validTo: '2026-09-27T08:00:00Z', durationSeconds: 20, attribution: 'ECMWF Open Data · Bureau of Meteorology', keyframes: [{ seconds: 0, validTime: '2026-09-27T03:00:00Z', label: 'Now', region: 'Australia' }], ...overrides }));
  await writeFile(join(root, 'current.json'), JSON.stringify({ generation }));
  return { root, now };
}

test('reads an intact immutable generation and returns a TV slide', async () => {
  const { root, now } = await fixture();
  const result = await readIsobarProgramme({ directory: root, now: () => now });
  assert.equal(result.slide.kind, 'weather-film');
  assert.match(result.slide.video, /^file:/);
  assert.equal(result.durationSeconds, 20);
  assert.match(result.slide.footer, /ECMWF/);
});

test('missing archive, expired forecast and malformed metadata are safe failures', async () => {
  assert.equal(await readIsobarProgramme({ directory: join(TMP, 'no-such-weather-programme') }), null);
  const expired = await fixture({ validTo: '2026-09-27T03:59:00Z' });
  await assert.rejects(() => readIsobarProgramme({ directory: expired.root, now: () => expired.now }), /metadata is invalid/);
  const malformed = await fixture({ durationSeconds: 121 });
  await assert.rejects(() => readIsobarProgramme({ directory: malformed.root, now: () => malformed.now }), /metadata is invalid/);
  const old = await fixture({ generatedAt:'2026-09-20T03:00:00Z', validTo:'2026-10-01T00:00:00Z' });
  await assert.rejects(() => readIsobarProgramme({ directory:old.root, now:()=>old.now }), /need a refresh/);
  const future = await fixture({ generatedAt:'2026-10-01T03:00:00Z' });
  await assert.rejects(() => readIsobarProgramme({ directory:future.root, now:()=>future.now }), /metadata is invalid/);
});

test('rejects traversal and symlink escapes', async () => {
  const traversal = await fixture();
  await writeFile(join(traversal.root, 'current.json'), JSON.stringify({ generation: '..' }));
  await assert.rejects(() => readIsobarProgramme({ directory: traversal.root, now: () => traversal.now }), /archive is invalid/);
  const escaped = await fixture();
  const outside = await mkdtemp(join(TMP, 'weather-outside-'));
  roots.push(outside);
  await writeFile(join(outside, 'fronts.mp4'), 'mp4');
  await rm(join(escaped.root, 'generations', 'abc123-v2', 'fronts.mp4'));
  await symlink(join(outside, 'fronts.mp4'), join(escaped.root, 'generations', 'abc123-v2', 'fronts.mp4'));
  await assert.rejects(() => readIsobarProgramme({ directory: escaped.root, now: () => escaped.now }), /archive is invalid/);
});
