# M2 playback cache

The full library remains owned by Onto the TV's configured source paths. External
media is served through a persistent block cache on the M2 internal SSD at
`~/Library/Caches/Onto the TV/media`. Internal media streams directly.

- **Where (15 Nov 2026):** on the T9 SSD, `hot/onto-the-tv-media` on the fast-tier volume
  (`/Volumes/M2-Fast`, or `Research` until it is reformatted), as the storage architecture
  places the TV server's hot media. Up to 80 GiB, keeping 40 GiB of the T9 free. Ian: "I just
  don't want the m2 internal drive getting full and I want snappy response"; "surely the SSD
  external is fast enough". Files already on the T9 are not cached. With the T9 away the
  cache is 2 GiB on the internal disk, which always keeps 50 GiB free. The old internal
  cache is emptied at startup by the cache's own eviction.
- Below its floor the cache gives way, kept titles included; `trim()` enforces the ceiling
  and floor on every warm and every ten minutes. Kept titles fill at most 80% of the ceiling,
  in order: every card's pick and the one after for each profile, then the episode every
  show opens on in Find a show (kids' first, then the grown-ups'), music folders aside. Disk pressure reclaims only
  cache blocks. No originals, catalogue entries, history or classifications are deleted.
- **What is about to play is kept (15 Nov 2026).** The server keeps every card's pick and
  the one after, for each profile's lineup (`IMMINENT_AUDIENCES` in `bin/tv-server.js`,
  about 55 titles), and warms those first: at startup, after a catalogue reload, and a
  few seconds after any lineup is asked for or a channel moves on. Kept titles' blocks are
  never evicted for anything else (`mediaCache.keep`). It used to warm the opening of
  every title in the library in turn: 4,000 openings through a 40 GiB cache, which pushed
  out the very episodes the cards were about to play (Ms Rachel took 9 s to start).
  A show picked by name in the Mac app's Find a show is not kept ahead: it is read from
  the drive when pressed.
- Opening coverage targets roughly 120 seconds using average bitrate plus 50%
  margin, bounded to 32–128 MiB per title (or the entire file when smaller).
  This is an estimate, not a guarantee of exactly two minutes for variable-bitrate
  media. The final 4 MiB is also warmed for common trailing metadata; other metadata
  and seek ranges are fetched and cached on demand.
- Streaming reads ahead two 4 MiB blocks. At most three block operations run at once;
  foreground work takes priority. Recently loaded blocks are bounded in memory.
- Persistent blocks are keyed by absolute source path, source size and modification
  time, and carry SHA-256 integrity checks. Corrupt blocks are fetched again.
- Exact HTTP byte ranges, suffix ranges, HEAD and full responses are preserved.
  Cache failures fall back to source reads. This is not an offline mirror: source
  metadata is still checked, and uncached sections require the external drive.
- Cache status is available through the existing authenticated server at
  `/api/media-cache`; it exposes hit, miss, byte and queue counters, not credentials.

No separate scheduler or TV-client installation is required. The existing server
LaunchAgent owns startup and the existing catalogue scan owns new-title warm-up.
The library migration retains its existing owner; this change does not switch paths
or remove retained internal originals.

## Verification — 1 November 2026

23 focused Node tests passed locally/M2, covering range boundaries, persistent
restart hits, same-size corruption, disk pressure, simultaneous size limits,
source identity changes, close during a write, authentication and existing
TV behavior. Silent M2 acceptance used an actual 125.7 MiB external MP4 through
this server: beginning, cross-block, middle seek and tail bytes matched the source;
all four HTTP responses were 206. Cache was restarted before measurement to prove
persistent disk hits. No audible playback or owner browser was used.

Deployment uses pre-change hashes and backups under
`~/Projects/tv-download-setup/runtime/cache-before-live`. The shared canonical
checkout also contains the implementation so subsequent TV deployments preserve it.
Evidence: `~/Projects/tv-download-setup/runtime/cache-acceptance/` on the controlling
Mac and `~/Projects/tv-cache-validation/live-acceptance.json` on M2. Initial staging
omitted the shuffler's CommonJS package marker; that test setup error was corrected
before all 23 M2 tests and real-file acceptance passed.
