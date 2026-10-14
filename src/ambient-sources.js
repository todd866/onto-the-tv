import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const AMBIENT_LOCATIONS = [
  { id: 'cottesloe', label: 'Cottesloe' },
  { id: 'safety-bay', label: 'Safety Bay' },
  { id: 'rottnest', label: 'Rottnest' },
  { id: 'perth-airport', label: 'Perth Airport' },
  { id: 'garden-island', label: 'Garden Island' },
  { id: 'yssy', label: 'Sydney' },
];

export const DEFAULT_AMBIENT_OPTIONS = {
  weather: true, news: false, photos: false, location: 'cottesloe', pace: 20, photoFolder: '',
};

const LOCATION_IDS = new Set(AMBIENT_LOCATIONS.map(({ id }) => id));
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const BBC_URL = 'https://feeds.bbci.co.uk/news/world/rss.xml';
const NEWS_CACHE_MS = 15 * 60 * 1000;
const MAX_NEWS_BYTES = 1024 * 1024;
const MAX_NEWS_AGE_MS = 48 * 60 * 60 * 1000;
const NEWS_RETRY_MS = NEWS_CACHE_MS;

export function validateAmbientOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Ambient options must be an object.');
  const result = { ...DEFAULT_AMBIENT_OPTIONS };
  for (const key of ['weather', 'news', 'photos']) if (key in input) {
    if (typeof input[key] !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
    result[key] = input[key];
  }
  if ('location' in input) {
    if (typeof input.location !== 'string' || !LOCATION_IDS.has(input.location)) throw new TypeError('Choose a supported weather location.');
    result.location = input.location;
  }
  if ('pace' in input) {
    if (![10, 20, 40].includes(input.pace)) throw new TypeError('Ambient pace must be 10, 20 or 40 seconds.');
    result.pace = input.pace;
  }
  if ('photoFolder' in input) {
    if (typeof input.photoFolder !== 'string' || (input.photoFolder && (!isAbsolute(input.photoFolder) || input.photoFolder.includes('\0')))) {
      throw new TypeError('Photo folder must be an absolute path or blank.');
    }
    result.photoFolder = input.photoFolder;
  }
  return result;
}

function locationLabel(id) { return AMBIENT_LOCATIONS.find(item => item.id === id)?.label || id; }
function issue(message) { return String(message); }
function asNumber(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function weatherDescription(code) {
  if (code == null || code === '') return '';
  const n = Number(code);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'Clear sky';
  if ([1, 2, 3].includes(n)) return n === 1 ? 'Mainly clear' : n === 2 ? 'Partly cloudy' : 'Overcast';
  if ([45, 48].includes(n)) return 'Foggy';
  if (n >= 51 && n <= 67) return 'Rain';
  if (n >= 71 && n <= 77) return 'Snow';
  if (n >= 80 && n <= 82) return 'Showers';
  if (n >= 95) return 'Thunderstorms';
  return 'Mixed conditions';
}
function formatTemp(value) { return value == null ? '' : `${Math.round(value)}°`; }
function dateFromArchive(value) {
  if (typeof value !== 'string') return NaN;
  const parsed = Date.parse(/[zZ]$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function weatherSlide(store, location, now) {
  const currentPath = join(store, 'products', 'points', 'ecmwf_ifs', 'current.json');
  const pointer = JSON.parse(await readFile(currentPath, 'utf8'));
  const run = typeof pointer.latest === 'string' ? pointer.latest : pointer.runs?.[0];
  if (!run || !/^[0-9T:-]+Z$/.test(run)) throw new Error('Isobar has no current forecast run.');
  const data = JSON.parse(await readFile(join(store, 'products', 'points', 'ecmwf_ifs', 'runs', run, `${location}.json`), 'utf8'));
  const times = Array.isArray(data.time) ? data.time : [];
  const hourly = data.hourly && typeof data.hourly === 'object' ? data.hourly : {};
  const temps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const codes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
  if (!times.length || !temps.length) throw new Error('missing forecast data');
  const currentMs = now();
  const validIndexes = times.map((time, index) => ({ index, stamp: dateFromArchive(time) }))
    .filter(item => Number.isFinite(item.stamp) && asNumber(temps[item.index]) != null);
  if (!validIndexes.length) throw new Error('invalid forecast timestamps');
  if (!validIndexes.some(item => item.stamp >= currentMs)) throw new Error('forecast expired');
  const nearest = validIndexes.reduce((best, item) => Math.abs(item.stamp - currentMs) < Math.abs(best.stamp - currentMs) ? item : best, validIndexes[0]);
  const index = nearest.index;
  if (!Number.isFinite(dateFromArchive(times[index]))) throw new Error('invalid forecast timestamps');
  const temp = asNumber(temps[index]);
  const condition = weatherDescription(codes[index]);
  const cells = [];
  for (let offset = 0; offset < 4; offset += 1) {
    const i = index + offset * 3;
    const stamp = dateFromArchive(times[i]);
    if (!times[i] || !Number.isFinite(stamp) || asNumber(temps[i]) == null) continue;
    const hour = new Date(stamp).toLocaleTimeString('en-AU', { hour: 'numeric', hour12: true, timeZone: location === 'yssy' ? 'Australia/Sydney' : 'Australia/Perth' });
    cells.push({ label: hour, value: `${formatTemp(temps[i])}${weatherDescription(codes[i]) ? ` ${weatherDescription(codes[i])}` : ''}` });
  }
  const runDate = new Date(dateFromArchive(data.run));
  const ageHours = Number.isFinite(runDate.getTime()) ? Math.max(0, Math.round((currentMs - runDate.getTime()) / 3600000)) : null;
  const freshness = ageHours == null ? 'run time unknown' : `${ageHours}h old${ageHours > 36 ? ' · stale' : ''}`;
  return { kind: 'weather', eyebrow: 'Forecast', title: `${locationLabel(location)} ${formatTemp(temp)}`.trim(), detail: condition || 'Forecast available', footer: `Isobar · ECMWF · ${freshness} · Weather data by Open-Meteo.com`, sourceUrl: 'https://open-meteo.com/', forecast: cells };
}

function decodeEntities(text) {
  return String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[\da-f]+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const value = entity.toLowerCase().startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.replace(/^#/, ''), 10);
    return Number.isFinite(value) ? String.fromCodePoint(Math.min(value, 0x10ffff)) : '';
  }).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
function tag(xml, name) { return decodeEntities(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] || ''); }

function parseNews(xml, now) {
  const slides = [];
  for (const item of String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || []) {
    const title = tag(item, 'title').slice(0, 240);
    const published = Date.parse(tag(item, 'pubDate'));
    if (!title || !Number.isFinite(published) || now - published > MAX_NEWS_AGE_MS || published > now + 5 * 60 * 1000) continue;
    slides.push({ kind: 'news', publishedAt: new Date(published).toISOString(), eyebrow: 'BBC News', title, detail: 'World news', footer: `BBC News · ${new Date(published).toLocaleString('en-AU', { month:'short', day:'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`, sourceUrl: 'https://www.bbc.com/news/world' });
    if (slides.length >= 5) break;
  }
  return slides;
}

async function readResponseBounded(response) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value?.byteLength || 0;
      if (size > MAX_NEWS_BYTES) { await reader.cancel(); throw new Error('feed too large'); }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_NEWS_BYTES) throw new Error('feed too large');
  return text;
}

async function fetchNews(fetchImpl, now, cache) {
  const current = now();
  const usable = () => (cache.value || []).filter(slide => now() - Date.parse(slide.publishedAt) <= MAX_NEWS_AGE_MS);
  const stale = () => usable().map(slide => ({ ...slide, footer: `${slide.footer} · stale cache` }));
  if (cache.value && current - cache.at < NEWS_CACHE_MS && usable().length) return usable();
  if (cache.pending) return cache.pending;
  if (cache.failedAt && current - cache.failedAt < NEWS_RETRY_MS) {
    if (usable().length) return stale();
    throw new Error('feed temporarily unavailable');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  cache.pending = (async () => {
    try {
      const response = await fetchImpl(BBC_URL, { signal: controller.signal, redirect: 'error' });
      if (!response?.ok) throw new Error('feed unavailable');
      if (response.url) {
        const url = new URL(response.url);
        if (url.protocol !== 'https:' || url.hostname !== 'feeds.bbci.co.uk') throw new Error('feed host rejected');
      }
      const slides = parseNews(await readResponseBounded(response), now());
      if (!slides.length) throw new Error('no recent headlines');
      cache.value = slides; cache.at = now(); cache.failedAt = 0;
      return slides;
    } catch (error) {
      cache.failedAt = now();
      if (usable().length) return stale();
      throw new Error('feed unavailable');
    } finally { clearTimeout(timer); cache.pending = null; }
  })();
  return cache.pending;
}

async function photoSlides(folder) {
  if (!folder) throw new Error('Choose a photo folder first.');
  const root = resolve(folder);
  const found = [];
  let scannedEntries = 0;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Choose a real photo folder.');
  let component = root;
  while (component && component !== parse(component).root) {
    const info = await lstat(component);
    if (info.isSymbolicLink()) throw new Error('Choose a real photo folder.');
    component = dirname(component);
  }
  async function visit(dir, depth) {
    if (depth > 2 || scannedEntries >= 200 || found.length >= 12) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scannedEntries >= 200 || found.length >= 12) break;
      scannedEntries += 1;
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      let info;
      try { info = await lstat(path); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!info.isFile() || info.size > 20 * 1024 * 1024 || !IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      found.push({ path, size: info.size });
    }
  }
  await visit(root, 0);
  return found.slice(0, 12).map((item, index) => ({ kind: 'photo', eyebrow: 'Photos', title: `Photo ${index + 1}`, detail: 'Family photos', footer: `${index + 1} of ${Math.min(found.length, 12)}`, image: pathToFileURL(item.path).href }));
}

export function createAmbientSources({ store = join(homedir(), 'Data', 'isobar'), fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const newsCache = { value: null, at: 0 };
  return { async snapshot(input = {}) {
    const options = validateAmbientOptions(input);
    const slides = [];
    const issues = [];
    const tasks = [];
    if (options.weather) tasks.push(weatherSlide(store, options.location, now).then(slide => slides.push(slide)).catch(() => issues.push('Weather unavailable.')));
    if (options.news) tasks.push(fetchNews(fetchImpl || globalThis.fetch, now, newsCache).then(items => slides.push(...items)).catch(() => issues.push('News unavailable.')));
    if (options.photos) tasks.push(photoSlides(options.photoFolder).then(items => { if (!items.length) issues.push('Photos unavailable: the chosen folder has no supported images.'); slides.push(...items); }).catch(() => issues.push('Photos unavailable.')));
    await Promise.all(tasks);
    return { slides, issues, locations: AMBIENT_LOCATIONS };
  } };
}
