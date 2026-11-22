// Every tile on every screen can be reached with the arrow keys alone, is fully on screen when focused, and Back
// returns to the tile you left from. Owner, 22 Nov 2026: "I literally couldn't navigate to certain tiles".
// From each screen's start, a breadth-first walk over ◀ ▶ ▲ ▼ visits every focus state it can reach; any button
// rendered on that screen in any visited state that never takes focus is unreachable. Headless, 1920x1080.
//   node scripts/check-tv-reach.mjs            (synthetic household; OTV_CACHE replays recorded real data)
//   TV_REACH_ONLY=home:older  TV_REACH_MAX=400  TV_ROOT=<other tv/>
import assert from 'node:assert/strict';
import { launch, installFixture, profileInit, pressKey, KEYS } from './tv-fixture.mjs';

const MAX = Number(process.env.TV_REACH_MAX || 260);
const ONLY = process.env.TV_REACH_ONLY || '';
const ARROWS = [['◀', KEYS.LEFT, KEYS.RIGHT], ['▶', KEYS.RIGHT, KEYS.LEFT], ['▲', KEYS.UP, KEYS.DOWN], ['▼', KEYS.DOWN, KEYS.UP]];

// The screen's state as the page sees it: which screen, the focused button, every rendered button there, scroll.
function snapshot() {
  function screen() {
    var lib = document.getElementById('library');
    if (lib && !lib.hidden) return lib;
    var player = document.getElementById('player');
    if (player && !player.hidden) return player;
    return document.getElementById('home');
  }
  function visible(el) {
    if (!el.getClientRects().length) return false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
    for (var p = el; p; p = p.parentElement) if (p.hidden || getComputedStyle(p).display === 'none' || +getComputedStyle(p).opacity === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }
  var counts = {};
  function id(el) {
    var label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    var cls = (el.className || '').toString().split(' ').filter(function (c) { return c && c !== 'focused' && c !== 'on'; })[0] || el.id || '';
    var key = cls + ':' + label;
    return key;
  }
  var root = screen(), buttons = root.querySelectorAll('button'), all = [], i, b, k;
  for (i = 0; i < buttons.length; i++) {
    b = buttons[i];
    if (!visible(b)) continue;
    k = id(b);
    counts[k] = (counts[k] || 0) + 1;
    all.push(counts[k] > 1 ? k + '#' + counts[k] : k);
  }
  var focusedEls = root.querySelectorAll('.focused'), focused = null, box = null, clipped = '';
  for (i = 0; i < focusedEls.length; i++) if (visible(focusedEls[i])) { focused = focusedEls[i]; break; }
  if (focused && focused.tagName !== 'BUTTON') { var inner = focused.querySelector('button'); if (inner) focused = inner; }
  var fid = null;
  if (focused) {
    var n = 0, list = root.querySelectorAll('button');
    var mine = id(focused);
    for (i = 0; i < list.length; i++) { if (!visible(list[i])) continue; if (id(list[i]) === mine) n++; if (list[i] === focused) break; }
    fid = n > 1 ? mine + '#' + n : mine;
    // What the tile is, beyond its label: a channel keeps its id, an episode its file, wherever it moves to.
    var it = focused._entry || focused._card || (focused._item && (focused._item._resumeEntry || focused._item)) || focused._show;
    var what = it ? (it.src || (it.id ? 'ch:' + it.id : '') || it.title || '') : '';
    var r = focused.getBoundingClientRect();
    box = [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) clipped = 'off screen ' + box.join(',');
    for (var p = focused.parentElement; p && !clipped; p = p.parentElement) {
      var s = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(s.overflow + s.overflowX + s.overflowY) && p.clientHeight > 0) {
        var a = p.getBoundingClientRect();
        if (r.left < a.left - 1 || r.right > a.right + 1 || r.top < a.top - 1 || r.bottom > a.bottom + 1) clipped = 'clipped by ' + (p.id || p.className) + ' ' + box.join(',');
      }
    }
  }
  var scrolls = [];
  root.querySelectorAll('*').forEach(function (el) { if (el.scrollTop || el.scrollLeft) scrolls.push((el.id || el.className) + '@' + el.scrollLeft + ',' + el.scrollTop); });
  var pager = document.getElementById('now-pager');
  return { screen: root.id, focused: fid, what: typeof what === 'string' ? what : '', clipped: clipped, all: all, key: root.id + '|' + fid + '|' + (pager && !pager.hidden ? pager.textContent : ''), scrolls: scrolls.join(';') };
}

// Max's rail: ◀ from the first column opens it on Home; ▲ / ▼ pick a section, OK opens it.
function rail(moves) {
  return async page => {
    await pressKey(page, KEYS.DOWN); await page.waitForTimeout(120);
    await pressKey(page, KEYS.DOWN); await page.waitForTimeout(120);
    await pressKey(page, KEYS.LEFT); await page.waitForTimeout(150);
    for (const m of moves) { await pressKey(page, m); await page.waitForTimeout(120); }
    await pressKey(page, KEYS.OK); await page.waitForTimeout(600);
  };
}
const SCREENS = [
  { name: 'home:all', profile: 'all' },
  { name: 'home:adult1', profile: 'adult1' },
  { name: 'home:adult2', profile: 'adult2' },
  { name: 'home:kid1', profile: 'kid1' },
  { name: 'home:kid2', profile: 'kid2' },
  { name: 'tube:creators', profile: 'kid2', enter: rail([KEYS.DOWN]) },
  { name: 'tube:library', profile: 'kid2', enter: rail([KEYS.DOWN, KEYS.DOWN]) },
  { name: 'tube:search', profile: 'kid2', enter: rail([KEYS.UP]) },
  { name: 'library', profile: 'all', enter: async page => { await page.evaluate(() => window.ontoLibrary.open({ from: 'home' })); await page.waitForTimeout(500); } },
  { name: 'library:shows', profile: 'all', enter: async page => {
    await page.evaluate(() => window.ontoLibrary.open({ from: 'home' })); await page.waitForTimeout(500);
    await page.evaluate(() => { var b = document.querySelectorAll('#library-modes button'); for (var i = 0; i < b.length; i++) if (/show/i.test(b[i].textContent)) b[i].click(); });
    await page.waitForTimeout(300);
  } },
  { name: 'library:episodes', profile: 'all', enter: async page => {
    await page.evaluate(() => window.ontoLibrary.open({ from: 'home' })); await page.waitForTimeout(500);
    await page.evaluate(() => { var b = document.querySelectorAll('#library-modes button'); for (var i = 0; i < b.length; i++) if (/show/i.test(b[i].textContent)) b[i].click(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { var c = document.querySelectorAll('#library-body button'); if (c[2]) c[2].click(); });
    await page.waitForTimeout(300);
  } },
  { name: 'player', profile: 'all', noBack: true, enter: async page => {
    await pressKey(page, KEYS.DOWN); await page.waitForTimeout(150);
    for (let i = 0; i < 8; i++) { // the first real channel on the cards (the Continue tiles come first)
      const isChannel = await page.evaluate(() => { var f = document.querySelector('#channels .focused'); return !!(f && f._item && !f._item.app); });
      if (isChannel) break;
      await pressKey(page, KEYS.RIGHT); await page.waitForTimeout(120);
    }
    await pressKey(page, KEYS.OK); await page.waitForTimeout(1200);
    await pressKey(page, KEYS.UP); await page.waitForTimeout(400); // controls open, focus on play / pause
  } },
];

const browser = await launch();
const failures = [];
try {
  for (const screen of SCREENS) {
    if (ONLY && screen.name !== ONLY) continue;
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(profileInit(screen.profile), { profile: screen.profile });
    await installFixture(page);
    async function start() {
      await page.goto('http://tv.test/');
      await page.waitForFunction(() => document.querySelector('.focused'), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(150);
      if (await page.locator('#picker:visible').count()) { await pressKey(page, KEYS.OK); await page.waitForTimeout(300); }
      if (screen.enter) await screen.enter(page);
      return page.evaluate(snapshot);
    }
    async function press(code) { await pressKey(page, code); await page.waitForTimeout(90); return page.evaluate(snapshot); }
    async function replay(path) { let s = await start(); for (const step of path) s = await press(step[1]); return s; }

    const first = await start();
    const seen = new Map([[first.key, { path: [], snap: first }]]);
    const focusedSet = new Set(), rendered = new Map(), clipped = new Map(), leaks = new Set();
    function note(s, path) {
      if (s.screen !== first.screen) { leaks.add(s.screen + ' via ' + path.map(p => p[0]).join('')); return false; }
      if (s.focused) focusedSet.add(s.focused); else leaks.add('nothing focused via ' + (path.map(p => p[0]).join('') || 'start'));
      for (const b of s.all) if (!rendered.has(b)) rendered.set(b, path);
      if (s.clipped && s.focused && !clipped.has(s.focused)) clipped.set(s.focused, s.clipped + ' via ' + path.map(p => p[0]).join(''));
      return true;
    }
    note(first, []);
    // Explore every arrow from every state. To get to the next state, walk the transitions already seen from where
    // the page is now; reload and replay the first path only when that walk does not land where it should.
    const queue = [first.key], edges = new Map();
    let current = first, replays = 0, drift = 0;
    function route(from, to) {
      const prev = new Map([[from, null]]), q = [from];
      while (q.length) {
        const k = q.shift();
        if (k === to) break;
        for (const [code, next] of edges.get(k) || []) if (!prev.has(next)) { prev.set(next, [k, code]); q.push(next); }
      }
      if (!prev.has(to)) return null;
      const steps = [];
      for (let k = to; prev.get(k); k = prev.get(k)[0]) steps.unshift(prev.get(k)[1]);
      return steps;
    }
    async function goTo(key) {
      if (current.key === key) return;
      const steps = route(current.key, key);
      if (steps && steps.length <= 12) {
        for (const code of steps) { current = await press(code); }
        if (current.key === key) return;
        if (process.env.TV_REACH_DEBUG) console.log('   walk missed: wanted ' + key.slice(0, 90) + '\n                got    ' + current.key.slice(0, 90));
      }
      current = await replay(seen.get(key).path); replays++;
    }
    while (queue.length && seen.size < MAX) {
      const key = queue.shift(), node = seen.get(key);
      await goTo(key);
      if (current.key !== key) { drift++; continue; } // not deterministic from here; skip
      if (process.env.TV_REACH_DEBUG && seen.size % 10 === 0) console.log('  … ' + seen.size + ' states, ' + replays + ' replays, ' + queue.length + ' queued');
      for (const [glyph, code, inverse] of ARROWS) {
        await goTo(key);
        if (current.key !== key) break;
        const next = await press(code);
        if (!edges.has(key)) edges.set(key, new Map());
        edges.get(key).set(code, next.key);
        current = next;
        const path = node.path.concat([[glyph, code]]);
        if (!seen.has(next.key)) {
          seen.set(next.key, { path, snap: next });
          if (note(next, path)) queue.push(next.key);
        }
        if (next.key !== key && next.screen === first.screen) { // step back too: it gives the new state a known way out
          const back = await press(inverse);
          if (!edges.has(next.key)) edges.set(next.key, new Map());
          edges.get(next.key).set(inverse, back.key);
          current = back;
        }
      }
    }
    // Back returns to the tile you left from: OK on a tile that opens something (a show, a picture), then Back.
    const backFails = [];
    if (!screen.noBack) {
      const SKIP = /^(viewer|lib-mode|tube-chip|tube-key|tube-rail-btn|tube-suggestion|tube-avatar-btn|profile|seg|osd|opt|tube-next|resume-)/;
      const tried = new Set();
      const candidates = [...seen.entries()].filter(([, n]) => n.snap.focused && !SKIP.test(n.snap.focused) && n.snap.screen === first.screen);
      const step = Math.max(1, Math.ceil(candidates.length / 10));
      for (let i = 0; i < candidates.length; i += step) {
        const [key, n] = candidates[i];
        if (tried.has(n.snap.focused)) continue;
        tried.add(n.snap.focused);
        await goTo(key);
        if (current.key !== key) continue;
        await pressKey(page, KEYS.OK); await page.waitForTimeout(1300);
        const opened = await page.evaluate(snapshot);
        if (opened.key === key) continue; // OK changed nothing here
        await pressKey(page, KEYS.BACK); await page.waitForTimeout(1300);
        const back = await page.evaluate(snapshot);
        const same = n.snap.what ? back.what === n.snap.what : back.focused === n.snap.focused;
        if (!same || back.screen !== first.screen) backFails.push(n.snap.focused + ' → OK → ' + opened.screen + ' → Back → ' + back.screen + ' ' + back.focused);
        current = await replay([]); replays++;
      }
    }
    if (process.env.TV_REACH_DEBUG) for (const k of seen.keys()) console.log('   key ' + k.slice(0, 220));
    const unreachable = [...rendered.keys()].filter(b => !focusedSet.has(b));
    const line = screen.name.padEnd(17) + ' states ' + String(seen.size).padStart(3) + (seen.size >= MAX ? '+' : ' ') + '  buttons ' + String(rendered.size).padStart(3) + '  reached ' + String(focusedSet.size).padStart(3) + '  (' + replays + ' replays' + (drift ? ', ' + drift + ' not replayable' : '') + ')';
    console.log(line + (unreachable.length ? '  UNREACHABLE ' + unreachable.length : '') + (clipped.size ? '  CLIPPED ' + clipped.size : '') + (leaks.size ? '  LEAKS ' + leaks.size : ''));
    for (const u of unreachable.slice(0, 25)) console.log('    unreachable  ' + u + '   (rendered after ' + (rendered.get(u).map(p => p[0]).join('') || 'start') + ')');
    for (const [f, why] of [...clipped].slice(0, 15)) console.log('    clipped      ' + f + '  ' + why);
    for (const l of [...leaks].slice(0, 8)) console.log('    leaves       ' + l);
    for (const b of backFails) console.log('    back lost    ' + b);
    if (backFails.length) failures.push(screen.name + ': Back lost the tile ' + backFails.length + 'x');
    if (errors.length) console.log('    page errors  ' + JSON.stringify(errors.slice(0, 3)));
    if (unreachable.length) failures.push(screen.name + ': ' + unreachable.length + ' unreachable');
    if (clipped.size) failures.push(screen.name + ': ' + clipped.size + ' focused partly off screen');
    if (errors.length) failures.push(screen.name + ': page errors');
    await context.close();
  }
} finally {
  await browser.close();
}
if (process.env.TV_ENFORCE !== '0') assert.deepEqual(failures, [], failures.join('\n'));
