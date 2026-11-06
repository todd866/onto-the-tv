import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryView } from './tv-library-api.js';

const NOW = Date.parse('2026-11-05T13:00:00Z');

function video(fields) {
  return {
    src: fields.src,
    file: fields.file,
    title: fields.title,
    channel: fields.channel,
    tier: fields.tier,
    duration: fields.duration || 0,
  };
}

function watch(file, position, duration, at, completed = false) {
  return {
    path: file,
    title: file,
    positionSeconds: position,
    durationSeconds: duration,
    completed,
    updatedAt: at,
  };
}

const mob = n => `/u/Movies/grown-ups/Mobland/Mobland S01E0${n}.mp4`;

test('Up next is one card per show and moves on when the latest episode is in its credits', () => {
  const videos = [5, 6, 7, 8, 9].map(n => video({
    src: `Mobland/Mobland S01E0${n}.mp4`,
    file: mob(n),
    title: `Mobland S01E0${n}`,
    channel: 'Mobland',
    tier: 'grownup',
    duration: n === 8 || n === 9 ? 0 : 2400,
  }));
  const history = [
    watch(mob(5), 432, 2480, '2026-11-05T12:36:00Z'),
    watch(mob(6), 2340, 2562, '2026-11-05T12:36:00Z'),
    watch(mob(7), 2133, 2453, '2026-11-05T12:36:00Z'),
  ];
  const view = libraryView({ videos, history, viewers: 'dad', now: NOW });
  assert.equal(view.upNext.length, 1);
  assert.equal(view.upNext[0].title, 'Mobland S01E08');
  assert.equal(view.upNext[0].upNext, true);
  assert.equal(view.upNext[0].show, 'Mobland');
  assert.equal(view.collections.some(row => row.items.some(item => item.title.startsWith('Mobland'))), false);
});

test('Up next drops plays older than 21 days and plays under a minute', () => {
  const oldFile = '/u/Movies/family-shorts/Lou (2017).mp4';
  const surfFile = '/u/Movies/family-films/Cars.mp4';
  const videos = [
    video({ src: 'Lou.mp4', file: oldFile, title: 'Lou (2017)', channel: 'Family Films', tier: 'shared', duration: 404 }),
    video({ src: 'Cars.mp4', file: surfFile, title: 'Cars', channel: 'Family Films', tier: 'shared', duration: 7000 }),
  ];
  const history = [
    watch(oldFile, 374, 404, '2026-10-15T01:35:00Z'),
    watch(surfFile, 12, 7000, '2026-11-05T12:00:00Z'),
  ];
  const view = libraryView({ videos, history, viewers: 'sam', now: NOW });
  assert.equal(view.upNext.length, 0);
});

test('collection rows follow what this audience watched most recently and collapse a show to one card', () => {
  const videos = [7, 8, 9].map(n => video({
    src: `Mobland/Mobland S01E0${n}.mp4`,
    file: mob(n),
    title: `Mobland S01E0${n}`,
    channel: 'Mobland',
    tier: 'grownup',
    duration: 2400,
  })).concat([
    video({ src: 'Utopia/Utopia S01E01.mp4', file: '/u/Movies/grown-ups/Utopia/Utopia S01E01.mp4', title: 'Utopia S01E01', channel: 'Utopia', tier: 'grownup', duration: 2400 }),
    video({ src: 'Utopia/Utopia S01E02.mp4', file: '/u/Movies/grown-ups/Utopia/Utopia S01E02.mp4', title: 'Utopia S01E02', channel: 'Utopia', tier: 'grownup', duration: 2400 }),
    video({
      src: 'Cars.mp4',
      file: '/u/Movies/family-films/Cars (2006).mp4',
      title: 'Cars (2006)',
      channel: 'Family Films',
      tier: 'grownup',
      duration: 7000,
    }),
    video({
      src: 'Piper.mp4',
      file: '/u/Movies/family-shorts/Piper (2016).mp4',
      title: 'Piper (2016)',
      channel: 'Family Films',
      tier: 'grownup',
      duration: 366,
    }),
  ]);
  const history = [
    watch(mob(7), 2133, 2453, '2026-11-05T12:36:00Z'),
    watch('/u/Movies/grown-ups/Utopia/Utopia S01E01.mp4', 2200, 2400, '2026-10-01T01:00:00Z'),
    watch('/u/Movies/family-shorts/Piper (2016).mp4', 300, 366, '2026-10-15T01:17:00Z'),
  ];
  const view = libraryView({ videos, history, viewers: 'dad', now: NOW });
  // Mobland is on Up next, so its collection keeps the row's place but not the duplicate card.
  assert.deepEqual(view.collections.map(row => row.title), ['Grown ups', 'Family shorts', 'Family films']);
  assert.deepEqual(view.collections[0].items.map(item => item.title), ['Utopia S01E02']);
});

test('the audience ceiling, cartoon tiers, and Ian alone match the home rules', () => {
  const videos = [
    video({ src: 'Bluey/a.mp4', file: '/m/Bluey/a.mp4', title: 'Bluey S01E01', channel: 'Bluey', tier: 'shared', duration: 420 }),
    video({ src: 'Big/b.mp4', file: '/m/Big/b.mp4', title: 'Track Time S01E01', channel: 'Track Time', tier: 'big', duration: 600 }),
    video({ src: 'Older/o.mp4', file: '/m/Older/o.mp4', title: 'Older S01E01', channel: 'Older Show', tier: 'older', duration: 1200 }),
    video({ src: 'Films/bruges.mkv', file: '/m/Films/bruges.mkv', title: 'In Bruges', channel: 'Films', tier: 'grownup', duration: 6000 }),
    video({ src: 'Family Films/nemo.mkv', file: '/m/Family Films/nemo.mkv', title: 'Finding Nemo', channel: 'Family Films', tier: 'shared', duration: 6000 }),
    video({ src: 'Knight Rider (1982)/e.mp4', file: '/m/Knight/e.mp4', title: 'Knight Rider S01E01', channel: 'Knight Rider (1982)', tier: 'grownup', duration: 3600 }),
    video({ src: 'Sitcom/s.mp4', file: '/m/Sitcom/s.mp4', title: 'Friends S01E01', channel: 'Friends', tier: 'sitcom', duration: 1300 }),
    video({ src: 'Come Dine With Me/e.mp4', file: '/m/CDWM/e.mp4', title: 'Come Dine With Me S01E01', channel: 'Come Dine With Me', tier: 'grownup', duration: 1800 }),
    video({ src: 'Vera/e.mp4', file: '/m/Vera/e.mp4', title: 'Vera S01E01', channel: 'Vera', tier: 'grownup', duration: 5400 }),
    video({ src: 'Futurama/e.mp4', file: '/m/Futurama/e.mp4', title: 'Futurama S01E01', channel: 'Futurama', tier: 'adultanim', duration: 1300 }),
    video({ src: 'ads/80s/spot.mp4', file: '/m/ads/spot.mp4', title: 'Ad', channel: 'Knight Rider', tier: 'grownup', duration: 30 }),
  ];
  const titles = view => view.items.map(item => item.title).sort();

  const sam = titles(libraryView({ videos, viewers: 'sam', now: NOW }));
  assert.deepEqual(sam, ['Bluey S01E01', 'Finding Nemo']);
  assert.equal(libraryView({ videos, viewers: 'sam', now: NOW }).ceiling, 'G');

  const jake = titles(libraryView({ videos, viewers: 'jake', now: NOW }));
  assert.ok(jake.includes('Bluey S01E01'));
  assert.ok(jake.includes('Track Time S01E01'));
  assert.ok(jake.includes('Knight Rider S01E01'));
  assert.equal(jake.includes('Older S01E01'), false);
  assert.equal(jake.includes('Friends S01E01'), false);
  assert.equal(jake.includes('In Bruges'), false);

  const dad = titles(libraryView({ videos, viewers: 'dad', now: NOW }));
  assert.equal(dad.includes('Bluey S01E01'), false);
  assert.equal(dad.includes('Finding Nemo'), false);
  assert.equal(dad.includes('Come Dine With Me S01E01'), false);
  assert.equal(dad.includes('Vera S01E01'), false);
  assert.equal(dad.includes('Ad'), false);
  assert.ok(dad.includes('In Bruges'));
  assert.ok(dad.includes('Friends S01E01'));
  assert.ok(dad.includes('Futurama S01E01'));
  assert.ok(dad.includes('Knight Rider S01E01'));

  const couple = titles(libraryView({ videos, viewers: 'mum,dad', now: NOW }));
  assert.ok(couple.includes('Come Dine With Me S01E01'));
  assert.equal(couple.includes('Bluey S01E01'), false);
  assert.equal(couple.includes('Finding Nemo'), false);

  const mum = titles(libraryView({ videos, viewers: 'mum', now: NOW }));
  assert.ok(mum.includes('Come Dine With Me S01E01'));
  assert.equal(mum.includes('Bluey S01E01'), false);

  const family = titles(libraryView({ videos, viewers: 'sam,jake', now: NOW }));
  assert.deepEqual(family, ['Bluey S01E01', 'Finding Nemo']);
});

test('a rating override replaces the audience ceiling, and an unknown rating does not', () => {
  const videos = [
    video({ src: 'Bluey/a.mp4', file: '/m/Bluey/a.mp4', title: 'Bluey S01E01', channel: 'Bluey', tier: 'shared', duration: 420 }),
    video({ src: 'Films/bruges.mkv', file: '/m/Films/bruges.mkv', title: 'In Bruges', channel: 'Films', tier: 'grownup', duration: 6000 }),
  ];
  const raised = libraryView({ videos, viewers: 'sam', rating: 'M', now: NOW });
  assert.equal(raised.ceiling, 'M');
  assert.deepEqual(raised.items.map(item => item.title).sort(), ['Bluey S01E01', 'In Bruges']);

  const lowered = libraryView({ videos, viewers: 'dad', rating: 'G', now: NOW });
  assert.equal(lowered.ceiling, 'G');
  assert.deepEqual(lowered.items.map(item => item.title), ['Bluey S01E01']);

  const ignored = libraryView({ videos, viewers: 'dad', rating: 'nonsense', now: NOW });
  assert.equal(ignored.ceiling, 'M');
  assert.deepEqual(ignored.items.map(item => item.title), ['In Bruges']);
});

test('resume positions come from history and a finished episode does not offer a place', () => {
  const file = '/m/Bluey/a.mp4';
  const videos = [video({ src: 'Bluey/a.mp4', file, title: 'Bluey S01E01', channel: 'Bluey', tier: 'shared', duration: 420 })];
  const midway = libraryView({
    videos,
    history: [watch(file, 200, 420, '2026-11-05T12:00:00Z')],
    viewers: 'sam',
    now: NOW,
  });
  assert.equal(midway.items[0].positionSeconds, 200);
  assert.equal(midway.items[0].durationSeconds, 420);
  assert.equal(midway.items[0].resume, 200);
  assert.equal(midway.items[0].art, '/art?src=' + encodeURIComponent('Bluey/a.mp4'));

  const done = libraryView({
    videos,
    history: [watch(file, 420, 420, '2026-11-05T12:00:00Z', true)],
    viewers: 'sam',
    now: NOW,
  });
  assert.equal(done.items[0].completed, true);
  assert.equal(done.items[0].resume, 0);
});

test('shows group their episodes with resume points, and films stay separate', () => {
  const videos = [
    video({ src: 'Bluey/a.mp4', file: '/m/Bluey/a.mp4', title: 'Bluey S01E02', channel: 'Bluey', tier: 'shared', duration: 420 }),
    video({ src: 'Bluey/b.mp4', file: '/m/Bluey/b.mp4', title: 'Bluey S01E01', channel: 'Bluey', tier: 'shared', duration: 420 }),
    video({ src: 'Bluey/c.mp4', file: '/m/Bluey/c.mp4', title: 'Bluey S02E01', channel: 'Bluey', tier: 'shared', duration: 420 }),
    video({ src: 'Family Films/nemo.mkv', file: '/m/Family Films/nemo.mkv', title: 'Finding Nemo', channel: 'Family Films', tier: 'shared', duration: 6000 }),
  ];
  const view = libraryView({
    videos,
    history: [watch('/m/Bluey/a.mp4', 80, 420, '2026-11-05T11:00:00Z')],
    viewers: 'sam',
    now: NOW,
  });
  assert.equal(view.shows.length, 1);
  assert.equal(view.shows[0].title, 'Bluey');
  assert.deepEqual(view.shows[0].episodes.map(ep => ep.title), ['Bluey S01E01', 'Bluey S01E02', 'Bluey S02E01']);
  assert.deepEqual(view.shows[0].episodes.map(ep => [ep.season, ep.episode]), [[1, 1], [1, 2], [2, 1]]);
  assert.equal(view.shows[0].episodes[1].resume, 80);
  assert.equal(view.shows[0].resume, 80);
  assert.deepEqual(view.films.map(item => item.title), ['Finding Nemo']);
  assert.equal(view.films[0].kind, 'film');
});

test('nobody watching gets an empty library, and a missing viewers list is the whole household', () => {
  const videos = [
    video({ src: 'Bluey/a.mp4', file: '/m/Bluey/a.mp4', title: 'Bluey S01E01', channel: 'Bluey', tier: 'shared', duration: 420 }),
    video({ src: 'Films/bruges.mkv', file: '/m/Films/bruges.mkv', title: 'In Bruges', channel: 'Films', tier: 'grownup', duration: 6000 }),
  ];
  const nobody = libraryView({ videos, viewers: '', now: NOW });
  assert.equal(nobody.ceiling, null);
  assert.equal(nobody.items.length, 0);
  const house = libraryView({ videos, now: NOW });
  assert.equal(house.ceiling, 'G');
  assert.deepEqual(house.items.map(item => item.title), ['Bluey S01E01']);
});
