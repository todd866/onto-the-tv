import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, validateTvSettings, readSettings, writeSettings } from './settings.js';
import { buildPlayer, generatorArgs } from './shuffler.js';

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
