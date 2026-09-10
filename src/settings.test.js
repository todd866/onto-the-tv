import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, validateTvSettings, readSettings, writeSettings } from './settings.js';
import { buildPlayer, generatorArgs, readCatalogue, prepareChannels } from './shuffler.js';
import { fileURLToPath } from 'node:url';

test('TV settings reject credentials and mismatched endpoints', () => {
  const base = { tvHost: '192.0.2.10', avTransportUrl: '', bindHost: '' };
  assert.equal(validateTvSettings(base).tvHost, base.tvHost);
  assert.throws(() => validateTvSettings({ ...base, tvHost: 'http://example.com' }));
  assert.throws(() => validateTvSettings({ ...base, avTransportUrl: 'http://user:pass@192.0.2.10/control' }));
  assert.throws(() => validateTvSettings({ ...base, avTransportUrl: 'http://192.0.2.20/control' }));
  assert.throws(() => validateTvSettings({ ...base, avTransportUrl: 'file:///tmp/a' }));
});

test('parallel settings writes remain whole, private, and leave no temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-settings-'));
  try {
    const path = join(dir, 'settings.json');
    const a = { ...defaults('/example'), tvHost: '192.0.2.10' };
    const b = { ...a, tvHost: '192.0.2.11' };
    await Promise.all([writeSettings(path, a), writeSettings(path, b)]);
    const read = await readSettings(path, '/example');
    assert.ok([a.tvHost, b.tvHost].includes(read.tvHost));
    assert.equal(read.playerPath, '/example/Movies/kids-holiday/kids-shuffler.html');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ['settings.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shuffler rebuild carries personal groups and sources through argv without a shell', async () => {
  const settings = { ...defaults('/example'), tiersPath: '/private/groups.json', sourcesPath: '/private/sources.json' };
  settings.library = '/media/Children\'s Shows $(no-shell)';
  const args = generatorArgs('/app', settings);
  assert.ok(args.includes(settings.library));
  assert.deepEqual(args.slice(-4), ['--sources', settings.sourcesPath, '--tiers', settings.tiersPath]);
  assert.ok(!args.includes('--no-sources'));
  const message = await buildPlayer('/app', settings, async (command, actual, options) => {
    assert.equal(command, 'python3'); assert.deepEqual(actual, args); assert.equal(options.shell, undefined);
    return { stdout: 'Built player\n' };
  });
  assert.equal(message, 'Built player');
});

test('embedded channels read data without running imported HTML and preserve IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-channels-'));
  try {
    const original = join(dir, 'old.html');
    const videos = [{ src: 'Family/one.mp4', path: 'a #1%.mp4', title: '</script><script>bad()</script>', channel: 'Family', tier: 'shared', duration: 5 }];
    const json = JSON.stringify(videos).replaceAll('<', '\\u003c');
    const html = `<script>const VIDEOS = ${json};</script><script>UNTRUSTED_SOURCE_CODE()</script>`;
    await writeFile(original, html);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const result = await prepareChannels(root, { playerPath: original }, join(dir, 'private'));
    const output = fileURLToPath(result.url);
    const content = await readFile(output, 'utf8');
    assert.equal(result.count, 1);
    assert.ok(!content.includes('UNTRUSTED_SOURCE_CODE'));
    assert.ok(!content.includes('<script>bad()'));
    assert.ok(content.includes('media-src file:'));
    const data = readCatalogue(content, output, output);
    assert.equal(data[0].src, videos[0].src);
    assert.equal(data[0].path, '../a #1%.mp4');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.throws(() => readCatalogue('<script>const VIDEOS = [{"src":"a","path":"https://example.com/a","tier":"shared"}];</script>',original,output));
  } finally { await rm(dir, { recursive:true, force:true }); }
});
