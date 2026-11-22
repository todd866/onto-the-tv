#!/usr/bin/env python3
"""Local EmbeddingGemma 2 (768-dim MLX, $0/day) video embedder for Onto the TV.

Runs incremental nightly slices under heavy-slot (default --budget-seconds 2400):
  Pass 1 (tier1): metadata + show summaries + sidecar subtitles (uses AutoTokenizer +
                  mlx_vlm.embedding_loader — fast, ~1-2 min for the full library!)
  Pass 2 (tier2): visual keyframes (1 frame/min up to 60/movie, 16/episode) whenever
                  a Transformers build exposing EmbeddingGemma2Processor is available.

Vectors are saved in ~/.local/state/onto-tv-video-embed/gemma/ (tier1.f32, tier2.f32,
fused.f32) and automatically aligned & blended with Gemini 3072-dim vectors by
video_embed.py align / export.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Sequence

import video_embed as ve

GEMMA_DIM = 768
DEFAULT_MODEL_ID = "mlx-community/embeddinggemma-2-bf16"
DOCUMENT_PREFIX = "title: {title} | text: "


def gemma_keyframe_timestamps(duration: float) -> list[float]:
    """Dense-ish local keyframes (free!): ~1/min up to 48 for movies, up to 16 for episodes/shorts."""
    d = float(duration)
    if d <= 0:
        return []
    if d >= 3600:
        n = min(48, max(16, int(d // 90)))
    elif d >= 900:
        n = min(16, max(8, int(d // 60)))
    else:
        n = max(1, min(8, int(d // 30) or 1))
    if n == 1:
        return [round(d * 0.5, 2)]
    start, end = d * 0.06, d * 0.94
    step = (end - start) / (n - 1)
    return [round(start + i * step, 2) for i in range(n)]


class MlxGemma2Backend:
    """Lazy loader for mlx-community/embeddinggemma-2-bf16."""

    def __init__(self, model_id: str = DEFAULT_MODEL_ID):
        self.model_id = model_id
        self.dims = GEMMA_DIM
        self._model = None
        self._tokenizer = None
        self._processor = None
        self._vision_checked = False

    def _ensure_text(self) -> None:
        if self._model is not None and self._tokenizer is not None:
            return
        from mlx_vlm.embedding_loader import load_embedding_model  # type: ignore
        from mlx_vlm.utils import get_model_path  # type: ignore
        from transformers import AutoTokenizer  # type: ignore

        path = get_model_path(self.model_id)
        self._model = load_embedding_model(path)
        self._tokenizer = AutoTokenizer.from_pretrained(path)

    def has_vision(self) -> bool:
        if not self._vision_checked:
            self._vision_checked = True
            try:
                from mlx_vlm import load  # type: ignore

                model, proc = load(self.model_id)
                if proc is not None and hasattr(proc, "image_processor"):
                    self._model = model
                    self._processor = proc
            except Exception:
                self._processor = None
        return self._processor is not None

    def encode_texts(self, items: Sequence[tuple[str, str]], batch_size: int = 16) -> list[list[float]]:
        import mlx.core as mx  # type: ignore

        self._ensure_text()
        formatted = [DOCUMENT_PREFIX.format(title=(t or "none")[:120]) + body for t, body in items]
        out: list[list[float]] = []
        for i in range(0, len(formatted), batch_size):
            batch = formatted[i : i + batch_size]
            inputs = self._tokenizer(batch, padding=True, truncation=True, max_length=2048, return_tensors="np")
            mx_inputs = {k: mx.array(v) for k, v in inputs.items()}
            emb = self._model(**mx_inputs).text_embeds
            mx.eval(emb)
            arr = emb.tolist()
            out.extend(ve.l2_normalize(v, self.dims) for v in arr)
        return out

    def encode_image_paths(self, paths: Sequence[Path], batch_size: int = 8) -> list[list[float]]:
        import mlx.core as mx  # type: ignore
        from PIL import Image  # type: ignore

        if not self.has_vision():
            raise RuntimeError("EmbeddingGemma2 multimodal processor is not available in this venv")
        out: list[list[float]] = []
        for i in range(0, len(paths), batch_size):
            imgs = [Image.open(p).convert("RGB") for p in paths[i : i + batch_size]]
            try:
                inputs = self._processor(images=imgs, return_tensors="np")
                mx_inputs = {k: mx.array(v) for k, v in inputs.items()}
                emb = self._model(**mx_inputs).text_embeds
                mx.eval(emb)
                out.extend(ve.l2_normalize(v, self.dims) for v in emb.tolist())
            finally:
                for im in imgs:
                    im.close()
        return out


def _extract_keyframe_files(video_path: Path, timestamps: Sequence[float], out_dir: Path, ffmpeg: str = ve.DEFAULT_FFMPEG) -> list[Path]:
    paths: list[Path] = []
    for idx, ts in enumerate(timestamps):
        jpg = out_dir / f"f{idx:03d}.jpg"
        cmd = [
            ffmpeg, "-nostdin", "-v", "error", "-y",
            "-ss", f"{ts:.2f}", "-i", str(video_path),
            "-frames:v", "1",
            "-vf", "scale='min(384,iw)':'min(384,ih)':force_original_aspect_ratio=decrease",
            "-q:v", "5", str(jpg),
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=60, check=False)
        if r.returncode == 0 and jpg.is_file() and jpg.stat().st_size > 0:
            paths.append(jpg)
    return paths


def run_gemma_slice(
    state_dir: Path,
    library_path: Path,
    sources_path: Path,
    history_path: Path,
    show_meta_dir: Path,
    *,
    budget_seconds: int = 2400,
    batch_size: int = 16,
    checkpoint_every: int = 32,
    read_subtitles: bool = True,
    backend=None,
    ffmpeg: str = ve.DEFAULT_FFMPEG,
) -> dict[str, Any]:
    """Run one bounded-time local EmbeddingGemma 2 slice (Pass 1 text -> Pass 2 keyframes)."""
    ldir = state_dir / "gemma"
    ldir.mkdir(parents=True, exist_ok=True)
    videos = sorted(ve.load_canonical_videos(library_path, sources_path, history_path), key=ve.priority_key)
    be = backend or MlxGemma2Backend()
    deadline = time.time() + max(10, int(budget_seconds))

    t1_added = 0
    t2_added = 0
    vision_available = False

    # Pass 1: text + subtitles
    t1_rows, _, _ = ve.load_vectors(ldir, "tier1", expected_dims=GEMMA_DIM)
    t1_done = {r["id"] for r in t1_rows}
    t1_todo = [v for v in videos if v["id"] not in t1_done]
    buf_rows: list[dict[str, Any]] = []
    buf_vecs: list[list[float]] = []

    for i in range(0, len(t1_todo), batch_size):
        if time.time() >= deadline:
            break
        chunk = t1_todo[i : i + batch_size]
        texts = [
            (v["title"], ve.build_tier1_text(v, show_meta_dir=show_meta_dir, read_subtitles=read_subtitles))
            for v in chunk
        ]
        vecs = be.encode_texts(texts, batch_size=batch_size)
        for v, vec in zip(chunk, vecs):
            buf_rows.append({
                "id": v["id"], "src": v["src"], "aliases": v["aliases"],
                "title": v["title"], "channel": v["channel"],
                "tier": 1, "embedded_at": ve.utc_now_iso(),
            })
            buf_vecs.append(vec)
        if len(buf_rows) >= checkpoint_every:
            t1_added += ve.merge_tier_vectors(ldir, "tier1", buf_rows, buf_vecs, GEMMA_DIM)
            buf_rows.clear(); buf_vecs.clear()

    if buf_rows:
        t1_added += ve.merge_tier_vectors(ldir, "tier1", buf_rows, buf_vecs, GEMMA_DIM)
        buf_rows.clear(); buf_vecs.clear()

    # Pass 2: keyframes (only if time remains and multimodal processor is available)
    if time.time() < deadline and be.has_vision():
        vision_available = True
        t2_rows, _, _ = ve.load_vectors(ldir, "tier2", expected_dims=GEMMA_DIM)
        t2_done = {r["id"] for r in t2_rows}
        t2_todo = [v for v in videos if v["id"] not in t2_done and v.get("path")]
        for v in t2_todo:
            if time.time() >= deadline:
                break
            vp = Path(v["path"])
            if not vp.is_file():
                continue
            ts = gemma_keyframe_timestamps(v["duration"])
            with tempfile.TemporaryDirectory(prefix="otv-gemma-kf-") as td:
                frames = _extract_keyframe_files(vp, ts, Path(td), ffmpeg=ffmpeg)
                if not frames:
                    continue
                fvecs = be.encode_image_paths(frames)
                if not fvecs:
                    continue
                buf_rows.append({
                    "id": v["id"], "src": v["src"], "aliases": v["aliases"],
                    "title": v["title"], "channel": v["channel"],
                    "tier": 2, "parts": len(fvecs), "embedded_at": ve.utc_now_iso(),
                })
                buf_vecs.append(ve.mean_normalize(fvecs, GEMMA_DIM))
            if len(buf_rows) >= max(8, checkpoint_every // 2):
                t2_added += ve.merge_tier_vectors(ldir, "tier2", buf_rows, buf_vecs, GEMMA_DIM)
                buf_rows.clear(); buf_vecs.clear()
        if buf_rows:
            t2_added += ve.merge_tier_vectors(ldir, "tier2", buf_rows, buf_vecs, GEMMA_DIM)

    fused = ve.rebuild_fused_vectors(ldir, GEMMA_DIM)
    return {
        "status": "ok",
        "tier1_added": t1_added,
        "tier2_added": t2_added,
        "vision_available": vision_available,
        "total_fused": len(fused),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--state-dir", type=Path, default=ve.DEFAULT_STATE)
    p.add_argument("--library", type=Path, default=ve.DEFAULT_LIBRARY)
    p.add_argument("--sources", type=Path, default=ve.DEFAULT_SOURCES)
    p.add_argument("--history", type=Path, default=ve.DEFAULT_HISTORY)
    p.add_argument("--show-meta", type=Path, default=ve.DEFAULT_SHOW_META)
    p.add_argument("--model", default=DEFAULT_MODEL_ID)
    p.add_argument("--budget-seconds", type=int, default=2400)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--no-subtitles", action="store_true")
    args = p.parse_args(argv)
    res = run_gemma_slice(
        args.state_dir, args.library, args.sources, args.history, args.show_meta,
        budget_seconds=args.budget_seconds, batch_size=args.batch_size,
        read_subtitles=not args.no_subtitles, backend=MlxGemma2Backend(args.model),
    )
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
