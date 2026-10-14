import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmbientCapture } from './ambient-capture.js';

function fakeWindow(failingTitles) {
  return class {
    constructor() {
      this.destroyed = false;
      let current;
      this.webContents = {
        setWindowOpenHandler() {}, on() {},
        session: { setPermissionRequestHandler() {} },
        async executeJavaScript(code) {
          current = JSON.parse(code.slice(code.indexOf('(') + 1, code.lastIndexOf(')'))).title;
          if (failingTitles.includes(current)) throw new Error('image could not be decoded');
        },
        async capturePage() { return { isEmpty: () => false, toPNG: () => Buffer.from(current) }; },
      };
    }
    async loadURL() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  };
}

const slides = [{ title: 'one' }, { title: 'broken' }, { title: 'three' }];

test('one slide that cannot render is skipped and the rest still capture', async () => {
  const capture = createAmbientCapture({ BrowserWindow: fakeWindow(['broken']), appRoot: '/app' });
  const frames = await capture(slides);
  assert.deepEqual(frames.map(frame => frame?.toString() ?? null), ['one', null, 'three']);
});

test('capture fails when no slide can render', async () => {
  const capture = createAmbientCapture({ BrowserWindow: fakeWindow(['one', 'broken', 'three']), appRoot: '/app' });
  await assert.rejects(capture(slides), /image could not be decoded/);
});
