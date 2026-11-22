import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTaste, createTasteWriter } from './taste.js';
const profiles = () => Object.fromEntries(['grown','mum','dad','both'].map(id => [id,{weights:{'Show/episode.mp4':1},bookmarks:{}}]));
test('taste export rejects invalid values and discards unrelated fields', () => {
  const input=profiles(); input.path='/unrelated';
  assert.equal(validateTaste(input).path,undefined);
  for (const bad of [NaN,Infinity,-1,5,'1']) {
    input.dad.weights['Show/episode.mp4']=bad;
    assert.throws(() => validateTaste(input));
  }
  const bookmark=profiles(); bookmark.mum.bookmarks.a={time:-1,saved:true,updated:0};
  assert.throws(() => validateTaste(bookmark));
});
test('taste snapshots write privately and retain the newest update', async () => {
  const folder=await mkdtemp(join(tmpdir(),'onto-taste-'));
  try {
    const write=createTasteWriter(folder), first=profiles(), second=profiles(); second.both.weights['Show/episode.mp4']=1.3;
    await Promise.all([write(first),write(second)]);
    const path=join(folder,'taste.json');
    assert.equal(JSON.parse(await readFile(path,'utf8')).profiles.both.weights['Show/episode.mp4'],1.3);
    assert.equal((await stat(path)).mode & 0o777,0o600);
  } finally { await rm(folder,{recursive:true,force:true}); }
});
