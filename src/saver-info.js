// Live facts for the screensaver, fetched by the server so the TV never calls outside services:
//  - weather: Perth beside the North Pole (Open-Meteo, no key), cached 15 min;
//  - flights: aircraft within 60 nm of Perth Airport (adsb.lol open ADS-B feed), cached 8 s.
// Nothing is fetched unless a screensaver asks; a failed fetch keeps the last good answer.
export const PERTH_AIRPORT = { lat: -31.9403, lon: 115.9669 };
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=-31.95,89.9&longitude=115.86,0'
  + '&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min'
  + '&forecast_days=1&timezone=auto';
const FLIGHTS_URL = `https://api.adsb.lol/v2/lat/${PERTH_AIRPORT.lat}/lon/${PERTH_AIRPORT.lon}/dist/60`;

export function weatherOf(body) {
  const list = Array.isArray(body) ? body : [];
  const one = item => {
    const c = item?.current || {}, d = item?.daily || {};
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    return {
      temp: num(c.temperature_2m), code: num(c.weather_code), wind: num(c.wind_speed_10m),
      max: num(d.temperature_2m_max?.[0]), min: num(d.temperature_2m_min?.[0]),
    };
  };
  if (list.length < 2) return null;
  return { perth: one(list[0]), northPole: one(list[1]) };
}

export function flightsOf(body) {
  const list = Array.isArray(body?.ac) ? body.ac : [];
  const out = [];
  for (const a of list) {
    if (typeof a?.lat !== 'number' || typeof a?.lon !== 'number') continue;
    const airborne = typeof a.alt_baro === 'number' && a.alt_baro > 0;
    const callsign = String(a.flight || '').trim().replace(/^@+$/, '') || String(a.r || '').trim();
    out.push({
      callsign: callsign.slice(0, 10), type: String(a.t || '').slice(0, 6), reg: String(a.r || '').slice(0, 10),
      alt: airborne ? Math.round(a.alt_baro) : 0, ground: !airborne,
      gs: typeof a.gs === 'number' ? Math.round(a.gs) : 0, track: typeof a.track === 'number' ? Math.round(a.track) : null,
      lat: a.lat, lon: a.lon,
    });
  }
  return out.sort((x, y) => Number(x.ground) - Number(y.ground) || y.alt - x.alt).slice(0, 60);
}

export function createSaverInfo({ fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  const cache = { weather: { at: 0, value: null, pending: null }, flights: { at: 0, value: null, pending: null } };
  async function cached(key, maxAge, url, parse) {
    const slot = cache[key];
    if (slot.value && now() - slot.at < maxAge) return slot.value;
    if (!slot.pending) {
      slot.pending = (async () => {
        try {
          const response = await fetchImpl(url, { headers: { 'User-Agent': 'onto-the-tv/1.0' }, signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const value = parse(await response.json());
          if (value) { slot.value = value; slot.at = now(); }
        } catch (error) {
          log(`saver ${key}: ${error.message}`);
        } finally { slot.pending = null; }
      })();
    }
    await slot.pending;
    return slot.value;
  }
  return {
    weather: () => cached('weather', 15 * 60_000, WEATHER_URL, weatherOf),
    flights: () => cached('flights', 8_000, FLIGHTS_URL, flightsOf),
  };
}
