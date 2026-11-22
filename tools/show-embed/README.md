# Show embeddings — stage 2

Reads Stage 1's `meta/<slug>.json`, builds a short description, and embeds it
locally. Python 3.11+; no hosted embedding API. The default model is
`BAAI/bge-small-en-v1.5` (384 dimensions). CPU is the default; `--device mps`
selects Apple Silicon GPU acceleration.

## Run on the M2

From the Onto the TV checkout on the M2, check the connection before installing
packages or downloading the model:

```bash
link-meter status
test ! -e ~/.local/state/METERED_LINK
```

Continue only if the marker is absent. If it exists, wait until the owner removes
it. Installation and the first real embedding run download packages/model weights;
use the M2's fibre connection. Later runs use the local model cache.

```bash
python3 -m venv ~/.local/state/onto-tv-embed/venv
~/.local/state/onto-tv-embed/venv/bin/python -m pip install -r tools/show-embed/requirements.txt
heavy-slot -- ~/.local/state/onto-tv-embed/venv/bin/python tools/show-embed/embed.py embed
```

For MPS, append `--device mps`. On battery, wrap the embedding command in
`power-pause --`. Use `--batch-size 16` if memory is tight (default 32).

```bash
~/.local/state/onto-tv-embed/venv/bin/python tools/show-embed/embed.py neighbours "South Park" -k 12
~/.local/state/onto-tv-embed/venv/bin/python tools/show-embed/embed.py export
```

Neighbour lookup accepts a case-insensitive exact name or an exact slug. Use a slug
if two shows share a name. Each output row contains cosine, name, and slug; the
query show is excluded. Export includes up to 24 other shows per show, sorted by
descending cosine, with slug ordering to break ties. It does not update the server.
Run `export` again after updating embeddings.

## Files and incremental updates

Default root: `~/.local/state/onto-tv-embed`. Override with `--state-dir PATH`
before or after the subcommand. `embed --meta-dir PATH` overrides only the input.

- `meta/*.json`: Stage 1 input; filename stem supplies a missing slug.
- `vectors/shows.f32`: contiguous row-major **little-endian float32**, unit vectors.
- `vectors/shows-index.jsonl`: matching rows, each with `slug`, `name`, `kind`,
  `text_sha` (SHA-256 of UTF-8 embedding text), and `dims`.
- `vectors/manifest.json`: backend/model identity, dimensions, and checksums.
- `show-space.json`: `{ "slug": { "name": "...", "kind": "...", "next": [["other-slug", 0.87]] } }`.

Text order: name, kind, readable Wikidata/IMDb genres, Wikipedia summary (or
extract), IMDb genres/year, then the first two YouTube descriptions. Whitespace
is collapsed, empty fields are skipped, the summary is limited to 850 characters,
each YouTube description to 250, and the whole text to 1,500. Both top-level and
`wikipedia.wikidata` fields are supported. Raw Wikidata QIDs are omitted; labels
are accepted as strings or `{ "label": "Comedy" }`. Tiers, ratings, timestamps,
URLs, and other collection bookkeeping do not affect the embedding.

Only new/changed text is encoded; existing vectors are reused by slug and text
hash. Removed metadata files disappear from the next index. Changing backend or
`--model MODEL_OR_LOCAL_PATH` rebuilds all vectors. For a model path, keep its
contents immutable or change the path when replacing weights. CPU/MPS and batch
size changes reuse cached vectors. A no-change run never loads the model.

The CLI serializes readers/writers with a state-directory lock. Individual files
are replaced atomically, with the checksum manifest written last. A partial or
corrupt generation is rejected by queries and rebuilt by the next `embed` run.
External readers of the binary pair should also validate the manifest or take
the lock; the TV's exported JSON is a single atomic file.

A missing metadata directory is an error; an existing empty one intentionally
produces an empty index/export. Malformed metadata fails the run before publishing
new vectors. No metadata or model files are deleted.

## Offline tests

The hash backend is deterministic token hashing, useful for plumbing tests only;
its similarities are not semantic model quality. It uses no third-party packages.
Keep test state separate from real embeddings:

```bash
python3 -S -m unittest discover -s tools/show-embed -v
python3 -S tools/show-embed/embed.py --state-dir /tmp/onto-tv-embed-demo embed --backend hash --meta-dir tools/show-embed/fixtures
python3 -S tools/show-embed/embed.py --state-dir /tmp/onto-tv-embed-demo neighbours "Space School"
python3 -S tools/show-embed/embed.py --state-dir /tmp/onto-tv-embed-demo export
```

Tests run in temporary directories with fixture metadata, including subprocesses
with site-packages disabled. No models are downloaded. Coverage includes text
limits, deterministic bytes, normalization, incremental reuse, deletion/addition,
backend changes, corrupt stores, failed encodes, ranking, and the export limit.

To add a backend, implement `identity`, `dims`, and `encode(texts)` (see the
`Backend` protocol). Update identity whenever encoding semantics change. The
writer validates and normalizes every newly encoded vector before publishing.
