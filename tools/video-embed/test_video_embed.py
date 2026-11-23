import json
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

import gemma_embed as ge
import video_embed as ve


class FakeGenaiClient:
    """In-memory mock of google.genai.Client for batch submit/collect tests."""

    def __init__(self, dim: int = ve.VECTOR_DIM):
        self.dim = dim
        self.uploaded: dict[str, str] = {}
        self.batches_db: dict[str, dict] = {}
        self.files = SimpleNamespace(upload=self._upload, download=self._download)
        self.batches = SimpleNamespace(create_embeddings=self._create, get=self._get)

    def _upload(self, file, config=None):
        name = f"files/{len(self.uploaded) + 1}"
        self.uploaded[name] = Path(file).read_text(encoding="utf-8")
        return SimpleNamespace(name=name)

    def _create(self, model, src, config=None):
        name = f"batches/{len(self.batches_db) + 1}"
        lines = []
        for raw in self.uploaded[src.file_name].splitlines():
            obj = json.loads(raw)
            key = obj["key"]
            seed = int(ve.sha256_text(key)[:8], 16)
            rng = np.random.default_rng(seed)
            vec = rng.standard_normal(self.dim).astype(np.float64)
            vec /= np.linalg.norm(vec)
            lines.append(json.dumps({"key": key, "response": {"embedding": {"values": vec.tolist()}}}))
        out_file = f"files/out-{len(self.batches_db) + 1}"
        self.uploaded[out_file] = "\n".join(lines) + "\n"
        self.batches_db[name] = {"state": "SUCCEEDED", "out": out_file}
        return SimpleNamespace(name=name)

    def _get(self, name):
        rec = self.batches_db[name]
        return SimpleNamespace(
            state=SimpleNamespace(name=f"JOB_STATE_{rec['state']}"),
            dest=SimpleNamespace(file_name=rec["out"]),
        )

    def _download(self, file):
        return self.uploaded[file].encode("utf-8")


class FakeGemmaBackend:
    dims = ge.GEMMA_DIM

    def has_vision(self):
        return False

    def encode_texts(self, items, batch_size=16):
        out = []
        for title, body in items:
            seed = int(ve.sha256_text(title + body)[:8], 16)
            rng = np.random.default_rng(seed)
            v = rng.standard_normal(self.dims)
            v /= np.linalg.norm(v)
            out.append(v.tolist())
        return out


class VideoEmbedTests(unittest.TestCase):
    def _fixture(self, td: Path):
        media = td / "media"
        (media / "sitcoms/Seinfeld").mkdir(parents=True)
        (media / "grown-ups/Films").mkdir(parents=True)
        (media / "kids/Bluey").mkdir(parents=True)
        ep = media / "sitcoms/Seinfeld/S01E01.mp4"
        ep.write_bytes(b"mp4")
        (media / "sitcoms/Seinfeld/S01E01.en.srt").write_text(
            "1\n00:00:01,000 --> 00:00:03,000\nWhat is the deal with airline food?\n\n"
            "2\n00:00:04,000 --> 00:00:06,000\n<i>Nothing happens</i> in this show!\n",
            encoding="utf-8",
        )
        movie = media / "grown-ups/Films/Die Hard (1988).mp4"
        movie.write_bytes(b"mp4")
        kid = media / "kids/Bluey/Verandah Santa.mp4"
        kid.write_bytes(b"mp4")

        sources = td / "kids-sources.json"
        sources.write_text(json.dumps({
            "roots": [
                {"label": "sitcoms", "path": str(media / "sitcoms")},
                {"label": "sitcoms (Stash)", "path": str(media / "sitcoms")},
                {"label": "grown-ups", "path": str(media / "grown-ups")},
                {"label": "", "path": str(media / "kids")},
            ],
            "picks": [],
        }), encoding="utf-8")
        library = td / "library.json"
        library.write_text(json.dumps({
            "version": 1,
            "videos": [
                {"src": "sitcoms/Seinfeld/S01E01.mp4", "title": "The Seinfeld Chronicles", "channel": "Seinfeld", "tier": "sitcom", "duration": 1380},
                {"src": "sitcoms (Stash)/Seinfeld/S01E01.mp4", "title": "The Seinfeld Chronicles", "channel": "Seinfeld", "tier": "sitcom", "duration": 1380},
                {"src": "grown-ups/Films/Die Hard (1988).mp4", "title": "Die Hard (1988)", "channel": "Films", "tier": "grownup", "duration": 7920},
                {"src": "Bluey/Verandah Santa.mp4", "title": "Verandah Santa", "channel": "Bluey", "tier": "shared", "duration": 420},
            ],
        }), encoding="utf-8")
        history = td / "history.json"
        history.write_text(json.dumps({"finished": {"Bluey/Verandah Santa.mp4": 1700000000}}), encoding="utf-8")
        return library, sources, history

    def test_canonical_dedup_and_priority(self):
        with tempfile.TemporaryDirectory() as td:
            lib, src, hist = self._fixture(Path(td))
            vids = ve.load_canonical_videos(lib, src, hist)
            # Duplicate 'sitcoms (Stash)' collapses into a single canonical entry with 2 aliases
            self.assertEqual(len(vids), 3)
            seinfeld = [v for v in vids if "Seinfeld" in v["channel"]][0]
            self.assertEqual(seinfeld["src"], "sitcoms/Seinfeld/S01E01.mp4")
            self.assertEqual(len(seinfeld["aliases"]), 2)
            ordered = sorted(vids, key=ve.priority_key)
            # Movies first -> Watched -> TV/Long
            self.assertEqual(ordered[0]["title"], "Die Hard (1988)")
            self.assertEqual(ordered[1]["title"], "Verandah Santa")
            self.assertEqual(ordered[2]["title"], "The Seinfeld Chronicles")

    def test_subtitle_extraction_in_tier1_text(self):
        with tempfile.TemporaryDirectory() as td:
            lib, src, hist = self._fixture(Path(td))
            vids = ve.load_canonical_videos(lib, src, hist)
            seinfeld = [v for v in vids if "Seinfeld" in v["channel"]][0]
            text = ve.build_tier1_text(seinfeld)
            self.assertIn("What is the deal with airline food?", text)
            self.assertIn("Nothing happens in this show!", text)
            self.assertNotIn("-->", text)

    def test_spend_cap_and_full_batch_lifecycle_and_dual_export(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            lib, src, hist = self._fixture(root)
            state = root / "state"
            meta = root / "meta"
            meta.mkdir()

            # 1. Prepare Tier 1 within $5 cap
            prep = ve.cmd_prepare(state, lib, src, hist, meta, cap_usd=5.0, max_tier=1)
            self.assertEqual(prep["status"], "prepared")
            self.assertEqual(prep["tier"], 1)
            self.assertEqual(prep["videos"], 3)

            # 2. Submit & collect with mock client
            client = FakeGenaiClient()
            # Monkeypatch google.genai.types so test runs without SDK
            import sys
            fake_types = SimpleNamespace(
                UploadFileConfig=lambda **kw: SimpleNamespace(**kw),
                EmbeddingsBatchJobSource=lambda **kw: SimpleNamespace(**kw),
                CreateEmbeddingsBatchJobConfig=lambda **kw: SimpleNamespace(**kw),
            )
            sys.modules["google"] = SimpleNamespace(genai=SimpleNamespace(types=fake_types))
            sys.modules["google.genai"] = SimpleNamespace(types=fake_types)
            try:
                sub = ve.cmd_submit(state, cap_usd=5.0, client=client)
                self.assertEqual(sub["status"], "submitted")
                col = ve.cmd_collect(state, client=client)
                self.assertEqual(col["jobs"][0]["state"], "COLLECTED")
                self.assertEqual(col["jobs"][0]["merged"], 3)
            finally:
                sys.modules.pop("google.genai", None)
                sys.modules.pop("google", None)

            # 3. Run local EmbeddingGemma 2 slice (mock backend)
            gres = ge.run_gemma_slice(state, lib, src, hist, meta, budget_seconds=60, backend=FakeGemmaBackend())
            self.assertEqual(gres["tier1_added"], 3)
            self.assertEqual(gres["total_fused"], 3)

            # 4. Export blended video-space.json (must include alias 'sitcoms (Stash)/...')
            exp = ve.export_video_space(state, top_k=5)
            self.assertEqual(exp["gemini"], 3)
            self.assertEqual(exp["gemma"], 3)
            self.assertEqual(exp["totalSrcs"], 4)
            space = json.loads((state / "video-space.json").read_text(encoding="utf-8"))
            self.assertIn("sitcoms (Stash)/Seinfeld/S01E01.mp4", space["videos"])
            self.assertEqual(sorted(space["videos"]["grown-ups/Films/Die Hard (1988).mp4"]["models"]), ["gemini", "gemma"])

            # 5. Spend cap refuses overspend
            with self.assertRaises(RuntimeError):
                ve.reserve_spend(state / "gemini", 5.01, 5.0, "too much")

    def test_ridge_alignment_recovers_linear_projection(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td) / "state"
            rng = np.random.default_rng(42)
            # True low-rank linear relationship from 768d -> 3072d (synthetic teacher-student)
            W_true = rng.standard_normal((768, ve.VECTOR_DIM)).astype(np.float64) * 0.02
            n = 80
            l_rows, l_vecs, g_rows, g_vecs = [], [], [], []
            for i in range(n):
                x = rng.standard_normal(768)
                x /= np.linalg.norm(x)
                y = x @ W_true
                y /= np.linalg.norm(y)
                row = {"id": f"v{i:03d}", "src": f"s/v{i:03d}.mp4", "aliases": [f"s/v{i:03d}.mp4"], "tier": 1}
                l_rows.append(row); l_vecs.append(x.tolist())
                g_rows.append(row); g_vecs.append(y.tolist())
            ve.save_vectors(state / "gemma", "fused", l_rows, l_vecs, 768)
            ve.save_vectors(state / "gemini", "fused", g_rows, g_vecs, ve.VECTOR_DIM)
            res = ve.fit_alignment(state, min_pairs=50, ridge_lambda=0.01)
            self.assertEqual(res["status"], "aligned")
            self.assertGreater(res["val_cosine"], 0.15)
            self.assertTrue((state / "align-gemma-to-gemini.npz").is_file())

    def test_tier4_ladder_and_submit_failure_refunds_spend(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            lib, src, hist = self._fixture(root)
            state = root / "state"
            gdir = state / "gemini"
            ve.init_spend_ledger(gdir)
            vids = ve.load_canonical_videos(lib, src, hist)
            dummy_vec = [1.0] + [0.0] * (ve.VECTOR_DIM - 1)
            rows = [{"id": v["id"], "src": v["src"], "aliases": v["aliases"], "title": v["title"], "channel": v["channel"]} for v in vids]
            for t in (1, 2, 3):
                ve.save_vectors(gdir, f"tier{t}", rows, [dummy_vec for _ in vids], ve.VECTOR_DIM)
            tier, picked = ve.plan_next_work(vids, gdir, budget_usd=1.0, max_tier=4)
            self.assertEqual(tier, 4)
            self.assertEqual(len(picked), 3)

            # Simulate submit failure -> spend must be refunded cleanly to $0.00
            (gdir / "batches").mkdir(parents=True, exist_ok=True)
            shard = gdir / "batches/fail.jsonl"
            shard.write_text("{}\n", encoding="utf-8")
            ve.write_json(gdir / "prepared.json", {
                "id": "vid-t4-fail", "tier": 4, "shard": str(shard),
                "videos": 1, "video_ids": [vids[0]["id"]], "video_meta": {}, "est_usd": 0.50,
            })
            import sys
            fake_types = SimpleNamespace(
                UploadFileConfig=lambda **kw: SimpleNamespace(**kw),
                EmbeddingsBatchJobSource=lambda **kw: SimpleNamespace(**kw),
                CreateEmbeddingsBatchJobConfig=lambda **kw: SimpleNamespace(**kw),
            )
            broken_client = SimpleNamespace(
                files=SimpleNamespace(upload=lambda **kw: (_ for _ in ()).throw(RuntimeError("monthly spending cap"))),
            )
            sys.modules["google"] = SimpleNamespace(genai=SimpleNamespace(types=fake_types))
            sys.modules["google.genai"] = SimpleNamespace(types=fake_types)
            try:
                out = ve.cmd_submit(state, cap_usd=5.0, client=broken_client)
                self.assertEqual(out["status"], "paused-monthly-cap")
                self.assertAlmostEqual(ve.spent_today_usd(gdir), 0.0, places=6)
                self.assertTrue((gdir / "prepared.json").is_file())
            finally:
                sys.modules.pop("google.genai", None)
                sys.modules.pop("google", None)


if __name__ == "__main__":
    unittest.main()
