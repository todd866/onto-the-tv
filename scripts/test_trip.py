import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import trip_list

HERE = Path(__file__).resolve().parent
MB = 1_000_000
NOW = time.mktime(time.strptime("2026-11-22T12:00:00", "%Y-%m-%dT%H:%M:%S"))
OLD = int((NOW - 200 * 86400) * 1e9)


def state(root="/hub/Movies", events=(), cloud=None, extra=None):
    """A small library: a kids root with two shows, a sitcom shelf, a music shelf, and one film pick."""
    probe = {}

    def put(path, size_mb, minutes=20, mtime=OLD):
        probe["1|" + path] = {"size": size_mb * MB, "mtime": mtime, "duration": minutes * 60.0, "error": None}

    for n in range(1, 7):
        put(f"{root}/kids-holiday/Loved Show/E{n}.mp4", 100)
        put(f"{root}/kids-holiday/Other Show/E{n}.mp4", 100)
        put(f"{root}/sitcoms/A Sitcom/S01E0{n}.mp4", 200)
        put(f"{root}/music-videos/Band {n}/song.mp4", 50, minutes=4)
    put(f"{root}/films/A Film (1950)/A Film (1950).mp4", 900, minutes=95)
    probe["1|" + f"{root}/sitcoms/A Sitcom/broken.mp4"] = {"size": 5 * MB, "mtime": OLD, "duration": None, "error": "no usable video stream"}
    probe["1|/elsewhere/not-in-a-root.mp4"] = {"size": 5 * MB, "mtime": OLD, "duration": 60.0, "error": None}
    for path, size_mb in (extra or {}).items():
        put(path, size_mb)
    return {"settings": {"library": f"{root}/kids-holiday"},
            "sources": {"roots": [{"label": "sitcoms", "path": f"{root}/sitcoms", "tier": "sitcom"},
                                  {"label": "music", "path": f"{root}/music-videos", "tier": "music"}],
                        "picks": [{"path": f"{root}/films/A Film (1950)/A Film (1950).mp4", "tier": "grownup", "show": "Films", "title": "A Film (1950)"}]},
            "tiers": {"shared": ["Loved Show"], "big": ["Other Show"]}, "probe": probe, "events": list(events), "cloud": cloud or {}}


def watched(src, seconds, when="2026-11-21T19:00:00", duration=1200, session="s1"):
    return {"src": src, "sessionId": session, "watchedSeconds": seconds, "durationSeconds": duration, "observedAt": when}


class TripListTests(unittest.TestCase):
    def test_candidates_come_from_the_probe_cache_with_shelf_show_tier_and_audience(self):
        cands, movies_root = trip_list.candidates(state())
        self.assertEqual(movies_root, "/hub/Movies")
        self.assertEqual(len(cands), 25)                                  # the broken file and the stray path are left out
        by_rel = {c["rel"]: c for c in cands}
        kid = by_rel["kids-holiday/Loved Show/E1.mp4"]
        self.assertEqual((kid["src"], kid["shelf"], kid["show"], kid["tier"], kid["audience"]),
                         ("Loved Show/E1.mp4", "kids-holiday", "kids-holiday/Loved Show", "shared", "kids"))
        sitcom = by_rel["sitcoms/A Sitcom/S01E01.mp4"]
        self.assertEqual((sitcom["src"], sitcom["tier"], sitcom["audience"]), ("sitcoms/A Sitcom/S01E01.mp4", "sitcom", "grownups"))
        self.assertEqual(by_rel["music-videos/Band 1/song.mp4"]["audience"], "music")
        film = by_rel["films/A Film (1950)/A Film (1950).mp4"]
        self.assertEqual((film["src"], film["show"], film["audience"]), ("Films/A Film (1950).mp4", "Films/Films", "grownups"))

    def test_the_budget_is_kept_and_shared_between_the_audiences(self):
        trip = trip_list.build(state(), 2.0, {"kids": 50, "grownups": 35, "music": 15}, now=NOW)
        self.assertLessEqual(trip["bytes"], 2.0e9)
        by = {a: sum(i["size"] for i in trip["items"] if i["audience"] == a) for a in ("kids", "grownups", "music")}
        self.assertEqual(by["grownups"], 600 * MB)         # three 200 MB sitcom episodes in 700 MB; the 900 MB film cannot fit
        self.assertEqual(by["music"], 300 * MB)            # all six songs: the music share plus what the grown-ups left
        self.assertEqual(by["kids"], 1100 * MB)            # the kids' half (ten episodes), plus the 100 MB nobody else could use
        self.assertEqual(trip["bytes"], 2000 * MB)         # so the budget is filled exactly
        self.assertEqual(trip["library_root"], "/hub/Movies")
        self.assertEqual(trip["cloud_bytes"], 0)

    def test_a_watched_show_gets_more_room_and_within_it_unwatched_episodes_go_first(self):
        events = [watched(f"Loved Show/E{n}.mp4", 1200, session=f"s{n}") for n in (1, 2)]
        only_kids = {"kids": 100, "grownups": 0, "music": 0}
        # Room for four: the loved show's four unwatched episodes, ahead of the two already finished.
        tight = trip_list.build(state(events=events), 0.4, only_kids, now=NOW)
        self.assertEqual([i["rel"] for i in tight["items"]], [f"kids-holiday/Loved Show/E{n}.mp4" for n in (3, 4, 5, 6)])
        # Room for ten: the loved show is taken whole (finished ones too: kids watch favourites again), and the
        # other show still gets a look-in.
        roomy = trip_list.build(state(events=events), 1.0, only_kids, now=NOW)
        kids = [i["rel"] for i in roomy["items"] if i["audience"] == "kids"]
        loved = [rel for rel in kids if "Loved Show" in rel]
        self.assertEqual(len(loved), 6)
        self.assertEqual(len(kids) - len(loved), 4)

    def test_room_an_audience_cannot_use_goes_to_the_others(self):
        trip = trip_list.build(state(), 4.0, {"kids": 100, "grownups": 0, "music": 0}, now=NOW)
        by = {a: sum(i["size"] for i in trip["items"] if i["audience"] == a) for a in ("kids", "grownups", "music")}
        self.assertEqual(by["kids"], 1200 * MB)            # the whole kids library
        self.assertGreater(by["grownups"] + by["music"], 0)
        self.assertLessEqual(trip["bytes"], 4.0e9)

    def test_a_title_held_only_in_the_cloud_is_listed_flagged_and_timed(self):
        gone = "/hub/Movies/sitcoms/A Sitcom/S01E09.mp4"
        cloud = {gone: {"size": 200 * MB, "mtime": OLD, "duration": 1200.0}}
        trip = trip_list.build(state(cloud=cloud), 50.0, {"kids": 50, "grownups": 35, "music": 15}, now=NOW)
        item = next(i for i in trip["items"] if i["rel"] == "sitcoms/A Sitcom/S01E09.mp4")
        self.assertTrue(item["cloud"])
        self.assertEqual(trip["cloud_bytes"], 200 * MB)
        self.assertIn("only in the cloud", trip_list.summary(trip))
        self.assertIn("on the hub's drive now", trip_list.summary(trip_list.build(state(), 1.0, {"kids": 1, "grownups": 1, "music": 1}, now=NOW)))

    def test_the_command_reads_state_from_a_folder_and_writes_the_list(self):
        with tempfile.TemporaryDirectory() as directory:
            folder, s = Path(directory), state()
            (folder / "settings.json").write_text(json.dumps(s["settings"]))
            (folder / "sources.json").write_text(json.dumps(s["sources"]))
            (folder / "tiers.json").write_text(json.dumps(s["tiers"]))
            (folder / "probe.json").write_text(json.dumps({"version": 1, "entries": s["probe"]}))
            out = folder / "trip.json"
            done = subprocess.run([sys.executable, str(HERE / "trip_list.py"), "--state", str(folder), "--gb", "1.5", "--out", str(out)],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("trip list:", done.stdout)
            trip = json.loads(out.read_text())
            self.assertEqual(trip["version"], 1)
            self.assertLessEqual(sum(i["size"] for i in trip["items"]), 1.5e9)
            self.assertTrue(all(not os.path.isabs(i["rel"]) for i in trip["items"]))


class HolidayCopyTests(unittest.TestCase):
    """scripts/copy_holiday_library.sh --list, run on this Mac against a made-up hub home and library."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        self.home, self.target = base / "home", base / "drive"
        self.root = base / "hubdrive" / "Movies"
        self.app = self.home / "Library/Application Support/Onto the TV"
        (self.app / "tv-server").mkdir(parents=True)
        self.target.mkdir()
        self.files = {"kids-holiday/Loved Show/E1.mp4": b"k" * 3000, "sitcoms/A Sitcom/S01E01.mp4": b"s" * 5000,
                      "sitcoms/A Sitcom/S01E02.mp4": b"t" * 7000, "sitcoms/A Sitcom/S01E03 – café.mp4": b"u" * 2000}
        for rel, data in self.files.items():
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_bytes(data)
        (self.root / "music-videos").mkdir()
        (self.app / "settings.json").write_text(json.dumps({"tvHost": "", "library": str(self.root / "kids-holiday"),
            "sourcesPath": str(self.app / "kids-sources.json"), "tiersPath": str(self.app / "kids-tiers.json")}))
        (self.app / "kids-sources.json").write_text(json.dumps({"roots": [
            {"label": "sitcoms", "path": str(self.root / "sitcoms"), "tier": "sitcom"},
            {"label": "music", "path": str(self.root / "music-videos"), "tier": "music"}], "picks": []}))
        (self.app / "kids-tiers.json").write_text(json.dumps({"shared": ["Loved Show"]}))
        (self.app / "tv-server/pairing-token").write_text("token")
        self.list = base / "trip.json"

    def write_list(self, rels, cloud=()):
        items = [{"rel": rel, "size": len(self.files.get(rel, b"")) or 999, "cloud": rel in cloud} for rel in rels]
        self.list.write_text(json.dumps({"version": 1, "library_root": str(self.root), "items": items}))

    def pack(self, *args, ceiling="100"):
        env = {**os.environ, "HOME": str(self.home), "HOLIDAY_CEILING_PCT": ceiling}
        return subprocess.run(["bash", str(HERE / "copy_holiday_library.sh"), str(self.target), *args], env=env, capture_output=True, text=True)

    def test_only_the_listed_titles_are_packed_and_the_drive_copy_of_the_settings_points_at_the_drive(self):
        chosen = ["kids-holiday/Loved Show/E1.mp4", "sitcoms/A Sitcom/S01E02.mp4", "sitcoms/A Sitcom/S01E03 – café.mp4"]
        self.write_list(chosen + ["sitcoms/A Sitcom/S01E09.mp4"], cloud={"sitcoms/A Sitcom/S01E09.mp4"})
        done = self.pack("--list", str(self.list))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        for rel in chosen:
            self.assertEqual((self.target / "Movies" / rel).read_bytes(), self.files[rel])
        self.assertFalse((self.target / "Movies/sitcoms/A Sitcom/S01E01.mp4").exists())      # not on the list
        self.assertIn("checked: every one of the 3 titles", done.stdout)
        self.assertIn("1 listed titles are only in the cloud and were NOT packed", done.stdout)
        settings = json.loads((self.target / "Onto the TV/settings.json").read_text())
        self.assertEqual(settings["library"], str(self.target / "Movies/kids-holiday"))
        self.assertEqual(settings["sourcesPath"], str(self.target / "Onto the TV/kids-sources.json"))
        roots = json.loads((self.target / "Onto the TV/kids-sources.json").read_text())["roots"]
        self.assertEqual([r["path"] for r in roots], [str(self.target / "Movies/sitcoms"), str(self.target / "Movies/music-videos")])
        self.assertTrue((self.target / "Movies/music-videos").is_dir())       # an empty shelf is made ready, not left missing
        self.assertEqual((self.target / "Onto the TV/tv-server/pairing-token").read_text(), "token")
        again = self.pack("--list", str(self.list))
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("to copy: 0 GB", again.stdout)

    def test_the_travel_drive_is_never_taken_over_its_ceiling(self):
        self.write_list(["sitcoms/A Sitcom/S01E01.mp4"])
        done = self.pack("--list", str(self.list), ceiling="1")
        self.assertEqual(done.returncode, 1)
        self.assertIn("over 1%", done.stdout)
        self.assertFalse((self.target / "Movies").exists())
        self.assertFalse((self.target / "Onto the TV").exists())

    def test_without_a_list_a_library_that_is_not_in_the_home_folder_is_refused_with_the_way_forward(self):
        done = self.pack()
        self.assertEqual(done.returncode, 1)
        self.assertIn("make a list first", done.stdout)
        self.assertFalse((self.target / "Movies").exists())

    def test_a_list_that_reaches_outside_the_library_is_refused(self):
        self.write_list(["../../home/secret.mp4"])
        done = self.pack("--list", str(self.list))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("outside the library", done.stdout + done.stderr)
        self.assertFalse((self.target / "Movies").exists())


if __name__ == "__main__":
    unittest.main()
