import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestOf, showQuery } from './best-episodes.mjs';

test('show names lose their year for the search and keep it to choose between remakes', () => {
  assert.deepEqual(showQuery('Seinfeld (1989)'), { name: 'Seinfeld', year: '1989' });
  assert.deepEqual(showQuery('Bluey'), { name: 'Bluey', year: null });
});

test('best episodes: rated, real seasons, highest first', () => {
  const eps = [{ season: 1, number: 1, rating: { average: 7 } }, { season: 0, number: 1, rating: { average: 9.9 } },
    { season: 2, number: 3, rating: { average: 9.1 }, name: 'X' }, { season: 3, number: 1, rating: { average: null } }];
  assert.deepEqual(bestOf(eps), [{ season: 2, episode: 3, rating: 9.1, name: 'X' }, { season: 1, episode: 1, rating: 7, name: '' }]);
});
