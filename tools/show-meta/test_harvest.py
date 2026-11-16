import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
spec = importlib.util.spec_from_file_location("harvest", ROOT / "harvest.py")
harvest = importlib.util.module_from_spec(spec)
assert spec.loader
sys.modules["harvest"] = harvest
spec.loader.exec_module(harvest)


class HarvestTests(unittest.TestCase):
    def test_list_shows_from_catalogue(self):
        catalogue = FIXTURES / "catalogue.html"
        html = catalogue.read_text(encoding="utf-8")
        videos = harvest.read_catalogue(html, catalogue, catalogue)
        shows = harvest.list_shows(videos)
        names = [show.name for show in shows]
        self.assertEqual(names, ["Films", "KEXP", "South Park"])
        south = next(s for s in shows if s.name == "South Park")
        self.assertEqual(south.raw_channels, ["South Park (1997)"])
        self.assertEqual(harvest.guess_kind(south.name, south.items), "series")
        kexp = next(s for s in shows if s.name == "KEXP")
        self.assertEqual(harvest.guess_kind(kexp.name, kexp.items), "youtube channel")
        self.assertEqual(kexp.youtube_video_ids(), ["dQw4w9WgXcQ"])
        films = next(s for s in shows if s.name == "Films")
        self.assertEqual(harvest.guess_kind(films.name, films.items), "film")

    def test_wikipedia_pick_prefers_series_page(self):
        payload = json.loads((FIXTURES / "wikipedia_search_south_park.json").read_text(encoding="utf-8"))
        title, score, confidence = harvest.pick_wikipedia_title(payload, "South Park", "series")
        self.assertEqual(title, "South Park")
        self.assertGreater(score, 2)
        self.assertEqual(confidence, "high")

    def test_imdb_match_on_fixture(self):
        basics = FIXTURES / "title.basics.tsv.gz"
        ratings = FIXTURES / "title.ratings.tsv.gz"
        index = harvest.ImdbIndex.build(basics, ratings)
        south = index.match("South Park", "series")
        self.assertIsNotNone(south)
        assert south is not None
        self.assertEqual(south["tconst"], "tt0121955")
        self.assertIn("Animation", south["genres"])
        self.assertEqual(south["rating"], "8.7")
        bruges = index.match("In Bruges", "film")
        self.assertEqual(bruges["tconst"], "tt0780536")

    def test_youtube_pacing_and_stop_on_sign_in(self):
        sleeps: list[float] = []

        def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        calls: list[list[str]] = []

        def fake_runner(cmd, **kwargs):
            calls.append(cmd)
            if len(calls) == 1:
                return mock.Mock(
                    returncode=0,
                    stdout=json.dumps({"title": "A", "description": "Desc A"}),
                    stderr="",
                )
            return mock.Mock(returncode=1, stdout="", stderr="Sign in to confirm you're not a bot")

        descriptions, stopped = harvest.yt_dlp_descriptions(
            ["vid1", "vid2", "vid3"],
            runner=fake_runner,
            sleeper=fake_sleep,
            pace=20,
        )
        self.assertTrue(stopped)
        self.assertEqual(len(descriptions), 1)
        self.assertEqual(sleeps, [20.0])
        self.assertIn("--dump-json", calls[0])
        self.assertIn("--skip-download", calls[0])

    def test_plan_skips_fresh_meta_unless_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            meta = Path(directory)
            fresh = meta / "south-park.json"
            fresh.write_text("{}", encoding="utf-8")
            old = datetime.now(timezone.utc) - timedelta(days=1)
            ts = old.timestamp()
            import os

            os.utime(fresh, (ts, ts))
            group = harvest.ShowGroup(name="South Park", items=[{"channel": "South Park (1997)", "src": "x", "tier": "adultanim"}])
            planned = harvest.plan_harvest([group], meta_dir=meta, now=datetime.now(timezone.utc), refresh=False, limit=None)
            self.assertEqual(planned, [])
            planned_refresh = harvest.plan_harvest([group], meta_dir=meta, now=datetime.now(timezone.utc), refresh=True, limit=None)
            self.assertEqual(len(planned_refresh), 1)

    def test_dry_run_main_prints_plan(self,):
        catalogue = FIXTURES / "catalogue.html"
        with tempfile.TemporaryDirectory() as directory:
            code = harvest.main(
                ["--catalogue", str(catalogue), "--state-dir", directory, "--dry-run", "--limit", "2"]
            )
            self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()