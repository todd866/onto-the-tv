// Reads by folder id (src/cloud-source.js, `base`): a folder is looked up once, then addressed directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRcloneSource } from './cloud-source.js';

// A stand-in for rclone that knows the three verbs the reader uses. "Encryption" is 'e' + hex of each path
// segment; a folder's id is 'ID.' + hex of its plain path. Every call's arguments are recorded, with whether
// the by-folder remote was configured and carried the password in its environment (never in arguments).
const FAKE = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2), env = process.env;
const enc = p => p.split('/').map(s => 'e' + Buffer.from(s).toString('hex')).join('/');
const dec = p => p.split('/').map(s => Buffer.from(s.slice(1), 'hex').toString()).join('/');
const local = plain => path.join(env.FAKE_REMOTE, plain.replace(/^current\\/?/, ''));
fs.appendFileSync(env.FAKE_LOG, JSON.stringify({ args, byFolder: env.RCLONE_CONFIG_GCRYPTDIR_REMOTE || null,
  byFolderPassword: env.RCLONE_CONFIG_GCRYPTDIR_PASSWORD || null }) + '\\n');
const range = () => [Number(args[args.indexOf('--offset') + 1]), Number(args[args.indexOf('--count') + 1])];
const out = file => { const [offset, count] = range(); process.stdout.write(fs.readFileSync(file).subarray(offset, offset + count)); };
if (args[0] === 'cryptdecode') { console.log(args[3] + ' \\t ' + enc(args[3])); }
else if (args[0] === 'lsjson') {
  const parent = dec(args[1].slice('fakebase:Backup (encrypted)/'.length));
  let names = []; try { names = fs.readdirSync(local(parent), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  if (env.FAKE_HIDE) names = names.filter(n => n !== env.FAKE_HIDE);
  console.log(JSON.stringify(names.map(n => ({ Path: enc(n), Name: enc(n), IsDir: true, ID: 'ID.' + Buffer.from(parent + '/' + n).toString('hex') }))));
}
else if (args[0] === 'cat' && args[1].startsWith('gcryptdir:')) {
  const id = /root_folder_id=([^:]+):/.exec(env.RCLONE_CONFIG_GCRYPTDIR_REMOTE)[1];
  if (!id.startsWith('ID.') || id.endsWith('.stale')) { console.error('Failed to cat: directory not found'); process.exit(3); }
  out(path.join(local(Buffer.from(id.slice(3), 'hex').toString()), args[1].slice('gcryptdir:'.length)));
}
else if (args[0] === 'cat') { out(local(args[1].slice('gcrypt:'.length))); }
else { console.error('unexpected verb'); process.exit(2); }
`;

const setup = async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'onto-cloud-folders-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-rclone.cjs'), remoteDir = join(root, 'remote'), log = join(root, 'calls.log');
  await fs.writeFile(script, FAKE);
  await fs.writeFile(log, '');
  const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  await fs.mkdir(join(remoteDir, 'Stash/Movies/A Show'), { recursive: true });
  await fs.writeFile(join(remoteDir, 'Stash/Movies/A Show/Ep 1 – café.mp4'), data);
  await fs.writeFile(join(remoteDir, 'Stash/Movies/A Show/Ep 2.mp4'), data.subarray(5));
  const calls = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const verbs = async () => (await calls()).map(call => (call.args[0] === 'cat' ? `cat ${call.args[1].split(':')[0]}` : call.args[0]));
  const source = (extra = {}, envExtra = {}) => createRcloneSource({ rclone: [process.execPath, script], base: 'fakebase:Backup (encrypted)',
    roots: [{ path: '/Volumes/Stash', name: 'Stash' }],
    env: { ...process.env, FAKE_REMOTE: remoteDir, FAKE_LOG: log, RCLONE_CONFIG_GCRYPT_PASSWORD: 'OBSCURED-SECRET', ...envExtra }, ...extra });
  return { root, data, calls, verbs, source, clear: () => fs.writeFile(log, '') };
};
const FILE1 = '/Volumes/Stash/Movies/A Show/Ep 1 – café.mp4', FILE2 = '/Volumes/Stash/Movies/A Show/Ep 2.mp4';

test('a folder is looked up once; every later read in it is a single call addressed by its id', async t => {
  const { data, calls, verbs, source, clear } = await setup(t);
  const read = source();
  assert.deepEqual(await read(FILE1, 10, 6), data.subarray(10, 16));
  assert.deepEqual(await verbs(), ['cryptdecode', 'lsjson', 'cat gcryptdir']);
  const first = await calls();
  assert.deepEqual(first[0].args.slice(0, 4), ['cryptdecode', '--reverse', 'gcrypt:', 'current/Stash/Movies/A Show']);
  assert.equal(first[2].args[1], 'gcryptdir:Ep 1 – café.mp4');
  assert.match(first[2].byFolder, /^fakebase,root_folder_id=ID\.[0-9a-f]+:$/);
  assert.equal(first[2].byFolderPassword, 'OBSCURED-SECRET');
  assert.ok(first.every(call => !call.args.join(' ').includes('OBSCURED-SECRET')));
  await clear();
  assert.deepEqual(await read(FILE2, 0, 4), data.subarray(5, 9));
  assert.deepEqual(await read(FILE1, 30, 6), data.subarray(30, 36));
  assert.deepEqual(await verbs(), ['cat gcryptdir', 'cat gcryptdir']);
  assert.equal(read.knownFolders(), 1);
});

test('blocks asked for at the same moment share one lookup', async t => {
  const { data, verbs, source } = await setup(t);
  const read = source();
  const [a, b, c] = await Promise.all([read(FILE1, 0, 4), read(FILE1, 4, 4), read(FILE2, 0, 4)]);
  assert.deepEqual([a, b, c], [data.subarray(0, 4), data.subarray(4, 8), data.subarray(5, 9)]);
  const seen = await verbs();
  assert.equal(seen.filter(verb => verb === 'cryptdecode').length, 1);
  assert.equal(seen.filter(verb => verb === 'lsjson').length, 1);
});

test('ids are kept on disk, privately, and a later reader starts with them', async t => {
  const { root, data, verbs, source, clear } = await setup(t);
  const idFile = join(root, 'cloud-folder-ids.json');
  await source({ idFile })(FILE1, 0, 4);
  const saved = JSON.parse(await fs.readFile(idFile, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['current/Stash/Movies/A Show']);
  assert.equal((await fs.stat(idFile)).mode & 0o777, 0o600);
  await clear();
  assert.deepEqual(await source({ idFile })(FILE2, 0, 4), data.subarray(5, 9));
  assert.deepEqual(await verbs(), ['cat gcryptdir']);
});

test('a folder that cannot be found, or an id that has gone stale, falls back to the read by path', async t => {
  const { root, data, verbs, source, clear } = await setup(t);
  const hidden = source({}, { FAKE_HIDE: 'A Show' });               // the listing does not show the folder
  assert.deepEqual(await hidden(FILE1, 10, 6), data.subarray(10, 16));
  assert.deepEqual(await verbs(), ['cryptdecode', 'lsjson', 'cat gcrypt']);
  assert.equal(hidden.knownFolders(), 0);
  await clear();
  const idFile = join(root, 'ids.json');
  await fs.writeFile(idFile, JSON.stringify({ 'current/Stash/Movies/A Show': 'ID.00.stale' }));
  const stale = source({ idFile });
  assert.deepEqual(await stale(FILE1, 10, 6), data.subarray(10, 16));
  assert.deepEqual(await verbs(), ['cat gcryptdir', 'cat gcrypt']);     // tried by id, then by path
  assert.equal(stale.knownFolders(), 0);                                 // and the stale id is forgotten
  await clear();
  assert.deepEqual(await stale(FILE1, 0, 4), data.subarray(0, 4));
  assert.deepEqual(await verbs(), ['cryptdecode', 'lsjson', 'cat gcryptdir']);   // looked up afresh
});

test('without `base` nothing changes: every read goes by path', async t => {
  const { data, verbs, source } = await setup(t);
  assert.deepEqual(await source({ base: null })(FILE1, 10, 6), data.subarray(10, 16));
  assert.deepEqual(await verbs(), ['cat gcrypt']);
});
