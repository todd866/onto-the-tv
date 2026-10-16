import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Blackbox } from './blackbox.js';

test('blackbox caps entries by age and count', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-blackbox-'));
  try {
    let now = 1_000_000;
    const box = new Blackbox({ userData: dir, now: () => now, maxAge: 100, maxEntries: 2 });
    box.record('old');
    now += 50; box.record('middle');
    now += 51; box.record('new');
    assert.deepEqual(box.getEntries().map(entry => entry.type), ['middle', 'new']);
    await box.flush();
    assert.match(await readFile(join(dir, 'blackbox.jsonl'), 'utf8'), /"new"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('blackbox rotates a mirror larger than 2 MB', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-blackbox-'));
  try {
    await writeFile(join(dir, 'blackbox.jsonl'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const box = new Blackbox({ userData: dir });
    box.record('after-rotation');
    await box.flush();
    assert.equal((await stat(join(dir, 'blackbox.jsonl.previous'))).isFile(), true);
    assert.match(await readFile(join(dir, 'blackbox.jsonl'), 'utf8'), /after-rotation/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('blackbox keeps the exact count at the age boundary and defaults cap at 2000', () => {
  let now = Date.now();
  const box = new Blackbox({ now: () => now, maxAge: 100 });
  box.record('boundary');
  now += 100;
  assert.equal(box.getEntries().length, 1);
  const capped = new Blackbox({ now: () => 1_000_000 });
  for (let i = 0; i < 2001; i += 1) capped.record('entry', { i }, 1_000_000 + i);
  assert.equal(capped.getEntries().length, 2000);
});

test('blackbox surfaces mirror write errors', async () => {
  const errors = [];
  const box = new Blackbox({ file: join(process.cwd(), 'package.json', 'x'), onError: error => errors.push(error) });
  box.record('event');
  await box.flush();
  assert.equal(errors.length, 1);
});

test('default age expires idle entries after fifteen minutes and snapshots are detached', () => {
  let now = 1_000_000;
  const box = new Blackbox({ now: () => now });
  box.add('player', { state: { src: 'one' } });
  const saved = box.snapshot();
  saved[0].state.src = 'changed';
  now += 15 * 60 * 1000;
  assert.equal(box.snapshot()[0].state.src, 'one');
  now++;
  assert.deepEqual(box.snapshot(), []);
});

test('crossing the mirror limit rotates and replaces the single previous file', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-blackbox-'));
  try {
    const file = join(dir, 'blackbox.jsonl');
    await writeFile(`${file}.previous`, 'older');
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024 - 1));
    const box = new Blackbox({ file });
    box.add('crossed'); await box.flush();
    assert.equal((await stat(`${file}.previous`)).size, 2 * 1024 * 1024 - 1);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).type, 'crossed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
