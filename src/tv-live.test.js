import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { liveManifest, parsePage } from './tv-live.js';

test('the page is read as body markup, stylesheets and scripts, in order, without the pairing config', () => {
  const page = parsePage(`<html><head><link rel="stylesheet" href="a.css"><link id="x" rel="stylesheet" href="b.css">
    <link rel="icon" href="icon.png"></head><body><main id="home"></main>
    <script src="config.js"></script><script src="one.js"></script><script src="two.js"></script>
    <script src="http://elsewhere.test/evil.js"></script><script>inline()</script></body></html>`);
  assert.deepEqual(page.styles, [{ href: 'a.css', id: '' }, { href: 'b.css', id: 'x' }]);
  assert.deepEqual(page.scripts, ['one.js', 'two.js']);
  assert.equal(page.body, '<main id="home"></main>');
});

test('the real interface yields a manifest whose build changes with its files', async () => {
  const manifest = await liveManifest(fileURLToPath(new URL('../tv/', import.meta.url)));
  assert.match(manifest.build, /^live-[0-9a-f]{12}$/);
  assert.ok(manifest.scripts.includes('app.js') && manifest.scripts.includes('remote-map.js') && manifest.scripts.includes('remote-guide.js'));
  assert.ok(!manifest.scripts.includes('config.js') && !manifest.scripts.includes('boot.js'));
  assert.ok(manifest.scripts.indexOf('remote-map.js') < manifest.scripts.indexOf('app.js'), 'app.js loads after what it needs');
  assert.ok(manifest.styles.some(style => style.href === 'styles.css'));
  assert.ok(manifest.body.includes('id="osd-like"') && !/<script/i.test(manifest.body));
});
