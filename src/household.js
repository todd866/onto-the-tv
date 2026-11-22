// Who lives here, and where the household's machines are. None of it belongs in the repository: the real
// file is private, outside the repo, and read once at start-up. Without one the example below is used.
//
//   ~/.config/onto-the-tv/household.json   (or the path in ONTO_HOUSEHOLD)
//
// {
//   "viewers":  [{ "id": "kid1", "name": "Robin", "ceiling": "G", "role": "youngest" }, ...],
//   "profiles": [{ "id": "kid1", "name": "Robin", "mark": "R", "viewers": ["kid1", "adult2", "adult1"],
//                  "layout": "pictures", "theme": "coral" }, ...],
//   "assistant": { "age": 6 },
//   "network":  { "homeOrigin": "http://192.168.1.20:8686", "tailnetOrigin": "https://tv-mac.example.ts.net:8443",
//                 "tvHost": "192.168.1.14", "couchServer": "http://192.168.1.20:8690" }
// }
//
// Roles say what the code does for whom, so no id or name is written into it:
//   youngest  the youngest child (G): leads with the little ones' channels and their music
//   older     the older child (PG): their own channel, the tube layout, the voice assistant's audience
//   adultA    the grown-up whose own channel and running order lead their solo lineup
//   adultB    the other grown-up, with their own channel and running order
// Ids are the keys watch history and taste are stored under, so a household keeps its ids once chosen.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROLES = ['youngest', 'older', 'adultA', 'adultB'];
const RATINGS = ['G', 'PG', 'PG-13', 'M'];
const LAYOUTS = ['now', 'guide', 'pictures', 'tube'];
// Colour schemes a profile can wear (tv/styles.css, ui/styles.css).
export const THEMES = ['default', 'amber', 'rose', 'lime', 'coral', 'teal'];

export const EXAMPLE_HOUSEHOLD = Object.freeze({
  viewers: [
    { id: 'kid1', name: 'Robin', ceiling: 'G', role: 'youngest' },
    { id: 'kid2', name: 'Max', ceiling: 'PG', role: 'older' },
    { id: 'adult2', name: 'Jordan', ceiling: null, role: 'adultB' },
    { id: 'adult1', name: 'Casey', ceiling: null, role: 'adultA' },
  ],
  profiles: [
    { id: 'adult1', name: 'Casey', mark: 'C', viewers: ['adult1'], layout: 'now', theme: 'amber' },
    { id: 'adult2', name: 'Jordan', mark: 'J', viewers: ['adult2'], layout: 'guide', theme: 'rose' },
    { id: 'kid2', name: 'Max', mark: 'M', viewers: ['kid2', 'adult2', 'adult1'], layout: 'tube', theme: 'lime' },
    { id: 'kid1', name: 'Robin', mark: 'R', viewers: ['kid1', 'kid2', 'adult2', 'adult1'], desktopViewers: ['kid1', 'adult2', 'adult1'], layout: 'pictures', theme: 'coral' },
    { id: 'all', name: 'Everyone', mark: '★', viewers: ['kid1', 'kid2', 'adult2', 'adult1'], layout: 'now', theme: 'teal' },
  ],
  assistant: { age: null },
  network: { homeOrigin: 'http://192.168.1.20:8686', tailnetOrigin: 'https://tv-mac.example.ts.net:8443',
    tvHost: '192.168.1.14', couchServer: 'http://192.168.1.20:8690' },
});

const ID = /^[a-z0-9_-]{1,24}$/;
const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
function origin(value, fallback) {
  try { const url = new URL(String(value)); return /^https?:$/.test(url.protocol) ? url.origin : fallback; } catch { return fallback; }
}

/** Check and fill a household; anything malformed falls back to the example's value for that part. */
export function normaliseHousehold(raw = {}) {
  const example = EXAMPLE_HOUSEHOLD;
  const viewers = [];
  for (const entry of Array.isArray(raw.viewers) ? raw.viewers : []) {
    const id = text(entry?.id, 24).toLowerCase();
    if (!ID.test(id) || viewers.some(viewer => viewer.id === id)) continue;
    const ceiling = entry.ceiling == null ? null : RATINGS.includes(entry.ceiling) ? entry.ceiling : null;
    const role = ROLES.includes(entry.role) && !viewers.some(viewer => viewer.role === entry.role) ? entry.role : null;
    viewers.push({ id, name: text(entry.name, 40) || id, ceiling, role });
  }
  const people = viewers.length ? viewers : example.viewers.map(viewer => ({ ...viewer }));
  const known = new Set(people.map(viewer => viewer.id));
  const profiles = [];
  for (const entry of Array.isArray(raw.profiles) ? raw.profiles : []) {
    const id = text(entry?.id, 24).toLowerCase();
    if (!ID.test(id) || profiles.some(profile => profile.id === id)) continue;
    const ids = (Array.isArray(entry.viewers) ? entry.viewers : []).map(value => String(value).toLowerCase()).filter(value => known.has(value));
    if (!ids.length) continue;
    // The Mac app's Channels tab may seat a profile with a different audience from the TV's (desktopViewers).
    const desk = (Array.isArray(entry.desktopViewers) ? entry.desktopViewers : []).map(value => String(value).toLowerCase()).filter(value => known.has(value));
    profiles.push({ id, name: text(entry.name, 40) || id, mark: text(entry.mark, 2) || id.slice(0, 1).toUpperCase(), viewers: [...new Set(ids)],
      desktopViewers: desk.length ? [...new Set(desk)] : [...new Set(ids)],
      layout: LAYOUTS.includes(entry.layout) ? entry.layout : 'now', theme: THEMES.includes(entry.theme) ? entry.theme : 'default' });
  }
  const network = {};
  const given = raw.network && typeof raw.network === 'object' ? raw.network : {};
  for (const key of ['homeOrigin', 'tailnetOrigin', 'couchServer']) network[key] = origin(given[key], example.network[key]);
  network.tvHost = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(given.tvHost || '')) ? given.tvHost : example.network.tvHost;
  const age = Number(raw.assistant?.age);
  return {
    viewers: people,
    profiles: profiles.length ? profiles : viewers.length ? defaultProfiles(people) : normaliseProfiles(example.profiles),
    assistant: { age: Number.isInteger(age) && age > 0 && age < 19 ? age : null },
    network,
  };
}

function normaliseProfiles(list) {
  return list.map(profile => ({ ...profile, viewers: [...profile.viewers], desktopViewers: [...(profile.desktopViewers || profile.viewers)] }));
}
function defaultProfiles(people) {
  return normaliseProfiles([...people.map(viewer => ({ id: viewer.id, name: viewer.name, mark: viewer.name.slice(0, 1).toUpperCase(), viewers: [viewer.id], layout: 'now', theme: 'default' })),
    { id: 'all', name: 'Everyone', mark: '\u2605', viewers: people.map(viewer => viewer.id), layout: 'now', theme: 'default' }]);
}

/** Where the private file is. Under `node --test`, or with ONTO_HOUSEHOLD=example (the check scripts), the example is used. */
export function householdPath(env = process.env) {
  if (env.ONTO_HOUSEHOLD) return env.ONTO_HOUSEHOLD;
  if (env.NODE_TEST_CONTEXT) return null;
  return join(homedir(), '.config/onto-the-tv/household.json');
}

export function loadHousehold({ env = process.env, read = path => readFileSync(path, 'utf8') } = {}) {
  const path = env.ONTO_HOUSEHOLD === 'example' ? null : householdPath(env);
  if (!path) return { ...normaliseHousehold({}), source: 'example', path: null };
  let raw;
  try { raw = JSON.parse(read(path)); }
  catch (error) {
    return { ...normaliseHousehold({}), source: 'example', path, problem: error.code === 'ENOENT' ? 'missing' : error.message };
  }
  return { ...normaliseHousehold(raw), source: 'private', path };
}

export const HOUSEHOLD = loadHousehold();

/** Role → viewer id (null when the household has nobody in that role). */
export const ROLE = Object.freeze(Object.fromEntries(ROLES.map(role => [role, HOUSEHOLD.viewers.find(viewer => viewer.role === role)?.id || null])));
export const nameOf = id => HOUSEHOLD.viewers.find(viewer => viewer.id === id)?.name || '';
export const viewerIdList = () => HOUSEHOLD.viewers.map(viewer => viewer.id);
/** An audience string from roles, skipping roles nobody holds: audienceOf('older', 'adultB', 'adultA'). */
export const audienceOf = (...roles) => roles.map(role => ROLE[role]).filter(Boolean).join(',');
/** What the pages need (names and profiles); never the network part. */
export const publicHousehold = () => ({ viewers: HOUSEHOLD.viewers.map(({ id, name, ceiling, role }) => ({ id, name, ceiling, role })), profiles: HOUSEHOLD.profiles });
