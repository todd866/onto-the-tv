import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaverInfo, flightsOf, weatherOf } from './saver-info.js';

test('weatherOf pairs Perth with the North Pole and rounds', () => {
  const w = weatherOf([
    { current: { temperature_2m: 19.4, weather_code: 0, wind_speed_10m: 28.7 }, daily: { temperature_2m_max: [24.6], temperature_2m_min: [16.2] } },
    { current: { temperature_2m: -23.6, weather_code: 71, wind_speed_10m: 12.1 }, daily: { temperature_2m_max: [-21], temperature_2m_min: [-27.8] } },
  ]);
  assert.deepEqual(w, { perth: { temp: 19, code: 0, wind: 29, max: 25, min: 16 }, northPole: { temp: -24, code: 71, wind: 12, max: -21, min: -28 } });
  assert.equal(weatherOf({}), null);
});

test('flightsOf keeps positioned aircraft, airborne first and highest first, with a usable callsign', () => {
  const f = flightsOf({ ac: [
    { flight: '@@@@@@@@', r: 'VH-VZL', t: 'B738', alt_baro: 'ground', gs: 11.8, track: 50.6, lat: -31.93, lon: 115.96 },
    { flight: 'QFA642  ', t: 'A332', alt_baro: 12000, gs: 300.2, track: 90, lat: -31.9, lon: 116.2 },
    { flight: 'NMN     ', t: 'C172', r: 'VH-NMN', alt_baro: 1225, gs: 108.7, track: 192.8, lat: -32.1, lon: 115.8 },
    { flight: 'NOPOS' },
  ] });
  assert.deepEqual(f.map(x => x.callsign), ['QFA642', 'NMN', 'VH-VZL']);
  assert.equal(f[2].ground, true);
  assert.equal(f[0].alt, 12000);
});

test('createSaverInfo caches and keeps the last good answer when a fetch fails', async () => {
  let t = 0, calls = 0, fail = false;
  const fetchImpl = async () => { calls++; if (fail) throw new Error('down'); return { ok: true, json: async () => ({ ac: [{ flight: 'A', alt_baro: 5000, lat: 1, lon: 2 }] }) }; };
  const info = createSaverInfo({ fetchImpl, now: () => t });
  assert.equal((await info.flights()).length, 1);
  await info.flights();
  assert.equal(calls, 1, 'cached within 8 s');
  t += 9000; fail = true;
  assert.equal((await info.flights()).length, 1, 'stale but good beats nothing');
  assert.equal(calls, 2);
});
