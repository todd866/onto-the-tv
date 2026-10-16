import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../bin/report.js';

test('CLI writes a report from on-disk user data', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-report-cli-'));
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ tvHost: '192.0.2.1' }));
    await writeFile(join(dir, 'playback-history.json'), JSON.stringify({ version: 1, entries: [
      { path: '/old', updatedAt: '2020-01-01T00:00:00Z' },
      { path: '/new', updatedAt: '2026-01-01T00:00:00Z' },
    ] }));
    const output = [];
    const oldLog = console.log;
    console.log = value => output.push(value);
    try { assert.equal(await main(['node', 'report', '--user-data', dir, 'TV stopped']), 0); }
    finally { console.log = oldLog; }
    const folder = output[0];
    const report = JSON.parse(await readFile(join(folder, 'report.json')));
    assert.equal(report.source, 'cli');
    assert.equal(report.note, 'TV stopped');
    assert.equal(report.tvState, null);
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'playback-history.json'))).entries.map(x => x.path), ['/new', '/old']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI uses environment user data, keeps twenty newest entries and both mirror files', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-report-cli-'));
  const previous = process.env.ONTO_USER_DATA;
  const oldLog = console.log, output = [];
  try {
    const entries = Array.from({length:25}, (_,i)=>({path:`/${i}`,updatedAt:new Date(i * 1000).toISOString()}));
    await writeFile(join(dir,'playback-history.json'), JSON.stringify({version:1,entries}));
    await writeFile(join(dir,'blackbox.jsonl'),'current\n');
    await writeFile(join(dir,'blackbox.jsonl.previous'),'previous\n');
    process.env.ONTO_USER_DATA = dir;
    console.log = value => output.push(value);
    assert.equal(await main(['node','report','chat complaint']),0);
    const report = JSON.parse(await readFile(join(output[0],'report.json')));
    assert.equal(report.recentHistory.length,20);
    assert.equal(report.recentHistory[0].path,'/24');
    assert.equal(report.recentHistory.at(-1).path,'/5');
    assert.equal(await readFile(join(output[0],'blackbox.jsonl'),'utf8'),'current\n');
    assert.equal(await readFile(join(output[0],'blackbox.jsonl.previous'),'utf8'),'previous\n');
    assert.match(output[0],/-cli$/);
  } finally {
    console.log = oldLog;
    if (previous === undefined) delete process.env.ONTO_USER_DATA;
    else process.env.ONTO_USER_DATA = previous;
    await rm(dir,{recursive:true,force:true});
  }
});
