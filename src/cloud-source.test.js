import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRcloneSource, rcloneCryptEnv } from './cloud-source.js';
import { createMediaCache } from './media-cache.js';

// A stand-in for rclone: `cat <remote path> --offset N --count M` prints that range of the file the remote path
// maps to under FAKE_REMOTE, and records its arguments. No network, no real backup.
const FAKE = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== 'cat') { console.error('unexpected verb'); process.exit(2); }
const target = args[1];
if (target.includes('boom')) { console.error('2026/11/22 NOTICE: something earlier'); console.error('Failed to cat: object not found'); process.exit(3); }
const offset = Number(args[args.indexOf('--offset') + 1]), count = Number(args[args.indexOf('--count') + 1]);
const file = path.join(process.env.FAKE_REMOTE, target.replace(/^gcrypt:current\\//, ''));
const done = () => { const data = fs.readFileSync(file); process.stdout.write(data.subarray(offset, offset + count)); };
if (target.includes('slow')) setTimeout(done, 5000); else done();
`;

const setup = async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'onto-cloud-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-rclone.cjs'), remoteDir = join(root, 'remote'), log = join(root, 'calls.log');
  await fs.writeFile(script, FAKE);
  await fs.writeFile(log, '');
  const put = async (rel, data) => { await fs.mkdir(join(remoteDir, rel, '..'), { recursive: true }); await fs.writeFile(join(remoteDir, rel), data); };
  const calls = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const source = (extra = {}) => createRcloneSource({ rclone: [process.execPath, script],
    roots: [{ path: '/Volumes/Stash', name: 'Stash' }, { path: '/Volumes/Elsewhere/', name: 'Elsewhere' }],
    env: { ...process.env, FAKE_REMOTE: remoteDir, FAKE_LOG: log }, ...extra });
  return { root, put, calls, source };
};

test('a range of a backed-up file comes back exactly, by the path the backup uses', async t => {
  const { put, calls, source } = await setup(t);
  const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  await put('Stash/Movies/A Show/Ep 1 – café.mp4', data);
  const read = source();
  assert.deepEqual(await read('/Volumes/Stash/Movies/A Show/Ep 1 – café.mp4', 10, 6), data.subarray(10, 16));
  const [args] = await calls();
  assert.deepEqual(args.slice(0, 6), ['cat', 'gcrypt:current/Stash/Movies/A Show/Ep 1 – café.mp4', '--offset', '10', '--count', '6']);
  assert.equal(read.remotePath('/Volumes/Elsewhere/Movies/x.mp4'), 'gcrypt:current/Elsewhere/Movies/x.mp4');
});

test('a file outside every backed-up folder is refused without running rclone', async t => {
  const { calls, source } = await setup(t);
  await assert.rejects(source()('/Users/someone/Movies/x.mp4', 0, 4), { code: 'ENOENT' });
  assert.deepEqual(await calls(), []);
});

test('an rclone failure carries its last line, and a hung read is cut off', async t => {
  const { put, source } = await setup(t);
  await assert.rejects(source()('/Volumes/Stash/Movies/boom.mp4', 0, 4), error => error.code === 'EREMOTE' && /object not found/.test(error.message));
  await put('Stash/Movies/slow.mp4', Buffer.from('abcdefgh'));
  await assert.rejects(source({ timeoutMs: 300 })('/Volumes/Stash/Movies/slow.mp4', 0, 4), { code: 'ETIMEDOUT' });
  await assert.rejects(createRcloneSource({ rclone: '/nonexistent/rclone', roots: [{ path: '/Volumes/Stash', name: 'Stash' }] })('/Volumes/Stash/x', 0, 1), { code: 'EREMOTE' });
});

test('end to end: a title that is on no drive plays through the cache from the cloud copy, and its blocks are kept', async t => {
  const { root, put, calls, source } = await setup(t);
  const data = Buffer.alloc(40); for (let i = 0; i < data.length; i++) data[i] = i * 7 % 251;
  await put('Stash/Movies/films/A Film (1950)/A Film (1950).mp4', data);
  const file = '/Volumes/Stash/Movies/films/A Film (1950)/A Film (1950).mp4';
  const options = { directory: join(root, 'cache'), blockBytes: 8, statfs: async () => ({ bavail: 1e12, bsize: 1 }), remote: source() };
  let cache = await createMediaCache(options);
  const bytes = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); };
  assert.deepEqual(await bytes(await cache.stream(file, { size: data.length, mtimeMs: 1 }, { start: 5, end: 30 })), data.subarray(5, 31));
  await cache.close();
  const fetched = (await calls()).length;
  assert.ok(fetched >= 4 && fetched <= 5);
  cache = await createMediaCache(options);                       // after a restart the same range needs no cloud read
  assert.deepEqual(await bytes(await cache.stream(file, { size: data.length, mtimeMs: 1 }, { start: 5, end: 30 })), data.subarray(5, 31));
  await cache.close();
  assert.equal((await calls()).length, fetched);
});

test('the crypt environment is built for standard name encryption, and never takes a bare password by accident', () => {
  const env = rcloneCryptEnv({ remote: 'example:Backup', obscuredPassword: 'OBSCURED', base: { PATH: '/bin' } });
  assert.deepEqual(env, { PATH: '/bin', RCLONE_CONFIG_GCRYPT_TYPE: 'crypt', RCLONE_CONFIG_GCRYPT_REMOTE: 'example:Backup',
    RCLONE_CONFIG_GCRYPT_PASSWORD: 'OBSCURED', RCLONE_CONFIG_GCRYPT_FILENAME_ENCRYPTION: 'standard', RCLONE_CONFIG_GCRYPT_DIRECTORY_NAME_ENCRYPTION: 'true' });
  assert.throws(() => rcloneCryptEnv({ remote: 'example:x' }), /obscured password/);
});

test('openCloudSource takes every site value from its config file; the password is never an argument or in an error', async () => {
  const { openCloudSource } = await import('./cloud-source.js');
  const calls = [];
  const config = '/data/tv-server/cloud-source.json';
  const files = {
    [config]: { remote: 'example:Backup', keychain: 'example-item', roots: [{ name: 'Drive', path: '/drives/Drive' }, { name: 'home', path: '~' }, { name: 7 }] },
    '/home/x/elsewhere/sources.json': { sources: [{ name: 'Other', path: '/drives/Other' }] },
  };
  const readJson = path => { if (!(path in files)) throw new Error('ENOENT'); return files[path]; };
  const run = async (program, args, input = null) => {
    calls.push({ program, args, input });
    return program.endsWith('security') ? 'correct horse battery\n' : 'OBSCURED-TEXT\n';
  };
  const open = (extra = {}) => openCloudSource({ configPath: config, home: '/home/x', run, readJson, rclone: 'rclone', env: { PATH: '/bin' }, ...extra });
  const read = await open();
  assert.deepEqual(calls[0], { program: '/usr/bin/security', args: ['find-generic-password', '-s', 'example-item', '-w'], input: null });
  assert.deepEqual(calls[1], { program: 'rclone', args: ['obscure', '-'], input: 'correct horse battery' });
  assert.ok(calls.every(call => !call.args.join(' ').includes('correct horse')));
  assert.equal(read.remotePath('/drives/Drive/Movies/a.mp4'), 'gcrypt:current/Drive/Movies/a.mp4');
  assert.equal(read.remotePath('/home/x/Movies/a.mp4'), 'gcrypt:current/home/Movies/a.mp4');

  // The sources can come from another file, and the folder inside the backup can be named.
  files[config] = { remote: 'example:Backup', keychain: 'example-item', rootsFrom: '~/elsewhere/sources.json', prefix: '/live/' };
  assert.equal((await open()).remotePath('/drives/Other/a.mp4'), 'gcrypt:live/Other/a.mp4');

  // Nothing is assumed: a missing file, or a missing value, is an error that says what to write, and no error carries the password.
  await assert.rejects(openCloudSource({ home: '/home/x', run, readJson, rclone: 'rclone' }), /needs its config file/);
  await assert.rejects(open({ configPath: '/data/tv-server/absent.json' }), /not configured/);
  files[config] = { keychain: 'example-item', roots: [{ name: 'Drive', path: '/drives/Drive' }] };
  await assert.rejects(open(), /must name the backup's "remote" and its "keychain" item/);
  files[config] = { remote: 'example:Backup', keychain: 'example-item' };
  await assert.rejects(open(), /names no backup sources/);
  files[config] = { remote: 'example:Backup', keychain: 'example-item', roots: [{ name: 'Drive', path: '/drives/Drive' }] };
  await assert.rejects(open({ run: async () => '' }), /could not be read from the keychain/);
  await assert.rejects(open({ run: async program => (program.endsWith('security') ? 'correct horse battery\n' : '') }),
    error => /obscure returned nothing/.test(error.message) && !error.message.includes('correct horse'));
});

test('serve: true runs a persistent loopback rclone serve http daemon with env-only Basic Auth and serves Range blocks over real rclone crypt', async t => {
  const rcloneBin = '/opt/homebrew/bin/rclone';
  const haveRclone = await fs.access(rcloneBin).then(() => true, () => false);
  if (!haveRclone) { t.skip('rclone not installed'); return; }
  const { execFileSync } = await import('node:child_process');
  const root = await fs.mkdtemp(join(tmpdir(), 'onto-cloud-http-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backingDir = join(root, 'backing');
  await fs.mkdir(backingDir, { recursive: true });
  const obscured = execFileSync(rcloneBin, ['obscure', '-'], { input: 'test-crypt-pw' }).toString().trim();
  const env = rcloneCryptEnv({ remote: backingDir, obscuredPassword: obscured, base: process.env });

  // Write a real encrypted object through rclone itself, with spaces and UTF-8 in its name.
  const payload = Buffer.alloc(65536);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 17) & 0xff;
  const plainSrc = join(root, 'Ep 1 – café.mp4');
  await fs.writeFile(plainSrc, payload);
  execFileSync(rcloneBin, ['copyto', plainSrc, 'gcrypt:current/Stash/Movies/Show/Ep 1 – café.mp4'], { env });

  const read = createRcloneSource({
    rclone: rcloneBin,
    remote: 'gcrypt:current',
    roots: [{ path: '/Volumes/Stash', name: 'Stash' }],
    env,
    serve: true,
  });
  t.after(() => read.close());

  const f = '/Volumes/Stash/Movies/Show/Ep 1 – café.mp4';
  assert.deepEqual(await read(f, 0, 4096), payload.subarray(0, 4096));
  assert.deepEqual(await read(f, 12345, 8192), payload.subarray(12345, 12345 + 8192));
  assert.deepEqual(await read(f, 65000, 536), payload.subarray(65000, 65536));
  await assert.rejects(read('/Volumes/Stash/Movies/Show/missing.mp4', 0, 16), { code: 'ENOENT' });
  await read.close();
});
