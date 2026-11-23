import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RCLONE = shutil.which("rclone") or ("/opt/homebrew/bin/rclone" if os.path.exists("/opt/homebrew/bin/rclone") else None)


@unittest.skipUnless(RCLONE, "rclone is not installed")
class ShelfToCloudTests(unittest.TestCase):
    """The real script, on a small library in temp folders, with a plain folder standing in for the cloud copy."""

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="shelf-to-cloud-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.app, self.drive, self.cloud, self.bin = (self.base / n for n in ("app", "drive", "cloud", "bin"))
        (self.app / "tv-server").mkdir(parents=True)
        self.bin.mkdir()
        self.movies = self.drive / "Movies"
        sources = {"roots": [{"path": str(self.movies / "sitcoms"), "label": "sitcoms", "tier": "sitcom", "classify": "shows"},
                             {"path": str(self.movies / "music"), "label": "music", "tier": "music"}], "picks": []}
        (self.app / "sources.json").write_text(json.dumps(sources))
        (self.app / "settings.json").write_text(json.dumps({"library": str(self.movies / "kids"), "sourcesPath": str(self.app / "sources.json")}))
        self.probe = {}
        for rel in ("sitcoms/A Sitcom/S01E01.mp4", "sitcoms/A Sitcom/S01E02.mp4", "sitcoms/A Sitcom/S01E03.mp4",
                    "sitcoms/Other/new.mp4", "sitcoms/Other/unprobed.mp4", "music/Band/song.mp4"):
            self.put(rel, probed=not rel.endswith("unprobed.mp4"), cloud=not rel.endswith("new.mp4"))
        (self.cloud / "Drive/Movies/sitcoms/A Sitcom/S01E03.mp4").write_bytes(b"short")       # a different size in the cloud
        self.write_probe()
        self.env = dict(os.environ, SHELF_APP_DATA=str(self.app), SHELF_BIN_CMD="/bin/mv -f -t %s" % self.bin if sys.platform != "darwin" else "",
                        SHELF_OPENINGS_CMD="/usr/bin/true")
        if sys.platform == "darwin":                                # no `mv -t` here: a two-line stand-in for the Bin
            mover = self.base / "to-bin.sh"
            mover.write_text('#!/bin/sh\nmv -f "$1" "%s/"\n' % self.bin)
            mover.chmod(0o755)
            self.env["SHELF_BIN_CMD"] = str(mover)

    def put(self, rel, probed=True, cloud=True):
        path = self.movies / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(rel.encode() * 50)
        st = path.stat()
        if probed:
            self.probe["1|" + str(path)] = {"size": st.st_size, "mtime": st.st_mtime_ns, "duration": 1200.0, "error": None}
        if cloud:
            copy = self.cloud / "Drive/Movies" / rel
            copy.parent.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(path.read_bytes())

    def write_probe(self):
        (self.app / "tv-server/.catalogue.html.probe-cache.json").write_text(json.dumps({"version": 1, "entries": self.probe}))

    def run_tool(self, *args):
        cmd = [sys.executable, str(HERE / "shelf_to_cloud.py"), *args, "--cloud-root", str(self.cloud),
               "--cloud-sources", json.dumps([{"name": "Drive", "path": str(self.drive)}])]
        return subprocess.run(cmd, env=self.env, capture_output=True, text=True)

    def manifest(self):
        return json.loads((self.app / "tv-server/cloud-manifest.json").read_text())["entries"]

    def test_plan_says_what_the_cloud_holds_and_changes_nothing(self):
        done = self.run_tool("plan")
        self.assertEqual(done.returncode, 0, done.stderr)
        sitcoms = next(l for l in done.stdout.splitlines() if l.startswith("sitcoms"))
        self.assertIn("cloud", sitcoms.split()[1])
        self.assertIn("1 not in the cloud", sitcoms)
        self.assertIn("1 not probed", sitcoms)
        self.assertIn("1 size differs", sitcoms)
        self.assertIn("whole", next(l for l in done.stdout.splitlines() if l.startswith("music")).split()[1])
        self.assertIn("manifest file MISSING", done.stdout)
        self.assertEqual(len(list(self.movies.rglob("*.mp4"))), 6)
        self.assertFalse((self.app / "tv-server/cloud-manifest.json").exists())

    def test_move_refuses_a_shelf_that_stays_whole_a_hub_with_no_manifest_and_a_run_without_yes(self):
        self.assertIn("stays whole", self.run_tool("move", "--shelf", "music", "--yes", "--openings-dir", str(self.base / "o")).stderr)
        self.assertIn("manifest file does not exist", self.run_tool("move", "--shelf", "sitcoms", "--yes", "--openings-dir", str(self.base / "o")).stderr)
        (self.app / "tv-server/cloud-manifest.json").write_text(json.dumps({"version": 1, "entries": {}}))
        dry = self.run_tool("move", "--shelf", "sitcoms")
        self.assertIn("Nothing moved: add --yes", dry.stdout)
        self.assertIn("--openings-dir is needed", self.run_tool("move", "--shelf", "sitcoms", "--yes").stderr)
        self.assertEqual(len(list(self.movies.rglob("*.mp4"))), 6)
        self.assertEqual(self.manifest(), {})

    def test_move_records_then_bins_only_what_the_cloud_holds_and_leaves_the_folders(self):
        (self.app / "tv-server/cloud-manifest.json").write_text(json.dumps({"version": 1, "entries": {}}))
        done = self.run_tool("move", "--shelf", "sitcoms", "--yes", "--openings-dir", str(self.base / "openings"))
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        self.assertIn("moved to the Bin: 2 files", done.stdout)
        gone = [self.movies / "sitcoms/A Sitcom/S01E01.mp4", self.movies / "sitcoms/A Sitcom/S01E02.mp4"]
        self.assertTrue(all(not p.exists() for p in gone))
        self.assertEqual(sorted(self.manifest()), sorted(str(p) for p in gone))
        self.assertEqual(sorted(p.name for p in self.bin.iterdir() if p.suffix == ".mp4"), ["S01E01.mp4", "S01E02.mp4"])
        # Wrong size in the cloud, not in the cloud, never probed: all still on the drive, none recorded.
        for rel in ("sitcoms/A Sitcom/S01E03.mp4", "sitcoms/Other/new.mp4", "sitcoms/Other/unprobed.mp4", "music/Band/song.mp4"):
            self.assertTrue((self.movies / rel).is_file(), rel)
        self.assertTrue((self.movies / "sitcoms/A Sitcom").is_dir())
        # Run again: the two are held now, nothing more is ready, nothing moves.
        again = self.run_tool("move", "--shelf", "sitcoms", "--yes", "--openings-dir", str(self.base / "openings"))
        self.assertIn("nothing moved", again.stderr.lower())

    def test_a_file_touched_after_the_probe_is_not_ready_and_stays(self):
        (self.app / "tv-server/cloud-manifest.json").write_text(json.dumps({"version": 1, "entries": {}}))
        edited = self.movies / "sitcoms/A Sitcom/S01E01.mp4"
        edited.write_bytes(b"re-encoded since the probe and the upload")
        done = self.run_tool("move", "--shelf", "sitcoms", "--yes", "--openings-dir", str(self.base / "openings"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("moved to the Bin: 1 files", done.stdout)
        self.assertTrue(edited.is_file())
        self.assertEqual(list(self.manifest()), [str(self.movies / "sitcoms/A Sitcom/S01E02.mp4")])

    def test_inside_the_hold_a_file_that_changed_since_the_check_is_left_and_not_recorded(self):
        (self.app / "tv-server/cloud-manifest.json").write_text(json.dumps({"version": 1, "entries": {}}))
        files = []
        for name in ("S01E01.mp4", "S01E02.mp4"):
            st = (self.movies / "sitcoms/A Sitcom" / name).stat()
            files.append({"rel": "A Sitcom/" + name, "size": st.st_size, "mtime_ns": st.st_mtime_ns})
        files[0]["mtime_ns"] -= 5                                   # as if it was rewritten after the cloud was checked
        job = self.base / "job.json"
        job.write_text(json.dumps({"root": str(self.movies / "sitcoms"), "files": files}))
        done = subprocess.run([sys.executable, str(HERE / "shelf_to_cloud.py"), "_commit", str(job)], env=self.env, capture_output=True, text=True)
        out = json.loads(done.stdout.splitlines()[-1])
        self.assertEqual((out["moved"], out["changed"]), (1, ["A Sitcom/S01E01.mp4"]))
        self.assertTrue((self.movies / "sitcoms/A Sitcom/S01E01.mp4").is_file())
        self.assertEqual(list(self.manifest()), [str(self.movies / "sitcoms/A Sitcom/S01E02.mp4")])

    def test_the_openings_step_failing_stops_the_move(self):
        (self.app / "tv-server/cloud-manifest.json").write_text(json.dumps({"version": 1, "entries": {}}))
        self.env["SHELF_OPENINGS_CMD"] = "/usr/bin/false"
        done = self.run_tool("move", "--shelf", "sitcoms", "--yes", "--openings-dir", str(self.base / "openings"))
        self.assertIn("openings could not be held; nothing moved", done.stderr)
        self.assertEqual(len(list(self.movies.rglob("*.mp4"))), 6)
        self.assertEqual(self.manifest(), {})


if __name__ == "__main__":
    unittest.main()
