import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { appendReportNote, writeReport } from './report.js';

test('report writer freezes state and appends note atomically', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-report-'));
  try {
    const channel = { current: 'one' };
    const pending = writeReport({ userData: dir, at: '2026-01-02T03:04:05.000Z', source: 'button',
      note: '', channel, settings: { x: 1 }, recentHistory: [1, 2], blackbox: [{ type: 'x' }], screenshot: Buffer.from('png') });
    channel.current = 'changed';
    const folder = await pending;
    const before = JSON.parse(await readFile(join(folder, 'report.json')));
    assert.equal(before.channel.current, 'one');
    await appendReportNote(folder, 'broken', '2026-01-02T03:05:06.000Z');
    const after = JSON.parse(await readFile(join(folder, 'report.json')));
    assert.equal(after.note, 'broken');
    assert.equal(after.noteAt, '2026-01-02T03:05:06.000Z');
    await access(join(folder, 'blackbox.json'));
    await access(join(folder, 'window.png'));
    const second = await writeReport({ userData: dir, at: '2026-01-02T03:04:05.000Z', source: 'button' });
    assert.match(second, /2026-01-02T03-04-05-2$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('expanded writer preserves the supplied report and freezes blackbox and image before IO', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-report-'));
  try {
    const report = {at:'2026-01-02T03:04:05Z',source:'menu',app:{version:'1'},settings:{stored:true},
      channel:{current:{src:'one'}},recentHistory:Array.from({length:25},(_,i)=>i)};
    const blackbox = [{type:'state',path:'/a'}], screenshot = Buffer.from('png');
    const pending = writeReport({userData:dir,report,blackbox,screenshot});
    report.channel.current.src='two'; blackbox[0].path='/b'; screenshot.fill(0);
    const folder=await pending, saved=JSON.parse(await readFile(join(folder,'report.json')));
    assert.equal(saved.channel.current.src,'one');
    assert.deepEqual(saved.app,{version:'1'}); assert.deepEqual(saved.settings,{stored:true});
    assert.equal(saved.at,'2026-01-02T03:04:05.000Z');
    assert.deepEqual(saved.recentHistory,Array.from({length:20},(_,i)=>i));
    assert.equal(JSON.parse(await readFile(join(folder,'blackbox.json')))[0].path,'/a');
    assert.equal(await readFile(join(folder,'window.png'),'utf8'),'png');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
