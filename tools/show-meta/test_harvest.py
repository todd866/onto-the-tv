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


def load_wikidata_fixtures() -> dict:
    return json.loads((FIXTURES / "wikidata_by_title.json").read_text(encoding="utf-8"))


class HarvestTests(unittest.TestCase):
    wikidata = load_wikidata_fixtures()

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
        self.assertEqual(
            harvest.guess_kind(kexp.name, kexp.items, raw_channels=kexp.raw_channels),
            "live series",
        )
        self.assertEqual(kexp.youtube_video_ids(), ["dQw4w9WgXcQ"])
        films = next(s for s in shows if s.name == "Films")
        self.assertEqual(harvest.guess_kind(films.name, films.items), "film")

    def test_guess_kind_music_and_tv_tiers(self):
        music = [{"channel": "Radiohead", "src": "music/x [abcdefghijk].mp4", "tier": "music"}]
        self.assertEqual(harvest.guess_kind("Radiohead", music), "music artist")
        label = [{"channel": "4AD", "src": "music/x.mp4", "tier": "music"}]
        self.assertEqual(harvest.guess_kind("4AD", label), "record label")
        pac = [{"channel": "2Pac", "src": "music/x.mp4", "tier": "music"}]
        self.assertEqual(harvest.guess_kind("2Pac", pac), "music artist")
        preschool = [{"channel": "Bluey", "src": "Bluey/S01E01.mp4", "tier": "preschool"}]
        self.assertEqual(harvest.guess_kind("Bluey", preschool), "series")

    def test_wikipedia_pick_prefers_series_page(self):
        payload = json.loads((FIXTURES / "wikipedia_search_south_park.json").read_text(encoding="utf-8"))
        title, score, confidence, reason = harvest.pick_wikipedia_title(
            payload,
            "South Park",
            "series",
            wikidata_by_title=self.wikidata,
        )
        self.assertEqual(title, "South Park")
        self.assertGreater(score, 2)
        self.assertEqual(confidence, "high")
        self.assertIn("wikidata", reason)

    def test_wikipedia_rejects_bad_picks(self):
        cases = [
            ("wikipedia_search_2_meter_sessions.json", "2 Meter Sessions", "live series", "2 Meter Sessions"),
            ("wikipedia_search_4ad.json", "4AD", "record label", "4AD"),
            ("wikipedia_search_a_place_in_the_sun.json", "A Place in the Sun", "series", "A Place in the Sun (British TV series)"),
            ("wikipedia_search_adam_newling.json", "Adam Newling", "music artist", "Adam Newling"),
        ]
        for filename, show_name, kind, expected_title in cases:
            with self.subTest(filename=filename):
                payload = json.loads((FIXTURES / filename).read_text(encoding="utf-8"))
                title, score, confidence, reason = harvest.pick_wikipedia_title(
                    payload,
                    show_name,
                    kind,
                    wikidata_by_title=self.wikidata,
                )
                self.assertEqual(title, expected_title, msg=reason)
                self.assertGreaterEqual(score, harvest.WIKIPEDIA_MIN_ACCEPT_SCORE)

    def test_wikipedia_second_trial_fixture_picks(self):
        cases = [
            ("wikipedia_search_asap_rocky.json", "A$AP Rocky", "music artist", "ASAP Rocky"),
            ("wikipedia_search_air_french_band.json", "Air", "music artist", "Air (French band)"),
            ("wikipedia_search_air_safety_institute.json", "Air Safety Institute", "series", None),
            ("wikipedia_search_any_young_mechanic.json", "Any Young Mechanic", "series", None),
            ("wikipedia_search_alyss.json", "ALYSS", "music artist", None),
            ("wikipedia_search_altra_moda_music.json", "Altra Moda Music", "music artist", None),
            ("wikipedia_search_america_band.json", "America (the band)", "music artist", "America (band)"),
            ("wikipedia_search_amine.json", "Aminé", "music artist", "Aminé (rapper)"),
            ("wikipedia_search_angus_julia_stone.json", "Angus & Julia Stone", "music artist", "Angus & Julia Stone"),
            ("wikipedia_search_andys_adventures.json", "Andy's Adventures", "series", None),
        ]
        for filename, show_name, kind, expected_title in cases:
            with self.subTest(filename=filename):
                payload = json.loads((FIXTURES / filename).read_text(encoding="utf-8"))
                title, score, confidence, reason = harvest.pick_wikipedia_title(
                    payload,
                    show_name,
                    kind,
                    wikidata_by_title=self.wikidata,
                )
                self.assertEqual(title, expected_title, msg=reason)
                if expected_title is not None:
                    self.assertGreaterEqual(score, harvest.WIKIPEDIA_MIN_ACCEPT_SCORE)
                else:
                    self.assertIsNone(title)

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
        self.assertIsNone(index.match("Radiohead", "music artist"))

    def test_rate_limited_session_retries_429(self):
        sleeps: list[float] = []
        responses = [
            mock.Mock(status_code=429, headers={"Retry-After": "0.01"}),
            mock.Mock(status_code=200, headers={}),
        ]

        class FakeSession:
            def __init__(self) -> None:
                self.calls = 0

            def request(self, method: str, url: str, **kwargs):
                response = responses[self.calls]
                self.calls += 1
                return response

        paced = harvest.RateLimitedSession(
            FakeSession(),
            pace_seconds=0.0,
            sleeper=lambda s: sleeps.append(s),
            backoff_initial=0.01,
            backoff_max=1.0,
        )
        result = paced.get("https://www.wikidata.org/w/api.php")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(sleeps), 1)
        self.assertGreaterEqual(sleeps[0], 0.01)

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

class HarvestFailureIsolationTests(unittest.TestCase):
    def test_main_continues_after_show_error(self):
        catalogue = FIXTURES / "catalogue.html"
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            meta = state / "meta"

            def flaky_fetch(session, show_name, kind, **kwargs):
                if show_name == "South Park":
                    raise RuntimeError("HTTP 429")
                return {"title": show_name, "pickReason": "mock", "confidence": "high"}

            with mock.patch.object(harvest, "fetch_wikipedia", side_effect=flaky_fetch):
                with mock.patch.object(
                    harvest,
                    "ensure_imdb_datasets",
                    return_value=(FIXTURES / "title.basics.tsv.gz", FIXTURES / "title.ratings.tsv.gz"),
                ):
                    with mock.patch.object(harvest, "yt_dlp_descriptions", return_value=([], False)):
                        code = harvest.main(
                            [
                                "--catalogue",
                                str(catalogue),
                                "--state-dir",
                                str(state),
                                "--meta-dir",
                                str(meta),
                                "--refresh",
                                "--limit",
                                "3",
                            ]
                        )
            self.assertEqual(code, 0)
            south = json.loads((meta / "south-park.json").read_text(encoding="utf-8"))
            self.assertIn("error", south)
            films = json.loads((meta / "films.json").read_text(encoding="utf-8"))
            self.assertNotIn("error", films)
            self.assertIsNotNone(films.get("wikipedia"))


if __name__ == "__main__":
    unittest.main()