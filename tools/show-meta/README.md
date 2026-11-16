# Show metadata harvester

Stage 1 of show embeddings for Onto the TV: collect text metadata per distinct show
(Wikipedia, Wikidata, IMDb, and paced YouTube descriptions) without sending video to
an LLM.

## Requirements

- Python 3.11+ on the M2 (`python3 --version`)
- `requests` (`python3 -m pip install --user requests`)
- `yt-dlp` on `PATH` when harvesting YouTube-backed shows (optional for Wikipedia/IMDb-only runs)

## Paths

| Path | Purpose |
|------|---------|
| `~/.local/state/onto-tv/channels.html` | Default catalogue (same `const VIDEOS` block as the TV server) |
| `~/.local/state/onto-tv-embed/meta/<slug>.json` | One metadata file per show |
| `~/.local/state/onto-tv-embed/imdb/` | Cached IMDb `title.basics` / `title.ratings` TSV.gz (downloaded once) |
| `~/.local/state/onto-tv-embed/logs/harvest.log` | Run log |

## Run on the M2 (fibre)

Preview what would be harvested (no network writes except reading the catalogue):

```bash
cd ~/Projects/onto-the-tv/tools/show-meta
python3 harvest.py --dry-run
```

Harvest up to five shows, resuming where prior JSON is already fresh (< 30 days):

```bash
python3 harvest.py --limit 5
```

Force refresh and write into a custom output dir:

```bash
python3 harvest.py --refresh --meta-dir ~/.local/state/onto-tv-embed/meta-test --limit 3
```

Point at a specific catalogue export:

```bash
python3 harvest.py --catalogue ~/.local/state/onto-tv/channels.html
```

YouTube descriptions are paced at **one `yt-dlp` call per 20 seconds**. If output
contains `Sign in to confirm`, the run **stops** so you can retry later without
burning the account.

## Tests (offline)

```bash
cd ~/Projects/onto-the-tv/tools/show-meta
python3 -m unittest -v
```

Fixtures under `fixtures/` stand in for Wikipedia, IMDb, and catalogue data; tests mock
`yt-dlp`. Do not point unit tests at the live library or the public internet.

## Output shape (per show)

Each `<slug>.json` includes `name`, `kind` (series / film / music artist / youtube channel),
`wikipedia` (summary, URL, match confidence), `imdb` (when matched), optional `youtube.descriptions`,
and `harvestedAt` (UTC ISO timestamp).