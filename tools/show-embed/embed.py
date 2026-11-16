#!/usr/bin/env python3
"""Local, incremental show embeddings. Hash mode needs only the standard library."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
from typing import Protocol, Sequence

DEFAULT_STATE = Path.home() / '.local/state/onto-tv-embed'
DEFAULT_MODEL = 'BAAI/bge-small-en-v1.5'
TEXT_LIMIT = 1500


def clean(value) -> str:
    return ' '.join(str(value).split()) if isinstance(value, (str, int)) else ''


def genres(value) -> list[str]:
    if isinstance(value, str):
        value = value.split(',')
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        label = clean(item.get('label')) if isinstance(item, dict) else clean(item)
        # Stage 1 currently stores raw Wikidata IDs, which carry no semantic meaning.
        if label and label != '\\N' and not re.fullmatch(r'Q\d+', label):
            result.append(label)
    return result


def build_text(meta: dict) -> str:
    wiki = meta.get('wikipedia') or {}
    imdb = meta.get('imdb') or {}
    wd = meta.get('wikidata') or wiki.get('wikidata') or {}
    labels = list(dict.fromkeys(genres(wd.get('genres')) + genres(imdb.get('genres'))))
    parts = [clean(meta.get('name')), clean(meta.get('kind'))]
    if labels:
        parts.append('Genres: ' + ', '.join(labels))
    summary = clean(wiki.get('summary')) or clean(wiki.get('extract'))
    parts.append(summary[:850])
    imdb_parts = genres(imdb.get('genres'))
    year = clean(imdb.get('startYear'))
    if year and year != '\\N':
        imdb_parts.append(year)
    if imdb_parts:
        parts.append('IMDb: ' + ', '.join(imdb_parts))
    youtube = meta.get('youtube') or {}
    descriptions = youtube.get('descriptions', []) if isinstance(youtube, dict) else youtube
    for item in descriptions[:2]:
        parts.append(clean(item.get('description') if isinstance(item, dict) else item)[:250])
    return '. '.join(part.rstrip('. ') for part in parts if part).strip()[:TEXT_LIMIT].rstrip()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Backend(Protocol):
    """Identity must change whenever encoding semantics or dimensions change."""
    identity: dict
    dims: int

    def encode(self, texts: Sequence[str]) -> Sequence[Sequence[float]]: ...


class HashBackend:
    dims = 384
    identity = {'backend': 'hash', 'model': 'sha256-token-v1', 'dims': dims}

    def encode(self, texts):
        vectors = []
        for text in texts:
            vector = [0.0] * self.dims
            for token in re.findall(r'\w+', text.casefold()):
                digest = hashlib.sha256(token.encode()).digest()
                vector[int.from_bytes(digest[:4], 'little') % self.dims] += 1 if digest[4] & 1 else -1
            if not any(vector):
                vector[0] = 1.0
            vectors.append(vector)
        return vectors


class SentenceBackend:
    def __init__(self, model=DEFAULT_MODEL, device='cpu', batch_size=32):
        self.model_name, self.device, self.batch_size = model, device, batch_size
        self.dims = 384 if model == DEFAULT_MODEL else None
        self.identity = {'backend': 'sentence-transformers', 'model': model}
        self._model = None

    def encode(self, texts):
        if self._model is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as exc:
                raise ValueError('Install tools/show-embed/requirements.txt in the embedding venv.') from exc
            self._model = SentenceTransformer(self.model_name, device=self.device)
            self.dims = self._model.get_sentence_embedding_dimension()
        return self._model.encode(list(texts), batch_size=self.batch_size,
                                  normalize_embeddings=True, show_progress_bar=False)


def normalized(vector, dims):
    values = [float(x) for x in vector]
    if len(values) != dims or not all(math.isfinite(x) for x in values):
        raise ValueError('Backend returned invalid dimensions or non-finite values')
    norm = math.sqrt(sum(x * x for x in values))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError('Backend returned a zero or invalid vector')
    return [x / norm for x in values]


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


@contextmanager
def locked(state: Path):
    state.mkdir(parents=True, exist_ok=True)
    with (state / '.embed.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def load_store(directory: Path):
    """Validate the manifest before trusting row offsets or reusing cached vectors."""
    manifest = json.loads((directory / 'manifest.json').read_text())
    raw = (directory / 'shows.f32').read_bytes()
    index = (directory / 'shows-index.jsonl').read_bytes()
    if sha(raw) != manifest['vectors_sha'] or sha(index) != manifest['index_sha']:
        raise ValueError('Vector store checksum mismatch; rerun embed to rebuild')
    rows = [json.loads(line) for line in index.splitlines()]
    dims = manifest['dims']
    if not isinstance(dims, int) or dims < 1 or len(raw) != len(rows) * dims * 4:
        raise ValueError('Invalid vector store dimensions')
    if len({row['slug'] for row in rows}) != len(rows) or any(row['dims'] != dims for row in rows):
        raise ValueError('Invalid vector index')
    vectors = list(struct.iter_unpack(f'<{dims}f', raw))
    for vector in vectors:
        if not all(math.isfinite(x) for x in vector) or abs(sum(x*x for x in vector) - 1) > 1e-5:
            raise ValueError('Invalid stored vector norm')
    return rows, vectors, manifest


def embed(meta_dir: Path, state: Path, backend: Backend):
    if not meta_dir.is_dir():
        raise ValueError(f'Metadata directory not found: {meta_dir}')
    records = []
    seen = set()
    for path in sorted(meta_dir.glob('*.json')):
        meta = json.loads(path.read_text())
        slug = clean(meta.get('slug')) or path.stem
        name, kind = clean(meta.get('name')), clean(meta.get('kind'))
        if not name or slug in seen:
            raise ValueError(f'Missing name or duplicate slug in {path}')
        seen.add(slug)
        text = build_text(meta)
        records.append(({'slug': slug, 'name': name, 'kind': kind, 'text_sha': sha(text.encode())}, text))
    directory = state / 'vectors'
    cached = {}
    dims = backend.dims
    try:
        old_rows, old_vectors, manifest = load_store(directory)
        if manifest['identity'] == backend.identity:
            cached = {row['slug']: (row, vector) for row, vector in zip(old_rows, old_vectors)}
            dims = manifest['dims']
    except (OSError, ValueError, KeyError, TypeError):
        pass  # A missing/interrupted/corrupt generation is rebuilt from metadata.
    changed = [(row, text) for row, text in records
               if row['slug'] not in cached or cached[row['slug']][0]['text_sha'] != row['text_sha']]
    encoded = list(backend.encode([text for _, text in changed])) if changed else []
    if len(encoded) != len(changed):
        raise ValueError('Backend returned the wrong number of vectors')
    if encoded:
        dims = backend.dims
    dims = dims or 384  # Empty corpus has no vectors, including with a custom model.
    fresh = {row['slug']: normalized(vector, dims) for (row, _), vector in zip(changed, encoded)}
    rows, vectors = [], []
    for row, _ in records:
        rows.append(dict(row, dims=dims))
        vectors.append(fresh[row['slug']] if row['slug'] in fresh else cached[row['slug']][1])
    raw = b''.join(struct.pack(f'<{dims}f', *vector) for vector in vectors)
    index = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows).encode()
    manifest = {'identity': backend.identity, 'dims': dims, 'vectors_sha': sha(raw), 'index_sha': sha(index)}
    # Commit marker last: interrupted multi-file writes are detected on the next read.
    atomic_write(directory / 'shows.f32', raw)
    atomic_write(directory / 'shows-index.jsonl', index)
    atomic_write(directory / 'manifest.json', json.dumps(manifest).encode())
    return len(changed), len(records) - len(changed)


def nearest(rows, vectors, source, k):
    scores = [(i, max(-1.0, min(1.0, sum(a*b for a, b in zip(vectors[source], vector)))))
              for i, vector in enumerate(vectors) if i != source]
    return sorted(scores, key=lambda pair: (-pair[1], rows[pair[0]]['slug']))[:k]


def lookup(rows, name):
    # Exact slug disambiguates identical display names.
    for i, row in enumerate(rows):
        if row['slug'] == name:
            return i
    matches = [i for i, row in enumerate(rows) if row['name'].casefold() == name.casefold()]
    if len(matches) != 1:
        raise ValueError(f'Show {name!r}: ' + ('name is ambiguous; use a slug' if matches else 'not found'))
    return matches[0]


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('must be at least 1')
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    # Common flags work both before and after the subcommand.
    def options(p, suppressed=False):
        default = argparse.SUPPRESS if suppressed else DEFAULT_STATE
        p.add_argument('--state-dir', type=Path, default=default)
    options(parser)
    parser.add_argument('--backend', choices=['sentence-transformers', 'hash'], default='sentence-transformers')
    sub = parser.add_subparsers(dest='command', required=True)
    build = sub.add_parser('embed', help='embed new or changed show text')
    options(build, True)
    build.add_argument('--backend', choices=['sentence-transformers', 'hash'], default=argparse.SUPPRESS)
    build.add_argument('--meta-dir', type=Path)
    build.add_argument('--model', default=DEFAULT_MODEL)
    build.add_argument('--device', choices=['cpu', 'mps'], default='cpu')
    build.add_argument('--batch-size', type=positive, default=32)
    neighbours = sub.add_parser('neighbours', help='rank similar shows')
    options(neighbours, True)
    neighbours.add_argument('name')
    neighbours.add_argument('-k', type=positive, default=12)
    export = sub.add_parser('export', help='write the top 24 neighbours per show')
    options(export, True)
    args = parser.parse_args(argv)
    try:
        with locked(args.state_dir):
            if args.command == 'embed':
                backend = HashBackend() if args.backend == 'hash' else SentenceBackend(args.model, args.device, args.batch_size)
                changed, reused = embed(args.meta_dir or args.state_dir / 'meta', args.state_dir, backend)
                print(f'{changed} embedded · {reused} reused')
            else:
                rows, vectors, _ = load_store(args.state_dir / 'vectors')
                if args.command == 'neighbours':
                    source = lookup(rows, args.name)
                    for i, score in nearest(rows, vectors, source, args.k):
                        print(f'{score: .4f}  {rows[i]["name"]}  [{rows[i]["slug"]}]')
                else:
                    space = {row['slug']: {'name': row['name'], 'kind': row['kind'],
                             'next': [[rows[j]['slug'], score] for j, score in nearest(rows, vectors, i, 24)]}
                             for i, row in enumerate(rows)}
                    atomic_write(args.state_dir / 'show-space.json', json.dumps(space, ensure_ascii=False, allow_nan=False).encode())
                    print(f'{len(space)} shows · {args.state_dir / "show-space.json"}')
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
