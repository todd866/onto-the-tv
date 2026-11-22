import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateAudit, summarizeAudit, MAX_BUNDLE_BYTES } from './tv-audit.js';
import { main } from '../bin/tv-audit.js';
const fixturePath = new URL('../fixtures/tv-audit/synthetic-opt-out.json', import.meta.url);
const bytes = await readFile(fixturePath);
const fixture = () => JSON.parse(bytes);

test('synthetic opt-out report preserves claims and normalizes unequal windows', () => {
  const input = fixture(), original = structuredClone(input);
  const report = summarizeAudit(input), pair = report.comparisons[0];
  assert.equal(report.provenance, 'synthetic');
  assert.equal(pair.outcome, 'signal-observed-after-opt-out');
  assert.equal(pair.beforePerMinute, 12);
  assert.equal(pair.afterPerMinute, 3);
  assert.equal(report.observations.length, 1);
  assert.equal(report.hypotheses.length, 1);
  assert.deepEqual(report.reviewedFindings, []);
  assert.deepEqual(report.sessions, input.sessions);
  assert.deepEqual(input, original);
});

test('explicit zero differs from missing measurements', () => {
  const b = fixture();
  b.sessions[1].signals[0].count = 0;
  assert.equal(summarizeAudit(b).comparisons[0].outcome, 'signal-not-observed-in-window');
  b.sessions[1].signals = [];
  const p = summarizeAudit(b).comparisons[0];
  assert.equal(p.outcome, 'inconclusive');
  assert.equal(p.afterCount, null);
  assert.ok(p.blockers.includes('missing-signal-measurement'));
});

for (const [reason, mutate] of [
  ['phase-mismatch', b => b.sessions[1].phase = 'control'],
  ['context-mismatch', b => b.sessions[1].activity = 'streaming'],
  ['context-mismatch', b => b.sessions[1].context = 'different firmware'],
  ['unverified-setting-transition', b => b.sessions[1].settingVerified = false],
  ['unverified-setting-transition', b => b.sessions[1].setting = 'unknown'],
  ['incomplete-coverage', b => b.sessions[1].coverageComplete = false],
  ['overlapping-or-reversed-windows', b => b.sessions[1].startedAt = b.sessions[0].startedAt],
]) test(`inconclusive comparison: ${reason}`, () => {
  const b = fixture(); mutate(b);
  const pair = summarizeAudit(b).comparisons[0];
  assert.equal(pair.outcome, 'inconclusive'); assert.ok(pair.blockers.includes(reason));
});

for (const [name, mutate] of [
  ['schema version', b => b.version = 2],
  ['duplicate ids', b => b.evidence.push(b.evidence[0])],
  ['broken evidence reference', b => b.claims[0].evidenceIds = ['absent']],
  ['mixed provenance', b => b.evidence[0].provenance = 'real'],
  ['negative count', b => b.sessions[0].signals[0].count = -1],
  ['fractional count', b => b.sessions[0].signals[0].count = 1.2],
  ['zero duration', b => b.sessions[0].durationSeconds = 0],
  ['unrepresentable rate', b => b.sessions[0].durationSeconds = Number.MIN_VALUE],
  ['setting proof absent', b => b.sessions[0].evidenceIds = ['before-traffic']],
  ['bad hash', b => b.evidence[0].sha256 = 'bad'],
  ['signal evidence outside session', b => b.sessions[0].signals[0].evidenceIds = ['after-traffic']],
  ['duplicate signals', b => b.sessions[0].signals.push(b.sessions[0].signals[0])],
  ['finding without review', b => b.claims[1].status = 'finding'],
]) test(`rejects ${name}`, () => { const b = fixture(); mutate(b); assert.throws(() => validateAudit(b)); });

test('reviewed findings require more than traffic and retain limits', () => {
  const b = fixture(), c = b.claims[1];
  Object.assign(c, {status:'finding', reviewedBy:'Fixture reviewer', reviewedAt:'2026-10-25T11:00:00Z', method:'Compare synthetic settings records', evidenceIds:['after-traffic']});
  assert.throws(() => validateAudit(b), /traffic alone/);
  c.evidenceIds.push('after-setting');
  assert.equal(summarizeAudit(b).reviewedFindings[0].limitations, c.limitations);
});

test('CLI validates, fingerprints, writes privately and refuses overwrite; no evidence resolution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-audit-'));
  const logs = [], errors = [], io = {log: s => logs.push(s), error:s => errors.push(s)};
  try {
    const source = join(dir, 'bundle.json'), dest = join(dir, 'report.json');
    const b = fixture(); b.evidence[0].source = '/does-not-exist/private-capture.pcap';
    b.references.push({id:'candidate',title:'Unverified candidate',url:'https://example.invalid/tool',notes:'Reference only; no execution.'});
    const content = JSON.stringify(b); await writeFile(source, content);
    assert.equal(await main(['validate', source], io), 0);
    assert.equal(await main(['report', source, dest], io), 0);
    const saved = await readFile(dest, 'utf8');
    assert.equal(JSON.parse(saved).bundleSha256, createHash('sha256').update(content).digest('hex'));
    assert.equal((await stat(dest)).mode & 0o777, 0o600);
    assert.equal(await main(['report', source, dest], io), 1);
    assert.equal(await readFile(dest, 'utf8'), saved);
    assert.equal(await main(['report', source, source], io), 1);
    assert.equal(await readFile(source, 'utf8'), content);
    assert.equal(await main(['report', source], io), 0);
    assert.equal(JSON.parse(logs.at(-1)).provenance, 'synthetic');
    assert.equal(await main(['validate', source, 'extra'], io), 2);
    await writeFile(source, '{bad json');
    assert.equal(await main(['validate', source], io), 1);
    await writeFile(source, Buffer.alloc(MAX_BUNDLE_BYTES + 1));
    assert.equal(await main(['validate', source], io), 1);
    assert.match(errors.at(-1), /2 MiB/);
    assert.equal(await main(['--help'], io), 0);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
