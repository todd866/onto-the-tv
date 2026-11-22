// Screenshot a screen after a sequence of remote presses (headless, 1920x1080), with the focused tile's box and
// its clipping ancestors printed. For looking at what check-tv-reach.mjs reports.
//   node scripts/shot-tv-focus.mjs <profile> <out.png> [keys: L R U D O B, e.g. DDR]
import { launch, installFixture, profileInit, pressKey, KEYS } from './tv-fixture.mjs';
const [profile = 'kid2', out = '/tmp/otv-focus.png', keys = ''] = process.argv.slice(2);
const MAP = { L: KEYS.LEFT, R: KEYS.RIGHT, U: KEYS.UP, D: KEYS.DOWN, O: KEYS.OK, B: KEYS.BACK };
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(profileInit(profile), { profile });
  await installFixture(page);
  await page.emulateMedia({ colorScheme: process.env.TV_SCHEME === 'light' ? 'light' : 'dark' });
  await page.goto('http://tv.test/');
  await page.waitForTimeout(1200);
  for (const k of keys) { await pressKey(page, MAP[k]); await page.waitForTimeout(250); }
  await page.waitForTimeout(500);
  console.log(await page.evaluate(() => {
    var f = document.querySelector('.focused'); if (!f) return 'nothing focused';
    var r = f.getBoundingClientRect(), out = [f.className + ' ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',')];
    for (var p = f.parentElement; p; p = p.parentElement) {
      var s = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(s.overflow + s.overflowX + s.overflowY)) { var a = p.getBoundingClientRect(); out.push('  in ' + (p.id || p.className) + ' ' + s.overflowX + '/' + s.overflowY + ' ' + [a.left, a.top, a.right, a.bottom].map(Math.round).join(',')); }
    }
    return out.join('\n');
  }));
  await page.screenshot({ path: out });
} finally { await browser.close(); }
