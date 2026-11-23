import { existsSync, readFileSync } from 'node:fs';

// Multimodal video embedding map written by tools/video-embed (video_embed.py export):
// blends Gemini Embedding 2 (3072-dim, progressive text -> keyframes -> audio) with
// local EmbeddingGemma 2 (768-dim MLX). Steers channel picks toward semantic, visual,
// and sonic neighbours of what the household just finished — never excludes unembedded
// items and never overrides rating ceilings or serial episode order.
export const VIDEO_AFFINITY_BONUS = 0.55;

function addEdge(edges, a, b, sim) {
  let row = edges.get(a);
  if (!row) { row = new Map(); edges.set(a, row); }
  const prev = row.get(b) || 0;
  if (sim > prev) row.set(b, sim);
}

function index(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const raw = doc.videos && typeof doc.videos === 'object' ? doc.videos : doc;
  const bySrc = new Map();
  const edges = new Map();
  for (const [src, entry] of Object.entries(raw)) {
    if (!entry || !Array.isArray(entry.next)) continue;
    const pairs = entry.next.filter(
      pair => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'number' && Number.isFinite(pair[1]),
    );
    if (pairs.length) {
      bySrc.set(src, pairs);
      for (const [other, sim] of pairs) {
        if (!other || other === src || sim <= 0) continue;
        addEdge(edges, src, other, sim);
        addEdge(edges, other, src, sim);
      }
    }
  }
  if (!bySrc.size) return null;
  return { bySrc, edges };
}

export function loadVideoSpace(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return index(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null; // A missing or mid-write export never breaks channel picks.
  }
}
loadVideoSpace.from = object => index(object);

/** 1 (neutral) .. 1 + VIDEO_AFFINITY_BONUS for candidate `src` given anchor/recent `recentSrcs`. */
export function videoAffinity(space, src, recentSrcs) {
  if (!space || !src || !recentSrcs?.length) return 1;
  const neighbours = space.edges ? space.edges.get(src) : null;
  if (!neighbours) return 1;
  let best = 0;
  for (const recent of recentSrcs) {
    if (!recent || recent === src) continue;
    const sim = neighbours.get(recent) || 0;
    if (sim > best) best = sim;
  }
  if (best <= 0) return 1;
  return 1 + VIDEO_AFFINITY_BONUS * Math.min(1, best);
}
