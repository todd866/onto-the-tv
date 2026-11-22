import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./pair.js', import.meta.url), 'utf8');
function load() {
  const window = {};
  vm.runInNewContext(source, { window, document: { getElementById: () => null }, location: { search: '' } });
  return window.ontoPairNext;
}

test('pairing returns only to a path on this server', () => {
  const next = load();
  assert.equal(next('?next=%2F%3Fviewers%3Dx'), '/?viewers=x');
  assert.equal(next('?next=%2Fgames%2F'), '/games/');
  assert.equal(next(''), '/');
  for (const evil of ['//evil.com', '/\\evil.com', '/%5Cevil.com', '%2F%2Fevil.com', 'https%3A%2F%2Fevil.com', '%2F%5Cevil.com',
    '/%09/evil.com', '%2F%0A%2Fevil.com', 'javascript:alert(1)', '%E0%A4%A', '/pair.html', '%2Fpair.html%3Fnext%3D%2F%2Fevil.com']) {
    assert.equal(next('?next=' + evil.replace(/\\/g, '\\')), '/', evil);
  }
});
