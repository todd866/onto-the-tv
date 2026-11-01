import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('number snake wasm draws the first round', async () => {
  const wasm = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../tv/games/number-snake.wasm'));
  const { instance } = await WebAssembly.instantiate(wasm);
  const api = instance.exports;
  api.game_new(9);
  api.game_tick(250);
  const len = api.draw_len();
  assert.equal(len % 8, 0);
  const cmds = new Float32Array(api.memory.buffer, api.draw_ptr(), len);
  assert.equal(cmds[0], 0, 'first command clears the 1920×1080 board');
  assert.equal(cmds[3], 1920);
  assert.equal(cmds[4], 1080);
  let numbers = 0;
  let progress = 0;
  for (let i = 0; i < cmds.length; i += 8) {
    if (cmds[i] === 3) numbers += 1;
    if (cmds[i] === 4) progress += 1;
  }
  assert.equal(numbers, 10);
  assert.equal(progress, 10);
});
