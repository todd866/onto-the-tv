import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, loadShowSpace, canonSlug, christmasAffinity, showAffinity } from './show-space.js';

const SPACE = {
  'rudolph-the-red-nosed-reindeer-tv-special': { name: 'Rudolph the Red-Nosed Reindeer', kind: 'special', next: [['frosty-the-snowman-tv-special', 0.8], ['the-year-without-a-santa-claus', 0.7]] },
  'frosty-the-snowman-tv-special': { name: 'Frosty the Snowman', kind: 'special', next: [['rudolph-the-red-nosed-reindeer-tv-special', 0.8]] },
  'the-year-without-a-santa-claus': { name: 'The Year Without a Santa Claus', kind: 'special', next: [] },
  'bad-santa': { name: 'Bad Santa', kind: 'film', next: [['die-hard-2', 0.72]] },
  'white-christmas-film': { name: 'White Christmas', kind: 'film', next: [] }
};

test('slugify matches the meta harvester (year stripped, punctuation folded)', () => {
  assert.equal(slugify('Rudolph the Red-Nosed Reindeer (1964)'), 'rudolph-the-red-nosed-reindeer');
  assert.equal(slugify("Santa Claus Is Comin' to Town (1970)"), 'santa-claus-is-comin-to-town');
  assert.equal(slugify('Bad Santa (2003)'), 'bad-santa');
});

test('loadShowSpace tolerates a missing file and broken JSON', () => {
  assert.equal(loadShowSpace('/nonexistent/show-space.json'), null);
});

test('canonSlug resolves the harvester disambiguator suffixes', () => {
  const space = loadShowSpace.from(SPACE);
  assert.equal(canonSlug(space, 'White Christmas (1954)'), 'white-christmas-film');
  assert.equal(canonSlug(space, 'Frosty the Snowman (1969)'), 'frosty-the-snowman-tv-special');
  assert.equal(canonSlug(space, 'Timmy Time'), null);
});

test('christmasAffinity rewards canon neighbours of what was just watched', () => {
  const space = loadShowSpace.from(SPACE);
  // Frosty is Rudolph's nearest canon neighbour: above neutral, bounded.
  const frosty = christmasAffinity(space, 'Frosty the Snowman (1969)', ['Rudolph the Red-Nosed Reindeer (1964)']);
  assert.ok(frosty > 1 && frosty <= 1.6, `frosty affinity ${frosty}`);
  // Unrelated canon entry: neutral.
  assert.equal(christmasAffinity(space, 'The Year Without a Santa Claus (1974)', ['Rudolph the Red-Nosed Reindeer (1964)']), 1);
  // Unknown title: neutral, never penalised.
  assert.equal(christmasAffinity(space, 'Timmy Time', ['Rudolph the Red-Nosed Reindeer (1964)']), 1);
  // No recent history: neutral.
  assert.equal(christmasAffinity(space, 'Frosty the Snowman (1969)', []), 1);
});

test('showAffinity lifts symmetric canon neighbours for Down directions and channel picks', () => {
  const space = loadShowSpace.from(SPACE);
  const yearWithoutSanta = showAffinity(space, 'The Year Without a Santa Claus (1974)', ['Rudolph the Red-Nosed Reindeer (1964)']);
  assert.ok(yearWithoutSanta > 1 && yearWithoutSanta <= 1.6);
  assert.equal(showAffinity(space, 'Frosty the Snowman (1969)', ['Frosty the Snowman (1969)']), 1);
  assert.equal(showAffinity(space, 'Timmy Time', ['Frosty the Snowman (1969)']), 1);
});
