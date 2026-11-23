import { existsSync, readFileSync } from 'node:fs';

// The canon knowledge map written by tools/show-embed (embed.py export): every
// Christmas entry we know about — downloaded or not — as one point in the local
// embedding space, with each entry's nearest neighbours. The Christmas channel
// uses it so that what the household just watched leans the next pick toward
// canon neighbours (Rudolph → Frosty) instead of a flat shuffle.
export const AFFINITY_BONUS = 0.6;

/** Title → canon slug: lowercase, punctuation folded, no year suffix. */
export function slugify(title) {
  return String(title || '')
    .replace(/\s*\((?:19|20)\d\d\)\s*$/, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function addEdge(edges, a, b, sim) {
  let row = edges.get(a);
  if (!row) { row = new Map(); edges.set(a, row); }
  const prev = row.get(b) || 0;
  if (sim > prev) row.set(b, sim);
}

function index(space) {
  if (!space) return null;
  const bySlug = new Map();
  const edges = new Map();
  for (const [slug, entry] of Object.entries(space)) {
    if (!entry || !Array.isArray(entry.next)) continue;
    const pairs = entry.next.filter(pair => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'number');
    bySlug.set(slug, pairs);
    for (const [other, sim] of pairs) {
      if (!other || other === slug || sim <= 0) continue;
      addEdge(edges, slug, other, sim);
      addEdge(edges, other, slug, sim);
    }
  }
  if (!bySlug.size) return null;
  return { bySlug, edges };
}

export function loadShowSpace(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return index(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null; // A truncated export never breaks channel picks.
  }
}
loadShowSpace.from = object => index(object);

/** Resolve a library title to a canon slug, tolerating the harvester's
 *  disambiguator suffixes ("White Christmas (film)" → white-christmas-film). */
export function canonSlug(space, title) {
  if (!space) return null;
  const slug = slugify(title);
  if (!slug) return null;
  if (space.bySlug.has(slug)) return slug;
  for (const suffix of ['-film', '-tv-special', '-tv-series', '-soundtrack', '-book', '-song']) {
    if (space.bySlug.has(slug + suffix)) return slug + suffix;
  }
  // A prefix match covers "-2"-style sequels the map holds separately.
  for (const candidate of space.bySlug.keys()) {
    if (candidate.startsWith(slug) && candidate.length - slug.length <= 2) return candidate;
  }
  return null;
}

/** 1 (neutral) … 1 + AFFINITY_BONUS, for a candidate canon item given the
 *  christmas titles watched most recently. Unknown titles stay neutral — the
 *  map steers, it never excludes. */
export function christmasAffinity(space, title, recentTitles) {
  if (!space) return 1;
  const slug = canonSlug(space, title);
  if (!slug) return 1;
  const neighbours = space.bySlug.get(slug);
  let best = 0;
  for (const recent of recentTitles || []) {
    const watchedSlug = canonSlug(space, recent);
    if (!watchedSlug) continue;
    const hit = neighbours.find(([other]) => other === watchedSlug);
    if (hit) best = Math.max(best, hit[1]);
  }
  if (best <= 0) return 1;
  return 1 + AFFINITY_BONUS * Math.max(0, best);
}

/** Symmetric canon show similarity (1 .. 1 + AFFINITY_BONUS) for general channels and Down directions. */
export function showAffinity(space, title, anchorTitles) {
  if (!space || !title || !anchorTitles?.length) return 1;
  const slug = canonSlug(space, title);
  if (!slug) return 1;
  const neighbours = space.edges ? space.edges.get(slug) : null;
  if (!neighbours) return 1;
  let best = 0;
  for (const anchor of anchorTitles) {
    const anchorSlug = canonSlug(space, anchor);
    if (!anchorSlug || anchorSlug === slug) continue;
    const sim = neighbours.get(anchorSlug) || 0;
    if (sim > best) best = sim;
  }
  if (best <= 0) return 1;
  return 1 + AFFINITY_BONUS * Math.min(1, best);
}
