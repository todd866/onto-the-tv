# A decent music acquisition engine

Onto the TV's music channels are the playback surface of a small ecosystem that
finds, acquires and learns music without being asked. This doc is the recipe:
what lives in this repo, what lives in the sibling repos, and how the pieces
fit. No credentials or personal data ship here.

## The shape

```
station playlists + likes + radio lane      (discovery)
        │
        ▼
  candidates → rank → acquire (lossless preferred)
        │
        ▼
  masters → hot set (played Macs) → cold tier (object storage)
        │
        ▼
  shared store: ids.json alias table · taste log · embeddings
        │
        ▼
  onto-the-tv music channels (this repo) ──likes──▶ taste log
```

## What this repo contributes (the playback brain)

- **Music channels** (`music`, `dance`, `livesets`, `triplej`, `doublej`) select
  by `tier === 'music'` — `src/music-pick.js`.
- **Song identity across surfaces**: `parseArtistTitleFromVideo` +
  `normalizeTitle` resolve a YouTube video, an ALAC master and a radio track to
  one song through the shared alias table (`music/ids.json`, maintained by
  [music-core](https://github.com/todd866/music-core)). A music video liked on
  the TV is the same song as the album master played elsewhere.
- **Learning**: an early skip (<30 s) is a skip signal; likes append to the one
  append-only per-listener taste log shared with Glancebar and 6IAN radio
  (`src/music-taste.js`). On a household screen the like is the household's
  (`household-tv`) unless a single viewer maps to a listener. A like never
  blocks or fails playback — the append is fire-and-forget.
- **Picking** (`src/music-pick.js`): heard-list cooldown (3 days), a small
  exploration share (~12%) so the channel keeps surprising, embedding
  similarity (3072-dim vectors from the shared embed store) with a neutral
  floor, and a weight floor so mild dislikes fade rather than exile.
- **Live-session awareness**: folders like KEXP, Tiny Desk, Cercle, Like A
  Version are recognised as sessions, so long sets compete with long sets.

## The acquisition engine (sibling repos, the recipe)

The working engine lives in [Glancebar](https://github.com/todd866/glancebar)
(`tools/music-scout/`, `tools/music-library/`) and
[6IAN radio](https://github.com/todd866/6ian-radio); this repo consumes its
output. The pattern, so you can rebuild it anywhere:

1. **Discovery without being asked.** Poll station playlists (KEXP, NTS,
   6 Music, WFMU, community radio) plus the household's likes; every spin is a
   candidate with a timestamp and a source.
2. **Rank, don't hoard.** Score candidates by recurrence across sources and
   proximity to the embedded taste neighbourhood; keep a bounded queue.
3. **Acquire the best source that exists.** Lossless (ALAC) where available,
   best AAC otherwise; YouTube likes sync as their own lane. Masters land in
   per-source pools, never ad-hoc folders.
4. **Tier by heat.** A capped lossless hot set on the Macs that play music
   daily; every master also in a private object-storage bucket that is the
   catalogue's source of truth; fetch from cold on demand.
5. **One store for identity.** ids (aliases), taste (append-only log) and
   facts live in one shared store every surface reads and writes
   (music-core's `docs/music-unify.md` describes the schema).
6. **Let playback teach acquisition.** Skips and likes on the TV flow back
   through the taste log into the scout's ranking — the loop that makes the
   engine "decent" instead of merely automatic.

## Where the numbers live

Per-Mac state (embed vectors, catalogue cache, scout queue) lives under
`~/.local/state/`; config under `~/.config/`. Nothing here is committed to the
repo.
