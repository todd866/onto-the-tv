# M2 playback cache

The full library remains owned by Onto the TV's configured source paths. External
media is served through a persistent block cache on the M2 internal SSD at
`~/Library/Caches/Onto the TV/media`. Internal media streams directly.

- 20 GiB disk-cache ceiling; 40 GiB free-space reserve. Disk pressure reclaims only
  cache blocks. No originals, catalogue entries, history or classifications are deleted.
- Warm-up runs sequentially after startup and catalogue refresh, with background
  priority, 200 ms between blocks and one second between titles. It starts only
  for external paths in the actual catalogue, so it follows the verified migration.
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
