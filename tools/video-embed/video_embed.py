#!/usr/bin/env python3
"""Progressive multimodal video embeddings for Onto the TV (gemini-embedding-2 Batch API).

Climbs a quality ladder automatically while staying strictly within a daily spend cap
(default $5.00/day Perth date, fail-closed spend.json + flock):

  Tier 1 (text)   : title, show/channel, show-meta summaries, and sidecar .srt/.vtt excerpts
                    ($0.10 / 1M tokens Batch -> < $1 for the entire library)
  Tier 2 (vision) : representative keyframes (8/ep, 16/movie, <=384px JPEG = 258 tok/frame)
                    ($0.225 / 1M tokens Batch -> ~$2-3 for the entire library)
  Tier 3 (audio)  : up to 3x80s MP3 clips at 20%/50%/80% (same windows as music-core/embed)
                    ($0.00008 / sec Batch -> movies first, then watched/liked, TV, shorts)

Vectors land in the exact same 3072-dim gemini-embedding-2 space as 6IAN music.
Also aligns and fuses local 768-dim EmbeddingGemma 2 vectors (gemma_embed.py) into a
single video-space.json consumed by src/video-space.js and src/tv-server.js.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

VECTOR_DIM = 3072
DEFAULT_MODEL = "gemini-embedding-2"
DEFAULT_CAP_USD = 5.0

# Gemini Embedding 2 Batch API rates (50% off Standard)
TEXT_BATCH_USD_PER_MTOK = 0.10
IMAGE_BATCH_USD_PER_MTOK = 0.225
IMAGE_TOKENS_PER_FRAME = 258
AUDIO_BATCH_USD_PER_SEC = 0.00008
VIDEO_CLIP_MAX_SEC = 24.0
VIDEO_CLIP_BATCH_USD_PER_SEC = 0.0018  # conservative 300 tok/s @ $6/1M Batch (~$0.0432 per 24s scene clip)

CLIP_MAX_SEC = 80.0
SHARD_MAX_BYTES = int(1.5 * 1024 * 1024 * 1024)
MAX_SUBTITLE_CHARS = 3500
MAX_TEXT_CHARS = 5000

INFLIGHT_STATES = ("SUBMITTED", "PENDING", "RUNNING", "SUCCEEDED")
PERTH_TZ = timezone(timedelta(hours=8))

DEFAULT_APP_SUPPORT = Path.home() / "Library/Application Support/Onto the TV"
DEFAULT_LIBRARY = DEFAULT_APP_SUPPORT / "library.json"
DEFAULT_SOURCES = DEFAULT_APP_SUPPORT / "kids-sources.json"
DEFAULT_HISTORY = DEFAULT_APP_SUPPORT / "playback-history.json"
DEFAULT_SHOW_META = Path.home() / ".local/state/onto-tv-embed/meta"
DEFAULT_STATE = Path.home() / ".local/state/onto-tv-video-embed"
DEFAULT_CAP_OVERRIDE = Path.home() / ".config/onto-the-tv/video-embed-cap-override.json"
DEFAULT_FFMPEG = "/opt/homebrew/bin/ffmpeg"

# Fusion weights across tiers (renormalised via L2 norm to whichever tiers exist for a video)
TIER_WEIGHTS = {1: 0.22, 2: 0.33, 3: 0.25, 4: 0.20}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def perth_today(now: datetime | None = None) -> str:
    dt = now or datetime.now(timezone.utc)
    return dt.astimezone(PERTH_TZ).strftime("%Y-%m-%d")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as fh:
        tmp = Path(fh.name)
        try:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj: Any) -> None:
    atomic_write(path, (json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))


# ---------- Vector store (little-endian float32 memmap + JSONL index) ----------

def l2_normalize(vec: Sequence[float], dims: int | None = None) -> list[float]:
    vals = [float(x) for x in vec]
    if dims is not None and len(vals) != dims:
        raise ValueError(f"expected {dims} dims, got {len(vals)}")
    if not vals or not all(math.isfinite(x) for x in vals):
        raise ValueError("non-finite or empty vector")
    norm = math.sqrt(sum(x * x for x in vals))
    if norm <= 0 or not math.isfinite(norm):
        raise ValueError("zero-norm vector")
    return [x / norm for x in vals]


def mean_normalize(vectors: Sequence[Sequence[float]], dims: int) -> list[float]:
    if not vectors:
        raise ValueError("empty vector list")
    acc = [0.0] * dims
    for v in vectors:
        if len(v) != dims:
            raise ValueError(f"vector dim mismatch: {len(v)} != {dims}")
        for i, x in enumerate(v):
            acc[i] += float(x)
    return l2_normalize(acc, dims)


def load_vectors(directory: Path, prefix: str, expected_dims: int | None = None) -> tuple[list[dict[str, Any]], list[list[float]], int]:
    idx_path = directory / f"{prefix}-index.jsonl"
    f32_path = directory / f"{prefix}.f32"
    if not idx_path.is_file() or not f32_path.is_file():
        return [], [], expected_dims or VECTOR_DIM
    rows = [json.loads(line) for line in idx_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        return [], [], expected_dims or VECTOR_DIM
    dims = int(rows[0].get("dims") or expected_dims or VECTOR_DIM)
    raw = f32_path.read_bytes()
    if len(raw) != len(rows) * dims * 4:
        raise ValueError(f"corrupt vector store {f32_path}: {len(raw)} != {len(rows)} * {dims} * 4")
    vecs = [list(v) for v in struct.iter_unpack(f"<{dims}f", raw)]
    return rows, vecs, dims


def save_vectors(directory: Path, prefix: str, rows: Sequence[dict[str, Any]], vecs: Sequence[Sequence[float]], dims: int) -> None:
    if len(rows) != len(vecs):
        raise ValueError("rows/vecs length mismatch")
    directory.mkdir(parents=True, exist_ok=True)
    raw = b"".join(struct.pack(f"<{dims}f", *l2_normalize(v, dims)) for v in vecs)
    idx = "".join(json.dumps({**r, "dims": dims}, ensure_ascii=False) + "\n" for r in rows).encode("utf-8")
    atomic_write(directory / f"{prefix}.f32", raw)
    atomic_write(directory / f"{prefix}-index.jsonl", idx)


def merge_tier_vectors(
    directory: Path,
    prefix: str,
    new_rows: Sequence[dict[str, Any]],
    new_vecs: Sequence[Sequence[float]],
    dims: int,
) -> int:
    old_rows, old_vecs, _ = load_vectors(directory, prefix, expected_dims=dims)
    by_id: dict[str, tuple[dict[str, Any], list[float]]] = {
        r["id"]: (r, v) for r, v in zip(old_rows, old_vecs)
    }
    added = 0
    for r, v in zip(new_rows, new_vecs):
        if r["id"] not in by_id:
            added += 1
        by_id[r["id"]] = (r, l2_normalize(v, dims))
    ordered_ids = sorted(by_id)
    save_vectors(
        directory,
        prefix,
        [by_id[i][0] for i in ordered_ids],
        [by_id[i][1] for i in ordered_ids],
        dims,
    )
    return added


def rebuild_fused_vectors(directory: Path, dims: int) -> dict[str, dict[str, Any]]:
    """Fuse tier1..tier4 vectors per canonical video id into fused.f32."""
    by_id: dict[str, dict[int, tuple[dict[str, Any], list[float]]]] = {}
    for tier in (1, 2, 3, 4):
        rows, vecs, _ = load_vectors(directory, f"tier{tier}", expected_dims=dims)
        for r, v in zip(rows, vecs):
            by_id.setdefault(r["id"], {})[tier] = (r, v)
    fused_rows: list[dict[str, Any]] = []
    fused_vecs: list[list[float]] = []
    meta_out: dict[str, dict[str, Any]] = {}
    for vid in sorted(by_id):
        tiers = by_id[vid]
        acc = [0.0] * dims
        wsum = 0.0
        sample_row: dict[str, Any] = {}
        for t, (r, v) in sorted(tiers.items()):
            w = TIER_WEIGHTS.get(t, 0.25)
            for i, x in enumerate(v):
                acc[i] += w * x
            wsum += w
            sample_row = r
        if wsum <= 0:
            continue
        vec = l2_normalize(acc, dims)
        row = {
            "id": vid,
            "src": sample_row.get("src", ""),
            "aliases": sample_row.get("aliases") or ([sample_row["src"]] if sample_row.get("src") else []),
            "title": sample_row.get("title", ""),
            "channel": sample_row.get("channel", ""),
            "tier": max(tiers),
            "tiers": sorted(tiers),
            "dims": dims,
        }
        fused_rows.append(row)
        fused_vecs.append(vec)
        meta_out[vid] = row
    if fused_rows:
        save_vectors(directory, "fused", fused_rows, fused_vecs, dims)
    return meta_out


# ---------- Library resolution & deduplication ----------

def build_path_resolver(sources_path: Path):
    """Map Onto the TV library.json `src` strings to real filesystem paths using kids-sources.json."""
    cfg = read_json(sources_path, {}) or {}
    roots_by_label: dict[str, list[Path]] = {}
    for r in cfg.get("roots") or []:
        p = r.get("path")
        if p:
            roots_by_label.setdefault(str(r.get("label") or ""), []).append(Path(p))
    picks_by_key: dict[tuple[str, str], Path] = {}
    picks_by_name: dict[str, Path] = {}
    for pk in cfg.get("picks") or []:
        p = pk.get("path")
        if not p:
            continue
        pp = Path(p)
        show = str(pk.get("show") or "")
        if show:
            picks_by_key[(show, pp.name)] = pp
        picks_by_name.setdefault(pp.name, pp)

    def resolve_src(src: str) -> Path | None:
        if not src:
            return None
        if "/" in src:
            head, tail = src.split("/", 1)
            if head in roots_by_label:
                for root in roots_by_label[head]:
                    cand = root / tail
                    if cand.exists():
                        return cand
                return roots_by_label[head][0] / tail
            if (head, Path(tail).name) in picks_by_key:
                return picks_by_key[(head, Path(tail).name)]
        base = Path(src).name
        if base in picks_by_name:
            return picks_by_name[base]
        for root in roots_by_label.get("", []):
            cand = root / src
            if cand.exists():
                return cand
        if roots_by_label.get(""):
            return roots_by_label[""][0] / src
        return None

    return resolve_src


def load_canonical_videos(
    library_path: Path,
    sources_path: Path,
    history_path: Path | None = None,
) -> list[dict[str, Any]]:
    """Load library.json, resolve real paths, and deduplicate alias roots (e.g. 'sitcoms' + 'sitcoms (Stash)')."""
    doc = read_json(library_path, {})
    raw_videos = doc.get("videos", []) if isinstance(doc, dict) else (doc if isinstance(doc, list) else [])
    resolver = build_path_resolver(sources_path)

    watched_srcs: set[str] = set()
    if history_path and history_path.is_file():
        h = read_json(history_path, {})
        if isinstance(h, dict):
            for k in ("finished", "places", "watched", "likes"):
                v = h.get(k)
                if isinstance(v, dict):
                    watched_srcs.update(v.keys())
                elif isinstance(v, list):
                    for item in v:
                        if isinstance(item, str):
                            watched_srcs.add(item)
                        elif isinstance(item, dict) and item.get("src"):
                            watched_srcs.add(str(item["src"]))

    by_canon: dict[str, dict[str, Any]] = {}
    for v in raw_videos:
        if not isinstance(v, dict) or not v.get("src"):
            continue
        src = str(v["src"])
        real_path = resolver(src)
        canon_key = str(real_path) if real_path is not None else f"src:{src}"
        vid = sha256_text(canon_key)
        dur = float(v.get("duration") or 0.0)
        if vid in by_canon:
            entry = by_canon[vid]
            if src not in entry["aliases"]:
                entry["aliases"].append(src)
            if src in watched_srcs:
                entry["watched"] = True
            # Prefer non-"(Stash)" canonical display src
            if "(Stash)" in entry["src"] and "(Stash)" not in src:
                entry["src"] = src
            continue
        by_canon[vid] = {
            "id": vid,
            "src": src,
            "aliases": [src],
            "path": str(real_path) if real_path is not None else "",
            "title": str(v.get("title") or Path(src).stem),
            "channel": str(v.get("channel") or ""),
            "library_tier": str(v.get("tier") or ""),
            "duration": dur,
            "watched": src in watched_srcs,
        }
    return list(by_canon.values())


def priority_key(video: dict[str, Any]) -> tuple[int, int, float, str]:
    """Order videos so highest-value media upgrades first: Movies -> Watched -> TV/Long -> Shorts."""
    dur = float(video.get("duration") or 0.0)
    watched = 0 if video.get("watched") else 1
    if dur >= 3600:
        bucket = 0  # Movies
    elif watched == 0:
        bucket = 1  # Watched / liked shows & videos
    elif dur >= 900:
        bucket = 2  # TV / long episodes (15-60m)
    else:
        bucket = 3  # Shorts / kids / music videos
    return (bucket, watched, -dur, video["id"])


# ---------- Text, Subtitles, Keyframes, Audio Extraction ----------

def strip_subtitle_text(raw: str, max_chars: int = MAX_SUBTITLE_CHARS) -> str:
    """Turn SRT/VTT content into compact dialogue text sampled across beginning/middle/end."""
    lines: list[str] = []
    for ln in raw.replace("\r\n", "\n").splitlines():
        s = ln.strip()
        if not s or s.upper().startswith("WEBVTT") or s.isdigit() or "-->" in s:
            continue
        s = re.sub(r"<[^>]+>", "", s)
        s = re.sub(r"\{[^}]+\}", "", s)
        s = " ".join(s.split())
        if s:
            lines.append(s)
    if not lines:
        return ""
    joined = " ".join(lines)
    if len(joined) <= max_chars:
        return joined
    # Sample start, middle, end so we capture tone/plot without hitting token limits
    chunk = max_chars // 3
    mid = max(0, len(joined) // 2 - chunk // 2)
    return (joined[:chunk] + " ... " + joined[mid : mid + chunk] + " ... " + joined[-chunk:]).strip()


def find_sidecar_subtitle(video_path: Path) -> Path | None:
    if not video_path or not video_path.parent.is_dir():
        return None
    stem = video_path.stem
    cands: list[Path] = []
    try:
        for p in video_path.parent.iterdir():
            if not p.is_file() or p.suffix.lower() not in (".srt", ".vtt"):
                continue
            if p.stem == stem or p.stem.startswith(stem + "."):
                cands.append(p)
    except OSError:
        return None
    if not cands:
        return None
    # Prefer English or plain stem match
    cands.sort(key=lambda p: (0 if p.stem == stem or ".en" in p.name.lower() else 1, p.name))
    return cands[0]


def slugify(text: str) -> str:
    s = re.sub(r"\s*\((?:19|20)\d\d\)\s*$", "", str(text or "")).lower()
    s = re.sub(r"[^\w\s-]", "", s).strip()
    return re.sub(r"[\s-]+", "-", s).strip("-")


def build_tier1_text(video: dict[str, Any], show_meta_dir: Path | None = None, read_subtitles: bool = True) -> str:
    parts: list[str] = []
    title = video.get("title") or ""
    channel = video.get("channel") or ""
    lib_tier = video.get("library_tier") or ""
    dur = float(video.get("duration") or 0.0)
    kind = "Feature film" if dur >= 3600 else ("TV episode / long video" if dur >= 900 else "Short video")
    parts.append(f"Title: {title}")
    if channel:
        parts.append(f"Show / Channel: {channel}")
    parts.append(f"Category: {kind} ({round(dur / 60)} min)" + (f", section: {lib_tier}" if lib_tier else ""))

    if show_meta_dir and show_meta_dir.is_dir():
        for cand_name in (slugify(title), slugify(channel)):
            if not cand_name:
                continue
            mp = show_meta_dir / f"{cand_name}.json"
            if mp.is_file():
                meta = read_json(mp, {}) or {}
                wiki = meta.get("wikipedia") or {}
                imdb = meta.get("imdb") or {}
                summary = (wiki.get("summary") or wiki.get("extract") or "").strip()
                if summary:
                    parts.append("Summary: " + " ".join(summary.split())[:900])
                genres = imdb.get("genres")
                if genres:
                    parts.append("Genres: " + (", ".join(genres) if isinstance(genres, list) else str(genres)))
                break

    if read_subtitles and video.get("path"):
        vp = Path(video["path"])
        sub = find_sidecar_subtitle(vp)
        if sub is not None:
            try:
                sub_text = strip_subtitle_text(sub.read_text(encoding="utf-8", errors="ignore"))
                if sub_text:
                    parts.append("Dialogue excerpt: " + sub_text)
            except OSError:
                pass

    return "\n".join(p for p in parts if p).strip()[:MAX_TEXT_CHARS]


def keyframe_timestamps(duration: float, is_movie: bool | None = None) -> list[float]:
    """Representative timestamps skipping opening/closing 8% credits: 16 for movies, 8 for episodes/shorts."""
    d = float(duration)
    if d <= 0:
        return []
    movie = (d >= 3600.0) if is_movie is None else is_movie
    n = 16 if movie else (8 if d >= 120.0 else max(1, min(6, int(d // 15) or 1)))
    if n == 1:
        return [round(d * 0.5, 2)]
    start = d * 0.08
    end = d * 0.92
    step = (end - start) / (n - 1)
    return [round(start + i * step, 2) for i in range(n)]


def clip_windows(duration_seconds: float) -> list[tuple[float, float]]:
    """Same 3x80s audio windows as music-core/embed/embed.py (20%, 50%, 80%)."""
    d = float(duration_seconds)
    if d <= 0:
        return []
    if d <= CLIP_MAX_SEC:
        return [(0.0, d)]
    half = CLIP_MAX_SEC / 2.0
    windows: list[tuple[float, float]] = []
    for c in (0.2 * d, 0.5 * d, 0.8 * d):
        start = max(0.0, min(d - CLIP_MAX_SEC, c - half))
        end = min(d, start + CLIP_MAX_SEC)
        windows.append((start, end - start))
    return windows


def extract_keyframes_b64(video_path: Path, timestamps: Sequence[float], ffmpeg: str = DEFAULT_FFMPEG) -> list[str]:
    """Extract <=384px JPEG keyframes into a temporary dir and return base64 strings (zero leftover files)."""
    out: list[str] = []
    with tempfile.TemporaryDirectory(prefix="otv-kf-") as td:
        for idx, ts in enumerate(timestamps):
            jpg = Path(td) / f"f{idx:02d}.jpg"
            cmd = [
                ffmpeg, "-nostdin", "-v", "error", "-y",
                "-ss", f"{ts:.2f}", "-i", str(video_path),
                "-frames:v", "1",
                "-vf", "scale='min(384,iw)':'min(384,ih)':force_original_aspect_ratio=decrease",
                "-q:v", "5", str(jpg),
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=60, check=False)
            if r.returncode == 0 and jpg.is_file() and jpg.stat().st_size > 0:
                out.append(base64.b64encode(jpg.read_bytes()).decode("ascii"))
    return out


def extract_audio_clips_b64(video_path: Path, windows: Sequence[tuple[float, float]], ffmpeg: str = DEFAULT_FFMPEG) -> list[str]:
    """Extract mono 64k MP3 clips into a temporary dir and return base64 strings (zero leftover files)."""
    out: list[str] = []
    with tempfile.TemporaryDirectory(prefix="otv-aud-") as td:
        for idx, (start, dur) in enumerate(windows):
            mp3 = Path(td) / f"c{idx}.mp3"
            cmd = [
                ffmpeg, "-nostdin", "-v", "error", "-y",
                "-ss", f"{start:.2f}", "-t", f"{dur:.2f}",
                "-i", str(video_path),
                "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", str(mp3),
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=120, check=False)
            if r.returncode == 0 and mp3.is_file() and mp3.stat().st_size > 0:
                out.append(base64.b64encode(mp3.read_bytes()).decode("ascii"))
    return out


def video_clip_windows(duration_seconds: float) -> list[tuple[float, float]]:
    """Up to 3x24s scene windows (<=32 frames @ 1fps inside Gemini's 8,192-token multimodal window)."""
    d = float(duration_seconds)
    if d <= 0:
        return []
    if d <= VIDEO_CLIP_MAX_SEC * 1.5:
        dur = min(d, VIDEO_CLIP_MAX_SEC)
        return [(max(0.0, (d - dur) * 0.5), dur)]
    half = VIDEO_CLIP_MAX_SEC / 2.0
    windows: list[tuple[float, float]] = []
    for c in (0.25 * d, 0.50 * d, 0.75 * d):
        start = max(0.0, min(d - VIDEO_CLIP_MAX_SEC, c - half))
        end = min(d, start + VIDEO_CLIP_MAX_SEC)
        windows.append((start, end - start))
    return windows


def extract_video_clips_b64(video_path: Path, windows: Sequence[tuple[float, float]], ffmpeg: str = DEFAULT_FFMPEG) -> list[str]:
    """Extract compact 320p 1fps H.264 + mono AAC MP4 scene clips for joint audiovisual embedding."""
    out: list[str] = []
    with tempfile.TemporaryDirectory(prefix="otv-vid-") as td:
        for idx, (start, dur) in enumerate(windows):
            mp4 = Path(td) / f"v{idx}.mp4"
            cmd = [
                ffmpeg, "-nostdin", "-v", "error", "-y",
                "-ss", f"{start:.2f}", "-t", f"{dur:.2f}",
                "-i", str(video_path),
                "-vf", "fps=1,scale='min(320,iw)':-2",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-ac", "1", "-ar", "16000", "-b:a", "48k",
                "-movflags", "+faststart", str(mp4),
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=180, check=False)
            if r.returncode == 0 and mp4.is_file() and mp4.stat().st_size > 0:
                out.append(base64.b64encode(mp4.read_bytes()).decode("ascii"))
    return out


# ---------- Cost estimation & Spend Ledger (Perth day, fail-closed) ----------

def estimate_tier1_usd(text: str) -> float:
    est_tokens = max(16.0, len(text) / 3.5)
    return est_tokens * TEXT_BATCH_USD_PER_MTOK / 1e6


def estimate_tier2_usd(num_frames: int) -> float:
    return num_frames * IMAGE_TOKENS_PER_FRAME * IMAGE_BATCH_USD_PER_MTOK / 1e6


def estimate_tier3_usd(duration: float) -> float:
    return sum(w[1] for w in clip_windows(duration)) * AUDIO_BATCH_USD_PER_SEC


def estimate_tier4_usd(duration: float) -> float:
    return sum(w[1] for w in video_clip_windows(duration)) * VIDEO_CLIP_BATCH_USD_PER_SEC


def current_cap_usd(cap_arg: float | None = None, override_path: Path = DEFAULT_CAP_OVERRIDE) -> float:
    if cap_arg is not None:
        return float(cap_arg)
    env_cap = os.environ.get("ONTO_VIDEO_EMBED_CAP_USD")
    if env_cap:
        return float(env_cap)
    ov = read_json(override_path, {})
    if isinstance(ov, dict) and ov.get("perth_date") == perth_today() and "usd" in ov:
        return float(ov["usd"])
    for cand in (Path.home() / "Projects/music-core/embed", Path.home() / "Projects/glancebar/tools/music-embed"):
        if (cand / "budget.py").is_file():
            try:
                if str(cand) not in sys.path:
                    sys.path.insert(0, str(cand))
                import budget as _gemini_budget
                return float(_gemini_budget.lane_daily_cap_usd("tv"))
            except Exception:
                pass
    return DEFAULT_CAP_USD


@contextlib.contextmanager
def spend_locked(gemini_dir: Path):
    gemini_dir.mkdir(parents=True, exist_ok=True)
    with (gemini_dir / "spend.lock").open("a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield


def init_spend_ledger(gemini_dir: Path) -> Path:
    p = gemini_dir / "spend.json"
    if not p.is_file():
        write_json(p, {"days": {}, "log": []})
    return p


def spent_today_usd(gemini_dir: Path, day: str | None = None) -> float:
    doc = read_json(gemini_dir / "spend.json")
    if not isinstance(doc, dict):
        raise RuntimeError(f"spend ledger missing: {gemini_dir / 'spend.json'} (run `spend --init`)")
    d = day or perth_today()
    return float((doc.get("days") or {}).get(d, 0.0))


def reserve_spend(gemini_dir: Path, usd: float, cap_usd: float, note: str) -> float:
    day = perth_today()
    with spend_locked(gemini_dir):
        p = gemini_dir / "spend.json"
        doc = read_json(p)
        if not isinstance(doc, dict):
            raise RuntimeError(f"spend ledger missing: {p} (run `spend --init`)")
        days = doc.setdefault("days", {})
        cur = float(days.get(day, 0.0))
        if cur + usd > cap_usd + 1e-9:
            raise RuntimeError(f"daily cap reached (${cur:.4f} + ${usd:.4f} > ${cap_usd:.2f} today)")
        new_total = round(cur + usd, 6)
        days[day] = new_total
        doc["log"] = (doc.get("log") or [])[-499:] + [
            {"at": utc_now_iso(), "day": day, "usd": round(usd, 6), "note": note}
        ]
        write_json(p, doc)
        return new_total


def release_spend(gemini_dir: Path, usd: float, note: str = "release") -> float:
    day = perth_today()
    with spend_locked(gemini_dir):
        p = gemini_dir / "spend.json"
        doc = read_json(p, {"days": {}, "log": []})
        days = doc.setdefault("days", {})
        cur = float(days.get(day, 0.0))
        new_total = round(max(0.0, cur - usd), 6)
        days[day] = new_total
        doc["log"] = (doc.get("log") or [])[-499:] + [
            {"at": utc_now_iso(), "day": day, "usd": -round(usd, 6), "note": note}
        ]
        write_json(p, doc)
        return new_total


# ---------- Batch JSONL builders & Gemini Batch API ----------

def text_request_line(key: str, text: str) -> dict[str, Any]:
    return {
        "key": key,
        "request": {
            "content": {"parts": [{"text": text}]},
            "outputDimensionality": VECTOR_DIM,
        },
    }


def inline_request_line(key: str, mime: str, b64: str) -> dict[str, Any]:
    return {
        "key": key,
        "request": {
            "content": {"parts": [{"inlineData": {"mimeType": mime, "data": b64}}]},
            "outputDimensionality": VECTOR_DIM,
        },
    }


def plan_next_work(
    videos: Sequence[dict[str, Any]],
    gemini_dir: Path,
    budget_usd: float,
    *,
    max_tier: int = 4,
    only_tier: int | None = None,
    max_items: int | None = None,
    inflight_keys: set[str] | None = None,
) -> tuple[int | None, list[tuple[dict[str, Any], float]]]:
    """Choose the lowest incomplete tier (1 -> 2 -> 3 -> 4) and pack videos fitting budget_usd."""
    inflight = inflight_keys or set()
    tiers_to_check = [only_tier] if only_tier else [t for t in (1, 2, 3, 4) if t <= max_tier]
    ordered = sorted(videos, key=priority_key)
    for tier in tiers_to_check:
        rows, _, _ = load_vectors(gemini_dir, f"tier{tier}", expected_dims=VECTOR_DIM)
        done = {r["id"] for r in rows}
        picked: list[tuple[dict[str, Any], float]] = []
        spent = 0.0
        for v in ordered:
            if v["id"] in done or f"t{tier}:{v['id']}" in inflight:
                continue
            if tier in (2, 3, 4) and not v.get("path"):
                continue
            if tier == 1:
                est = max(0.0001, estimate_tier1_usd(v["title"] + " " + v["channel"]) * 8.0)
            elif tier == 2:
                est = estimate_tier2_usd(len(keyframe_timestamps(v["duration"])))
            elif tier == 3:
                est = estimate_tier3_usd(v["duration"])
            else:
                est = estimate_tier4_usd(v["duration"])
            if spent + est > budget_usd + 1e-9:
                if picked:
                    break
                continue
            picked.append((v, est))
            spent += est
            if max_items and len(picked) >= max_items:
                break
        if picked:
            return tier, picked
    return None, []


def _genai_client():
    from google import genai  # type: ignore

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return genai.Client(api_key=key)


def _inflight_video_keys(jobs: dict[str, Any]) -> set[str]:
    out: set[str] = set()
    for j in (jobs.get("jobs") or {}).values():
        if j.get("state") in INFLIGHT_STATES:
            tier = j.get("tier")
            for vid in j.get("video_ids") or []:
                out.add(f"t{tier}:{vid}")
    return out


def cmd_prepare(
    state_dir: Path,
    library_path: Path,
    sources_path: Path,
    history_path: Path,
    show_meta_dir: Path,
    cap_usd: float,
    *,
    max_tier: int = 3,
    only_tier: int | None = None,
    max_items: int | None = None,
    read_subtitles: bool = True,
    ffmpeg: str = DEFAULT_FFMPEG,
) -> dict[str, Any]:
    gdir = state_dir / "gemini"
    init_spend_ledger(gdir)
    jobs_path = gdir / "jobs.json"
    jobs = read_json(jobs_path, {"jobs": {}})
    # Skip if a batch is already prepared or in flight
    for j in (jobs.get("jobs") or {}).values():
        if j.get("state") in INFLIGHT_STATES:
            return {"status": "inflight", "job": j.get("id")}

    remaining = max(0.0, cap_usd - spent_today_usd(gdir))
    if remaining <= 0.001:
        return {"status": "cap-reached", "remaining_usd": 0.0}

    videos = load_canonical_videos(library_path, sources_path, history_path)
    tier, planned = plan_next_work(
        videos, gdir, remaining,
        max_tier=max_tier, only_tier=only_tier, max_items=max_items,
        inflight_keys=_inflight_video_keys(jobs),
    )
    if not tier or not planned:
        return {"status": "nothing-to-do", "remaining_usd": round(remaining, 4)}

    batches_dir = gdir / "batches"
    batches_dir.mkdir(parents=True, exist_ok=True)
    batch_id = f"vid-t{tier}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    shard_path = batches_dir / f"{batch_id}.jsonl"

    lines_written = 0
    actual_est_usd = 0.0
    included: list[dict[str, Any]] = []
    skipped = 0
    bytes_written = 0

    with shard_path.open("w", encoding="utf-8") as fh:
        for v, _ in planned:
            vid = v["id"]
            if tier == 1:
                text = build_tier1_text(v, show_meta_dir=show_meta_dir, read_subtitles=read_subtitles)
                if not text:
                    skipped += 1
                    continue
                item_usd = estimate_tier1_usd(text)
                if actual_est_usd + item_usd > remaining + 1e-9:
                    break
                raw_line = json.dumps(text_request_line(f"{vid}:0", text), ensure_ascii=False) + "\n"
                if bytes_written + len(raw_line.encode("utf-8")) > SHARD_MAX_BYTES:
                    break
                fh.write(raw_line)
                bytes_written += len(raw_line.encode("utf-8"))
                lines_written += 1
                actual_est_usd += item_usd
                included.append(v)
            elif tier == 2:
                vp = Path(v["path"])
                if not vp.is_file():
                    skipped += 1
                    continue
                ts = keyframe_timestamps(v["duration"])
                frames = extract_keyframes_b64(vp, ts, ffmpeg=ffmpeg)
                if not frames:
                    skipped += 1
                    continue
                item_usd = estimate_tier2_usd(len(frames))
                if actual_est_usd + item_usd > remaining + 1e-9:
                    break
                chunk_lines = [
                    json.dumps(inline_request_line(f"{vid}:{i}", "image/jpeg", b64), ensure_ascii=False) + "\n"
                    for i, b64 in enumerate(frames)
                ]
                chunk_bytes = sum(len(s.encode("utf-8")) for s in chunk_lines)
                if bytes_written + chunk_bytes > SHARD_MAX_BYTES and included:
                    break
                for s in chunk_lines:
                    fh.write(s)
                bytes_written += chunk_bytes
                lines_written += len(chunk_lines)
                actual_est_usd += item_usd
                included.append(v)
            elif tier == 3:
                vp = Path(v["path"])
                if not vp.is_file():
                    skipped += 1
                    continue
                wins = clip_windows(v["duration"])
                clips = extract_audio_clips_b64(vp, wins, ffmpeg=ffmpeg)
                if not clips:
                    skipped += 1
                    continue
                item_usd = estimate_tier3_usd(v["duration"])
                if actual_est_usd + item_usd > remaining + 1e-9:
                    break
                chunk_lines = [
                    json.dumps(inline_request_line(f"{vid}:{i}", "audio/mpeg", b64), ensure_ascii=False) + "\n"
                    for i, b64 in enumerate(clips)
                ]
                chunk_bytes = sum(len(s.encode("utf-8")) for s in chunk_lines)
                if bytes_written + chunk_bytes > SHARD_MAX_BYTES and included:
                    break
                for s in chunk_lines:
                    fh.write(s)
                bytes_written += chunk_bytes
                lines_written += len(chunk_lines)
                actual_est_usd += item_usd
                included.append(v)
            elif tier == 4:
                vp = Path(v["path"])
                if not vp.is_file():
                    skipped += 1
                    continue
                wins = video_clip_windows(v["duration"])
                clips = extract_video_clips_b64(vp, wins, ffmpeg=ffmpeg)
                if not clips:
                    skipped += 1
                    continue
                item_usd = estimate_tier4_usd(v["duration"])
                if actual_est_usd + item_usd > remaining + 1e-9:
                    break
                chunk_lines = [
                    json.dumps(inline_request_line(f"{vid}:{i}", "video/mp4", b64), ensure_ascii=False) + "\n"
                    for i, b64 in enumerate(clips)
                ]
                chunk_bytes = sum(len(s.encode("utf-8")) for s in chunk_lines)
                if bytes_written + chunk_bytes > SHARD_MAX_BYTES and included:
                    break
                for s in chunk_lines:
                    fh.write(s)
                bytes_written += chunk_bytes
                lines_written += len(chunk_lines)
                actual_est_usd += item_usd
                included.append(v)

    if not included:
        shard_path.unlink(missing_ok=True)
        return {"status": "empty", "tier": tier, "skipped": skipped}

    manifest = {
        "id": batch_id,
        "tier": tier,
        "shard": str(shard_path),
        "requests": lines_written,
        "videos": len(included),
        "video_meta": {
            v["id"]: {"id": v["id"], "src": v["src"], "aliases": v["aliases"], "title": v["title"], "channel": v["channel"]}
            for v in included
        },
        "video_ids": [v["id"] for v in included],
        "est_usd": round(actual_est_usd, 6),
        "skipped": skipped,
        "prepared_at": utc_now_iso(),
    }
    write_json(gdir / "prepared.json", manifest)
    return {"status": "prepared", "id": batch_id, "tier": tier, "videos": len(included), "requests": lines_written, "est_usd": round(actual_est_usd, 4)}


def cmd_submit(state_dir: Path, cap_usd: float, model: str = DEFAULT_MODEL, client=None) -> dict[str, Any]:
    gdir = state_dir / "gemini"
    prep_path = gdir / "prepared.json"
    prep = read_json(prep_path)
    if not isinstance(prep, dict) or not prep.get("shard"):
        return {"status": "nothing-prepared"}

    jobs_path = gdir / "jobs.json"
    jobs = read_json(jobs_path, {"jobs": {}})
    for j in (jobs.get("jobs") or {}).values():
        if j.get("state") in INFLIGHT_STATES:
            return {"status": "inflight", "job": j.get("id")}

    est_usd = float(prep["est_usd"])
    today_spent = reserve_spend(gdir, est_usd, cap_usd, f"{prep['id']} (t{prep['tier']}, {prep['videos']} vids)")

    c = client or _genai_client()
    from google.genai import types  # type: ignore

    job_created = False
    try:
        uploaded = c.files.upload(
            file=prep["shard"],
            config=types.UploadFileConfig(mime_type="application/jsonl", display_name=prep["id"]),
        )
        job = c.batches.create_embeddings(
            model=model,
            src=types.EmbeddingsBatchJobSource(file_name=uploaded.name),
            config=types.CreateEmbeddingsBatchJobConfig(display_name=prep["id"]),
        )
        job_created = True
    except Exception as exc:
        if not job_created:
            release_spend(gdir, est_usd, f"{prep['id']} not created ({type(exc).__name__})")
        if "monthly spending cap" in str(exc).lower():
            return {"status": "paused-monthly-cap", "id": prep["id"], "error": str(exc)[:240]}
        raise
    rec = {
        "id": prep["id"],
        "tier": prep["tier"],
        "remote_name": job.name,
        "input_file": uploaded.name,
        "shard": prep["shard"],
        "videos": prep["videos"],
        "video_ids": prep["video_ids"],
        "video_meta": prep["video_meta"],
        "est_usd": est_usd,
        "state": "SUBMITTED",
        "submitted_at": utc_now_iso(),
    }
    jobs.setdefault("jobs", {})[prep["id"]] = rec
    write_json(jobs_path, jobs)
    prep_path.unlink(missing_ok=True)
    return {"status": "submitted", "id": prep["id"], "remote_name": job.name, "est_usd": est_usd, "today_usd": today_spent}


def _parse_embedding_result_line(line: str) -> tuple[str, list[float] | None]:
    obj = json.loads(line)
    key = str(obj.get("key") or "")
    resp = obj.get("response") or {}
    emb = resp.get("embedding") or {}
    vals = emb.get("values")
    if isinstance(vals, list) and vals:
        return key, [float(x) for x in vals]
    return key, None


def merge_batch_result_jsonl(
    gdir: Path,
    tier: int,
    video_meta: dict[str, dict[str, Any]],
    jsonl_text: str,
) -> tuple[int, int]:
    by_vid: dict[str, list[list[float]]] = {}
    errors = 0
    for line in jsonl_text.splitlines():
        if not line.strip():
            continue
        key, vals = _parse_embedding_result_line(line)
        vid, _, _ = key.partition(":")
        if not vid or vals is None:
            errors += 1
            continue
        by_vid.setdefault(vid, []).append(vals)

    new_rows: list[dict[str, Any]] = []
    new_vecs: list[list[float]] = []
    for vid, vec_list in sorted(by_vid.items()):
        meta = video_meta.get(vid) or {"id": vid}
        new_rows.append({**meta, "tier": tier, "parts": len(vec_list), "embedded_at": utc_now_iso()})
        new_vecs.append(mean_normalize(vec_list, VECTOR_DIM))

    merged = merge_tier_vectors(gdir, f"tier{tier}", new_rows, new_vecs, VECTOR_DIM)
    rebuild_fused_vectors(gdir, VECTOR_DIM)
    return merged, errors


def cmd_collect(state_dir: Path, client=None) -> dict[str, Any]:
    gdir = state_dir / "gemini"
    jobs_path = gdir / "jobs.json"
    jobs = read_json(jobs_path, {"jobs": {}})
    inflight = [j for j in (jobs.get("jobs") or {}).values() if j.get("state") in INFLIGHT_STATES]
    if not inflight:
        return {"status": "idle"}

    c = client or _genai_client()
    results_dir = gdir / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    summary: list[dict[str, Any]] = []
    for rec in inflight:
        remote = c.batches.get(name=rec["remote_name"])
        st = str(getattr(remote.state, "name", remote.state)).replace("JOB_STATE_", "")
        rec["state"] = st
        rec["checked_at"] = utc_now_iso()
        if st == "SUCCEEDED":
            dest = getattr(remote, "dest", None)
            fname = getattr(dest, "file_name", None) if dest else None
            if fname:
                raw = c.files.download(file=fname)
                text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
            else:
                # Inline responses fallback
                inlined = getattr(dest, "inlined_embed_content_responses", None) or []
                lines = []
                for idx, item in enumerate(inlined):
                    emb = getattr(getattr(item, "response", None), "embedding", None)
                    vals = list(getattr(emb, "values", []) or [])
                    if vals and idx < len(rec.get("video_ids") or []):
                        lines.append(json.dumps({"key": f"{rec['video_ids'][idx]}:0", "response": {"embedding": {"values": vals}}}))
                text = "\n".join(lines)
            (results_dir / f"{rec['id']}.jsonl").write_text(text, encoding="utf-8")
            merged, errs = merge_batch_result_jsonl(gdir, int(rec["tier"]), rec.get("video_meta") or {}, text)
            rec["state"] = "COLLECTED"
            rec["merged"] = merged
            rec["errors"] = errs
            # Clean up large shard file once vectors are safely persisted
            shard_p = Path(rec.get("shard") or "")
            if shard_p.is_file():
                shard_p.unlink(missing_ok=True)
            summary.append({"id": rec["id"], "state": "COLLECTED", "merged": merged, "errors": errs})
        elif st in ("FAILED", "CANCELLED", "EXPIRED"):
            rec["state"] = st
            summary.append({"id": rec["id"], "state": st})
        else:
            summary.append({"id": rec["id"], "state": st})
    write_json(jobs_path, jobs)
    return {"status": "checked", "jobs": summary}


def cmd_wait(state_dir: Path, timeout_s: int = 3600, interval_s: int = 60, client=None) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    while True:
        res = cmd_collect(state_dir, client=client)
        if res["status"] == "idle":
            return res
        still = [j for j in res.get("jobs", []) if j["state"] in INFLIGHT_STATES]
        if not still:
            return res
        if time.time() >= deadline:
            return {"status": "timeout", "jobs": res.get("jobs", [])}
        time.sleep(min(interval_s, max(1, int(deadline - time.time()))))


# ---------- Cross-space Ridge alignment (EmbeddingGemma 2 768d -> Gemini 3072d) ----------

def fit_alignment(state_dir: Path, min_pairs: int = 50, ridge_lambda: float = 1.0) -> dict[str, Any]:
    """Fit a linear projection W (768 x 3072) mapping local EmbeddingGemma 2 into Gemini's 3072-dim space."""
    import numpy as np  # lazy import so stdlib-only commands work anywhere

    g_rows, g_vecs, g_dim = load_vectors(state_dir / "gemini", "fused", expected_dims=VECTOR_DIM)
    l_rows, l_vecs, l_dim = load_vectors(state_dir / "gemma", "fused", expected_dims=768)
    g_map = {r["id"]: v for r, v in zip(g_rows, g_vecs)}
    pairs = [(l_vecs[i], g_map[r["id"]]) for i, r in enumerate(l_rows) if r["id"] in g_map]
    if len(pairs) < min_pairs:
        return {"status": "insufficient-pairs", "pairs": len(pairs), "need": min_pairs}

    X = np.asarray([p[0] for p in pairs], dtype=np.float64)  # (N, 768)
    Y = np.asarray([p[1] for p in pairs], dtype=np.float64)  # (N, 3072)
    # Train/val split (90/10) for honest cosine accuracy measurement
    n_val = max(10, len(pairs) // 10)
    X_tr, Y_tr = X[:-n_val], Y[:-n_val]
    X_va, Y_va = X[-n_val:], Y[-n_val:]

    reg = ridge_lambda * np.eye(l_dim, dtype=np.float64)
    W_val = np.linalg.solve(X_tr.T @ X_tr + reg, X_tr.T @ Y_tr)
    pred = X_va @ W_val
    pred /= np.maximum(1e-12, np.linalg.norm(pred, axis=1, keepdims=True))
    val_cos = float(np.mean(np.sum(pred * Y_va, axis=1)))

    # Fit final W on all paired items
    W = np.linalg.solve(X.T @ X + reg, X.T @ Y).astype(np.float32)
    out_path = state_dir / "align-gemma-to-gemini.npz"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_dir / "align-gemma-to-gemini.tmp.npz"
    np.savez(tmp, W=W, pairs=len(pairs), val_cosine=val_cos, from_dim=l_dim, to_dim=g_dim)
    os.replace(tmp, out_path)
    return {"status": "aligned", "pairs": len(pairs), "val_cosine": round(val_cos, 4), "path": str(out_path)}


# ---------- Blended video-space.json export for src/video-space.js ----------

def _top_k_cosine_matrix(vecs: Sequence[Sequence[float]], k: int) -> list[list[tuple[int, float]]]:
    n = len(vecs)
    if n <= 1:
        return [[] for _ in range(n)]
    try:
        import numpy as np

        M = np.asarray(vecs, dtype=np.float32)
        S = M @ M.T
        np.fill_diagonal(S, -2.0)
        kk = min(k, n - 1)
        out: list[list[tuple[int, float]]] = []
        for i in range(n):
            row = S[i]
            top_idx = np.argpartition(row, -kk)[-kk:]
            top_idx = top_idx[np.argsort(-row[top_idx])]
            out.append([(int(j), float(row[j])) for j in top_idx if float(row[j]) > 0])
        return out
    except ImportError:
        out = []
        for i in range(n):
            vi = vecs[i]
            scores = [(j, sum(a * b for a, b in zip(vi, vecs[j]))) for j in range(n) if j != i]
            scores.sort(key=lambda pair: -pair[1])
            out.append([(j, float(s)) for j, s in scores[:k] if s > 0])
        return out


def export_video_space(state_dir: Path, top_k: int = 24, gemini_weight: float = 0.65, gemma_weight: float = 0.35) -> dict[str, Any]:
    """Blend Gemini (3072d) + local EmbeddingGemma 2 (768d) neighbour maps into video-space.json."""
    g_rows, g_vecs, _ = load_vectors(state_dir / "gemini", "fused", expected_dims=VECTOR_DIM)
    l_rows, l_vecs, _ = load_vectors(state_dir / "gemma", "fused", expected_dims=768)

    # Collect per-canonical-id neighbour score maps from each available model
    g_nbrs: dict[str, dict[str, float]] = {}
    meta_by_id: dict[str, dict[str, Any]] = {}
    if g_rows:
        top = _top_k_cosine_matrix(g_vecs, top_k * 2)
        for i, r in enumerate(g_rows):
            meta_by_id[r["id"]] = {
                "src": r.get("src", ""),
                "aliases": list(r.get("aliases") or ([r["src"]] if r.get("src") else [])),
                "tier": int(r.get("tier") or 1),
                "models": ["gemini"],
            }
            g_nbrs[r["id"]] = {g_rows[j]["id"]: s for j, s in top[i]}

    l_nbrs: dict[str, dict[str, float]] = {}
    if l_rows:
        top = _top_k_cosine_matrix(l_vecs, top_k * 2)
        for i, r in enumerate(l_rows):
            vid = r["id"]
            if vid not in meta_by_id:
                meta_by_id[vid] = {
                    "src": r.get("src", ""),
                    "aliases": list(r.get("aliases") or ([r["src"]] if r.get("src") else [])),
                    "tier": int(r.get("tier") or 1),
                    "models": ["gemma"],
                }
            else:
                meta_by_id[vid]["models"].append("gemma")
                for a in r.get("aliases") or []:
                    if a not in meta_by_id[vid]["aliases"]:
                        meta_by_id[vid]["aliases"].append(a)
            l_nbrs[vid] = {l_rows[j]["id"]: s for j, s in top[i]}

    # Map canonical id -> primary src string, and expand entries across all alias srcs
    id_to_src = {vid: m["src"] for vid, m in meta_by_id.items() if m.get("src")}
    videos_out: dict[str, dict[str, Any]] = {}
    for vid, m in meta_by_id.items():
        if not m.get("src"):
            continue
        gn = g_nbrs.get(vid) or {}
        ln = l_nbrs.get(vid) or {}
        all_other = set(gn) | set(ln)
        blended: list[tuple[str, float]] = []
        for oid in all_other:
            osrc = id_to_src.get(oid)
            if not osrc:
                continue
            if oid in gn and oid in ln:
                score = gemini_weight * gn[oid] + gemma_weight * ln[oid]
            elif oid in gn:
                score = gn[oid]
            else:
                score = ln[oid]
            blended.append((osrc, round(score, 4)))
        blended.sort(key=lambda pair: (-pair[1], pair[0]))
        entry = {"tier": m["tier"], "models": m["models"], "next": [[s, sc] for s, sc in blended[:top_k]]}
        for alias in m["aliases"] or [m["src"]]:
            videos_out[alias] = entry

    doc = {
        "version": 1,
        "updatedAt": utc_now_iso(),
        "counts": {
            "gemini": len(g_rows),
            "gemma": len(l_rows),
            "totalSrcs": len(videos_out),
        },
        "videos": videos_out,
    }
    out_path = state_dir / "video-space.json"
    atomic_write(out_path, json.dumps(doc, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    return {"path": str(out_path), **doc["counts"]}


def cmd_status(state_dir: Path, library_path: Path, sources_path: Path, cap_usd: float) -> dict[str, Any]:
    gdir = state_dir / "gemini"
    ldir = state_dir / "gemma"
    total_vids = len(load_canonical_videos(library_path, sources_path)) if library_path.is_file() else 0
    g_tiers = {}
    for t in (1, 2, 3, 4):
        rows, _, _ = load_vectors(gdir, f"tier{t}", expected_dims=VECTOR_DIM)
        g_tiers[f"tier{t}"] = len(rows)
    l_tiers = {}
    for t in (1, 2):
        rows, _, _ = load_vectors(ldir, f"tier{t}", expected_dims=768)
        l_tiers[f"tier{t}"] = len(rows)
    spent = 0.0
    if (gdir / "spend.json").is_file():
        spent = spent_today_usd(gdir)
    jobs = read_json(gdir / "jobs.json", {"jobs": {}})
    inflight = [j["id"] for j in (jobs.get("jobs") or {}).values() if j.get("state") in INFLIGHT_STATES]
    return {
        "total_canonical_videos": total_vids,
        "gemini": g_tiers,
        "gemma": l_tiers,
        "spent_today_usd": round(spent, 4),
        "cap_usd": cap_usd,
        "inflight": inflight,
        "aligned": (state_dir / "align-gemma-to-gemini.npz").is_file(),
        "exported": (state_dir / "video-space.json").is_file(),
    }


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    p.add_argument("--library", type=Path, default=DEFAULT_LIBRARY)
    p.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    p.add_argument("--history", type=Path, default=DEFAULT_HISTORY)
    p.add_argument("--show-meta", type=Path, default=DEFAULT_SHOW_META)
    p.add_argument("--cap-usd", type=float, default=None)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")
    sp_spend = sub.add_parser("spend")
    sp_spend.add_argument("--init", action="store_true")

    sp_prep = sub.add_parser("prepare")
    sp_prep.add_argument("--max-tier", type=int, default=4, choices=[1, 2, 3, 4])
    sp_prep.add_argument("--tier", type=int, default=None, choices=[1, 2, 3, 4])
    sp_prep.add_argument("--max-items", type=int, default=None)
    sp_prep.add_argument("--no-subtitles", action="store_true")

    sp_sub = sub.add_parser("submit")
    sp_sub.add_argument("--model", default=DEFAULT_MODEL)

    sub.add_parser("collect")

    sp_wait = sub.add_parser("wait")
    sp_wait.add_argument("--timeout", type=int, default=3600)
    sp_wait.add_argument("--interval", type=int, default=60)

    sp_align = sub.add_parser("align")
    sp_align.add_argument("--min-pairs", type=int, default=50)

    sp_exp = sub.add_parser("export")
    sp_exp.add_argument("--top-k", type=int, default=24)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cap = current_cap_usd(args.cap_usd)
    gdir = args.state_dir / "gemini"
    if args.cmd == "spend":
        if args.init:
            p = init_spend_ledger(gdir)
            print(json.dumps({"initialized": str(p), "spent_today_usd": spent_today_usd(gdir), "cap_usd": cap}))
            return 0
        print(json.dumps({"spent_today_usd": round(spent_today_usd(gdir), 4), "cap_usd": cap, "day": perth_today()}))
        return 0
    if args.cmd == "status":
        print(json.dumps(cmd_status(args.state_dir, args.library, args.sources, cap), indent=2))
        return 0
    if args.cmd == "prepare":
        res = cmd_prepare(
            args.state_dir, args.library, args.sources, args.history, args.show_meta, cap,
            max_tier=args.max_tier, only_tier=args.tier, max_items=args.max_items,
            read_subtitles=not args.no_subtitles,
        )
        print(json.dumps(res))
        return 0
    if args.cmd == "submit":
        print(json.dumps(cmd_submit(args.state_dir, cap, model=args.model)))
        return 0
    if args.cmd == "collect":
        print(json.dumps(cmd_collect(args.state_dir)))
        return 0
    if args.cmd == "wait":
        print(json.dumps(cmd_wait(args.state_dir, timeout_s=args.timeout, interval_s=args.interval)))
        return 0
    if args.cmd == "align":
        print(json.dumps(fit_alignment(args.state_dir, min_pairs=args.min_pairs)))
        return 0
    if args.cmd == "export":
        print(json.dumps(export_video_space(args.state_dir, top_k=args.top_k)))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
