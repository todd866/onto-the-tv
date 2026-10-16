import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReportService } from './report-service.js';

const root = process.cwd();

test('service button requests the player snapshot frozen at the trigger', async () => {
  const dir = await mkdtemp(join(root, '.tmp-report-service-'));
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ tvHost: '192.0.2.3', custom: true }));
    const sent = [];
    const service = createReportService({ userData: dir, appRoot: root, send: (...args) => sent.push(args),
      snapshot: () => ({ errors: [], blackbox: [] }), capturePage: async () => Buffer.from('png') });
    const pending = service.capture('button', { reportId: 'press-1', mode: 'local' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[0][1].reportId, 'press-1');
    service.state({requestId:sent[0][1].requestId,mode:'local',channel:{src:'x'}});
    const folder = await pending;
    const report = JSON.parse(await readFile(join(folder, 'report.json')));
    assert.equal(report.channel.src, 'x');
    assert.equal(report.settings.tvHost, '192.0.2.3');
    assert.equal(report.app.version, JSON.parse(await readFile(join(root, 'package.json'))).version);
    assert.equal(typeof report.app.commit, 'string');
    assert.equal(sent.at(-1)[0], 'report:saved');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('service menu requests player state and accepts request id response', async () => {
  const dir = await mkdtemp(join(root, '.tmp-report-service-'));
  try {
    await writeFile(join(dir, 'settings.json'), '{}');
    const sent = [];
    const service = createReportService({ userData: dir, appRoot: root, send: (...args) => sent.push(args),
      snapshot: () => ({ errors: [], blackbox: [] }), capturePage: async () => Buffer.from('png') });
    const pending = service.capture('menu');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[0][0], 'report:state');
    service.state({ requestId: sent[0][1].requestId, mode: 'channel', channel: { src: 'from-player' } });
    const folder = await pending;
    assert.equal(JSON.parse(await readFile(join(folder, 'report.json'))).channel.src, 'from-player');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('service rejects notes for folders it did not save', async () => {
  const dir = await mkdtemp(join(root, '.tmp-report-service-'));
  try {
    const service = createReportService({ userData: dir, appRoot: root, send() {},
      snapshot: () => ({ errors: [], blackbox: [] }), capturePage: async () => Buffer.from('png') });
    assert.throws(() => service.note(join(dir, 'reports', 'unknown'), 'nope'), /Invalid report note/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
