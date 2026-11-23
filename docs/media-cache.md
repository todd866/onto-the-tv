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

## Cloud source (22 Nov 2026, branch `cloud-source`; off unless the server is started with --cloud-source)

The aim: keep enough of each title on a drive to start it at once, play the rest from an encrypted cloud backup of
the library, and so hold far more video than the drives could. Every drive is to stay inside 75% used.

- **What it reads.** An rclone crypt backup with one object per file, laid out as
  `<prefix>/<source name>/<path under that source's folder>`. Which remote that is, which keychain item holds its
  password and which folders are its sources are site values in `tv-server/cloud-source.json` in the server's data
  folder (shape in `src/cloud-source.js`, `openCloudSource`). Nothing in this repository names a real one.
- **The cache.** `createMediaCache` takes `remote`: `async (file, start, length) => Buffer`, asked only when the
  source file cannot be opened (`ENOENT`/`ENOTDIR`). A file that is on a drive never touches it. Blocks keep the
  same identity (path, size, mtime), so whatever was cached while a file was on the drive still plays after it
  leaves. The caller passes `size` and `mtimeMs` for a file that is not there. `stats().remoteReads` counts.
- **Reads go by folder.** A file's folder is looked up once (its path encrypted locally, its parent listed on the
  plain remote, the id taken) and addressed by id afterwards; ids are kept in `cloud-folder-ids.json` beside the
  catalogue. Measured on a real backup over a link shared with other downloads: the first read in a folder 6.0 s
  including the lookup, then 3.6-5.4 s per 4 MiB block, three blocks at once in 7.7 s (about 12 Mbit/s), against
  11.6 s per block by path. A 4 MiB block is 32 s of video at 1 Mbit/s and 8 s at 4 Mbit/s.
- **The catalogue lists cloud-held titles.** `shuffler/make_shuffler.py` reads `cloud-manifest.json` beside the
  catalogue (`--cloud-manifest` overrides): `{absolute path: {size, mtime (ns), duration}}`. A manifest path that
  is not on its drive is added under its root or pick exactly as its file would be, marked `cloud: {size, mtime}`.
  Paths are compared by real path. A file that is on the drive is always listed from the drive, and a root whose
  drive is away is still offline: the manifest never stands in for a missing drive.
  `record_cloud(manifest, probe_cache_entries, paths)` copies what the probe cache knows into the manifest. The
  manifest is part of the signature that decides whether the server rebuilds its catalogue.
- **The server plays them.** `readCatalogue` turns the marker into `cloud: {size, mtimeMs}` (`mtimeMsFromNs`
  reproduces the number `fs.stat` reports, tested against real files). `/media` passes it to `streamFile`, which
  uses it when the file is not there; a missing file with no marker is still "This video is offline". The warm-up
  pass uses the marker too.
- **Openings store.** `createMediaCache({ openings: { directory, seconds, maxBytes } })` is a second store that
  trim never touches. `bin/hold-openings.js --openings-dir DIR --shelf NAME` fills it for a shelf (the first
  `seconds` of each title and its last block; `--plan` sizes it first; `--cloud-source` rebuilds from the cloud
  copy), and the server reads it with `--openings-dir DIR`. For a library of 1,365 titles and 500 GB that was
  26 GB at 60 s each and 16 GB at 30 s.
- **Trips.** `scripts/trip_list.py --from <hub> --gb N --out trip.json` makes the list to a size (copies nothing);
  `scripts/copy_holiday_library.sh <drive> --from <hub> --list trip.json` packs it from wherever the hub's library
  is, never taking the travel drive over 75% used.
- **Proven against a real backup, 22 Nov:** reads through the decrypt layer returned bytes that begin as an MP4
  (`ftyp`), by path and by folder id. A byte-for-byte comparison with the drive copy is still owed.
- **The order for moving a shelf off a drive**, once the cloud holds it and the backup tool leaves held objects in
  place: hold its openings (`hold-openings.js`); `record_cloud`; move nothing it reports as skipped; leave every
  root folder in place (a missing root means "drive away" and stops the whole build; an empty one is a shelf in
  the cloud, and is tested); only then move the files. Record and move inside one hold on that drive, so no
  backup run sees the files gone before the manifest names them. The manifest file must already exist (empty
  will do) before the first title leaves: a backup tool that reads it decides by the file whether to look.
- **Moving a shelf is one command.** `scripts/shelf_to_cloud.py plan` is read-only: per shelf, how many files the
  cloud copy holds at the same size (listed through the reader's own remote, not taken from a backup receipt).
  `scripts/shelf_to_cloud.py move --shelf NAME --openings-dir DIR --yes` follows the order above for one shelf and
  refuses a shelf that stays whole (kids' shelves, music), a hub with no manifest file, and any file not in the
  cloud at the same size, not probed, or changed since the check. Files go to the Bin, never deleted.
- **Not done:**
  1. Nothing has left a drive, and the mover has only run on test folders.
  2. The openings store: decided 22 Nov as a folder on the hub drive the shelves leave, outside the library,
     30 s per title, filled shelf by shelf as each shelf moves, left out of backups. Not created yet.
  3. Switching it on at the hub: a deploy, `cloud-source.json`, and `--cloud-source` / `--openings-dir` in the
     server's launchd job. Nothing on this branch runs yet.
  4. Paths are mapped by absolute path, so this works where the library sits at the backup's source paths.
     Another Mac serving the same titles needs its own `roots` mapping.
  5. Artwork and scene stills are read from the file: for a cloud-held title they have to be made before the file
     leaves, or fetched once through the cache.
  6. The trip packer does not fetch a title that is only in the cloud; it names it and leaves it out. Packing
     over ssh with the hub's disk-slot wrapper has not been run for real.
  7. Persistent reader (23 Nov 2026): `openCloudSource` now defaults to `serve: true` (`rclone serve http` on
     `127.0.0.1:<ephemeral>` with env-only random Basic Auth, `--read-only --dir-cache-time 24h
     --vfs-read-chunk-size 4M --vfs-read-chunk-size-limit 32M`), falling back to per-block `rclone cat` if the
     daemon is unavailable (`"serve": false` in `cloud-source.json` opts out).
  8. With the internet down only what is whole on a drive, or already held, plays.
