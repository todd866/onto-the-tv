import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ambientAnimationGraph, buildAmbientVideo } from './ambient-video.js';

const slides = [
  { kind:'weather', title:'Cottesloe' },
  { kind:'photo', title:'Family beach' },
  { kind:'news', title:'A useful headline' },
];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'onto-ambient-test-'));
  const calls = [];
  const execute = async (_command, args) => {
    calls.push(args);
    await writeFile(args.at(-1), Buffer.from('mp4'));
  };
  const capture = async frames => frames.map((_, index) => Buffer.from(`png-${index}`));
  return { directory, calls, execute, capture };
}

async function childNames(directory) { return (await readdir(directory)).filter(name => name.startsWith('onto-ambient-')); }

test('builds a 24fps looping video and cleanup removes the retained playable file', async () => {
  const f = await fixture();
  try {
    const built = await buildAmbientVideo({ slides, pace:20, seconds:45, directory:f.directory, capture:f.capture, execute:f.execute });
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[0].includes('-framerate') && f.calls[0].includes('24'));
    assert.equal(f.calls[0].at(-1).endsWith('cycle.mp4'), true);
    assert.equal(f.calls[1].at(-1).endsWith('Screensaver.mp4'), true);
    assert.equal((await stat(built.path)).isFile(), true);
    const graph = f.calls[0][f.calls[0].indexOf('-filter_complex') + 1];
    assert.match(graph, /xfade=transition=fade/);
    assert.match(graph, /trim=start=2:duration=60/);
    assert.match(graph, /fps=24/);
    await built.cleanup();
    assert.deepEqual(await childNames(f.directory), []);
  } finally { await rm(f.directory, { recursive:true, force:true }); }
});

for (const [name, failAt] of [['capture failure', 'capture'], ['first encode failure', 0], ['repeat encode failure', 1]]) {
  test(`cleans temporary files after ${name}`, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      const capture = async (...args) => { if (failAt === 'capture') throw new Error('capture failed'); return f.capture(...args); };
      const execute = async (...args) => { if (calls++ === failAt) throw new Error('encode failed'); return f.execute(...args); };
      await assert.rejects(buildAmbientVideo({ slides, directory:f.directory, capture, execute }), /(?:capture|encode) failed/);
      assert.deepEqual(await childNames(f.directory), []);
    } finally { await rm(f.directory, { recursive:true, force:true }); }
  });
}

test('abort during capture cleans the work directory and propagates the abort', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const capture = async (_slides, signal) => { controller.abort(); signal.throwIfAborted(); return []; };
    await assert.rejects(buildAmbientVideo({ slides, directory:f.directory, capture, execute:f.execute, signal:controller.signal }), error => error.name === 'AbortError');
    assert.deepEqual(await childNames(f.directory), []);
  } finally { await rm(f.directory, { recursive:true, force:true }); }
});

test('animation graph feeds a repeated first frame for a continuous transition loop', () => {
  const graph = ambientAnimationGraph(slides, 10);
  assert.equal((graph.match(/xfade=transition=fade/g) || []).length, slides.length);
  assert.match(graph, /\[3:v\]/);
  assert.match(graph, /\[mix3\]trim=start=2:duration=30/);
  assert.match(graph, /zoompan=.*fps=24/);
});

test('a slide that failed to render is left out without shifting the others', async () => {
  const f = await fixture();
  try {
    const capture = async frames => frames.map((_, index) => index === 1 ? null : Buffer.from(`png-${index}`));
    let contents;
    const execute = async (command, args) => {
      if (!contents) contents = await Promise.all(args.filter((_, i) => args[i - 1] === '-i' && args[i].endsWith('.png'))
        .map(path => readFile(path, 'utf8')));
      return f.execute(command, args);
    };
    const built = await buildAmbientVideo({ slides, pace:20, seconds:45, directory:f.directory, capture, execute });
    assert.deepEqual(contents, ['png-0', 'png-2', 'png-0']);
    await built.cleanup();
  } finally { await rm(f.directory, { recursive:true, force:true }); }
});
