// 22 Nov 2026: a title whose file is on no drive is listed in the catalogue with a `cloud` marker (size and
// mtime from shuffler/make_shuffler.py's cloud manifest) and plays through the cache from the cloud copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCatalogue, mtimeMsFromNs } from './shuffler.js';
import { createMediaCache } from './media-cache.js';
import { createFileStorage, createTvLibrary, createTvServer } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';

test('mtimeMsFromNs gives exactly the mtimeMs Node reports, so blocks cached from the drive keep their identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'onto-cloud-catalogue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, seconds] of [1731234567.123456, 1700000000, 1699999999.999, 86401.5, 1795300000.000001, 1731234567.987654321].entries()) {
    const file = join(root, `f${index}`);
    await writeFile(file, 'x');
    await utimes(file, seconds, seconds);
    const exact = await stat(file, { bigint: true }), plain = await stat(file);
    assert.equal(mtimeMsFromNs(String(exact.mtimeNs)), plain.mtimeMs, `mtime ${seconds}`);
  }
  assert.equal(mtimeMsFromNs('soon'), null);
  assert.equal(mtimeMsFromNs(''), null);
  assert.equal(mtimeMsFromNs(1731234567123456789), null);        // a number has already lost its last digits
});

test('readCatalogue carries a valid cloud marker and drops a malformed one', () => {
  const entry = (name, cloud) => ({ src: `Show/${name}`, path: `Show/${name}`, title: name, channel: 'Show', tier: 'shared', duration: 60, ...(cloud ? { cloud } : {}) });
  const html = `<script>const VIDEOS = ${JSON.stringify([
    entry('a.mp4'), entry('b.mp4', { size: 1000, mtime: '1731234567123456789' }), entry('c.mp4', { size: 0, mtime: '5' }),
    entry('d.mp4', { size: 10, mtime: 'soon' }), entry('e.mp4', { size: 10.5, mtime: '5' }), entry('f.mp4', 'yes'),
  ])};</script>`;
  const videos = readCatalogue(html, '/lib/out.html', '/lib/out.html');
  assert.equal('cloud' in videos[0], false);
  assert.deepEqual(videos[1].cloud, { size: 1000, mtimeMs: mtimeMsFromNs('1731234567123456789') });
  assert.equal(videos[1].file, '/lib/Show/b.mp4');
  for (const index of [2, 3, 4, 5]) assert.equal('cloud' in videos[index], false);
});

test('a title held only in the cloud plays over HTTP through the cache; one that is simply missing is offline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'onto-cloud-catalogue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const gone = join(root, 'gone.mp4'), lost = join(root, 'lost.mp4');
  const asked = [];
  const remote = async (file, start, length) => { asked.push(file); return content.subarray(start, start + length); };
  const history = await loadPlaybackHistory(join(root, 'history.json')), storage = await createFileStorage(join(root, 'taste.json'));
  const mediaCache = await createMediaCache({ directory: join(root, 'cache'), eligible: () => true, blockBytes: 64, reserveBytes: 0, maxBytes: 8192, remote });
  const library = createTvLibrary({ videos: [
    { src: 'gone.mp4', file: gone, title: 'Gone', channel: 'Show', tier: 'shared', duration: 100, cloud: { size: 1000, mtimeMs: 5 } },
    { src: 'lost.mp4', file: lost, title: 'Lost', channel: 'Show', tier: 'shared', duration: 100 },
  ], history, storage });
  const server = createTvServer({ library, history, storage, mediaCache, uiRoot: root, token: 'test-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await mediaCache.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { 'x-onto-token': 'test-token' };
  for (const [range, start, end] of [['bytes=0-99', 0, 99], ['bytes=60-170', 60, 170], ['bytes=-25', 975, 999], [null, 0, 999]]) {
    const response = await fetch(`${base}/media?src=gone.mp4`, { headers: { ...headers, ...(range ? { Range: range } : {}) } });
    assert.equal(response.status, range ? 206 : 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content.subarray(start, end + 1));
  }
  assert.ok(asked.length > 0 && asked.every(file => file === gone));
  const head = await fetch(`${base}/media?src=gone.mp4`, { method: 'HEAD', headers: { ...headers, Range: 'bytes=0-99' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '100');
  assert.equal((await fetch(`${base}/media?src=gone.mp4`, { headers: { ...headers, Range: 'bytes=1000-' } })).status, 416);
  assert.equal((await fetch(`${base}/media?src=lost.mp4`, { headers })).status, 404);
});

test('the real catalogue builder and the server agree: a manifest entry becomes a title that plays', async t => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { loadCatalogue } = await import('./tv-server.js');
  const root = await mkdtemp(join(tmpdir(), 'onto-cloud-seam-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builder = fileURLToPath(new URL('../shuffler/make_shuffler.py', import.meta.url));
  const output = join(root, 'data', 'catalogue.html'), gone = join(root, 'library', 'A Show', 'Episode 9.mp4');
  execFileSync('python3', ['-c', `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('make_shuffler', sys.argv[1])
gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
library, output, gone = Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
library.mkdir(parents=True)
manifest = gen.cloud_manifest_path(output)
gen.record_cloud(manifest, {'1|' + gone: {'size': 1000, 'mtime': 1731234567123456789, 'duration': 321.5, 'error': None}}, [gone], tv=True)
videos, rejected = gen.collect_videos(library, output, tiers={'shared': {'A Show'}}, cloud=gen.load_cloud_manifest(manifest))
assert not rejected and len(videos) == 1, (videos, rejected)
gen.atomic_write(output, gen.render_html(videos))
`, builder, join(root, 'library'), output, gone]);
  const videos = await loadCatalogue(output);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].file, gone);
  assert.deepEqual(videos[0].cloud, { size: 1000, mtimeMs: mtimeMsFromNs('1731234567123456789') });
  assert.equal(videos[0].duration, 321.5);
  const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 3) % 251));
  const history = await loadPlaybackHistory(join(root, 'history.json')), storage = await createFileStorage(join(root, 'taste.json'));
  const mediaCache = await createMediaCache({ directory: join(root, 'cache'), eligible: () => true, blockBytes: 128, reserveBytes: 0, maxBytes: 8192,
    remote: async (file, start, length) => { assert.equal(file, gone); return content.subarray(start, start + length); } });
  const server = createTvServer({ library: createTvLibrary({ videos, history, storage }), history, storage, mediaCache, uiRoot: root, token: 'test-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await mediaCache.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/media?src=${encodeURIComponent(videos[0].src)}`,
    { headers: { 'x-onto-token': 'test-token', Range: 'bytes=100-499' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content.subarray(100, 500));
});

test('the catalogue signature moves when the cloud manifest does', async () => {
  const { cloudManifestSignaturePart } = await import('./tv-server.js');
  assert.equal(cloudManifestSignaturePart(null), 'cloud-manifest:none');
  const first = cloudManifestSignaturePart({ mtimeMs: 1000, size: 200 });
  assert.notEqual(first, cloudManifestSignaturePart(null));
  assert.notEqual(first, cloudManifestSignaturePart({ mtimeMs: 1001, size: 200 }));
  assert.notEqual(first, cloudManifestSignaturePart({ mtimeMs: 1000, size: 201 }));
  assert.equal(first, cloudManifestSignaturePart({ mtimeMs: 1000, size: 200 }));
});
