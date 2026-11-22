"""Offline regression tests. These tests never execute adb or contact a phone."""

import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import sync_phone as sync


def result(stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class FakeAndroid:
    def __init__(self, free, existing=None, fail=None):
        self.files = dict(existing or {})
        self.initial = sum(len(data) for data in self.files.values())
        self.start_free = free
        self.fail = fail
        self.calls = []

    def remote_path(self, relative):
        return "/phone/" + relative

    def size(self, path):
        self.calls.append(("size", path))
        return len(self.files[path]) if path in self.files else None

    def free_bytes(self):
        self.calls.append(("free",))
        return self.start_free + self.initial - sum(len(data) for data in self.files.values())

    def ensure_directory(self, path):
        self.calls.append(("mkdir", path))

    def shell(self, command, action):
        self.calls.append(("shell", command))

    def push(self, source, destination):
        self.calls.append(("push", str(source), destination))
        self.files[destination] = source.read_bytes()
        if self.fail == "push":
            self.files[destination] = b"partial"
            raise sync.SyncError("simulated transfer failure")
        if self.fail == "interrupt":
            raise KeyboardInterrupt
        if self.fail == "size":
            self.files[destination] += b"corrupt"
        if self.fail == "space":
            self.start_free = 0
        if self.fail == "source":
            source.write_bytes(b"a changed source")

    def sha256(self, path):
        self.calls.append(("sha256", path))
        if self.fail == "hash":
            return "0" * 64
        return hashlib.sha256(self.files[path]).hexdigest()

    def rename(self, source, destination):
        self.calls.append(("rename", source, destination))
        if self.fail == "rename":
            raise sync.SyncError("simulated rename failure")
        self.files[destination] = self.files.pop(source)

    def cleanup(self, path):
        self.calls.append(("cleanup", path))
        self.files.pop(path, None)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def video(self, relative="Example Show/Mum's minisode.mp4", data=b"a small completed minisode"):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        stat = path.stat()
        return sync.Video(path, relative, stat.st_size, stat.st_mtime_ns)

    def probe(self, argv, **kwargs):
        self.assertEqual(argv[0], "ffprobe")
        return result(json.dumps({
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "60.0",
                       "size": str(Path(argv[-1]).stat().st_size)},
            "streams": [{"codec_type": "video", "codec_name": "h264"}],
        }))

    def test_small_minisodes_selected_and_temporary_downloads_ignored(self):
        self.video()
        self.video("Example Show/unfinished.mp4.part")
        self.video("Example Show/unfinished.temp.mp4")
        self.video("Example Show/unfinished.f137.mp4")
        self.video(".staging/hidden.mp4")
        self.video("Example Show/empty.mp4", b"")
        scanned = sync.scan_library(self.root, set(), self.probe, emit=lambda _: None)
        self.assertEqual([v.relative for v in scanned.videos], ["Example Show/Mum's minisode.mp4"])
        self.assertEqual(len(scanned.invalid), 1)

    def test_exclusions_are_exact_safe_relative_paths(self):
        config = self.root / "exclusions.json"
        config.write_text(json.dumps({"exclude": ["Example Show/Mum's minisode.mp4"]}))
        self.video()
        scanned = sync.scan_library(self.root, sync.load_exclusions(config), self.probe, emit=lambda _: None)
        self.assertEqual(scanned.excluded, 1)
        self.assertEqual(scanned.videos, [])
        for value in ["../show.mp4", "/sdcard/show.mp4", "Example Show/../show.mp4", "Example Show//show.mp4", 7, ""]:
            with self.subTest(value=value), self.assertRaises(sync.SyncError):
                sync.safe_relative(value)
        self.assertEqual(sync.load_exclusions(self.root / "absent.json"), set())

    def test_probe_failure_and_non_video_are_rejected(self):
        video = self.video()
        with self.assertRaises(sync.SyncError):
            sync.validate_video(video.path, video.relative, lambda *a, **k: result("", 1, "moov atom not found"))
        with self.assertRaises(sync.SyncError):
            sync.validate_video(video.path, video.relative, lambda *a, **k: result(json.dumps({
                "format": {"format_name": "mp4", "duration": "10", "size": video.size},
                "streams": [{"codec_type": "audio", "codec_name": "aac"}],
            })))

    def test_probe_zero_exit_with_media_errors_is_rejected(self):
        video = self.video()
        def corrupt_probe(argv, **kwargs):
            output = self.probe(argv, **kwargs)
            output.stderr = "[h264] Invalid NAL unit size; partial file"
            return output
        with self.assertRaisesRegex(sync.SyncError, "ffprobe reported media errors"):
            sync.validate_video(video.path, video.relative, corrupt_probe)

    def test_remote_quoting_roundtrips_apostrophes_metacharacters_and_newlines(self):
        filename = "Mum's $(touch BAD); \"episode\"\nnew line.mp4"
        command = sync.remote_command(["printf", "%s", filename])
        self.assertEqual(shlex.split(command), ["printf", "%s", filename])
        # Execute only the generated printf command in the disposable test directory.
        output = subprocess.run(["/bin/sh", "-c", command], cwd=self.root, capture_output=True, text=True, check=True)
        self.assertEqual(output.stdout, filename)
        self.assertFalse((self.root / "BAD").exists())

    def test_adb_push_uses_argument_arrays_and_remote_shell_quotes(self):
        calls = []
        def runner(argv, **kwargs):
            calls.append(argv)
            return result("MISSING" if argv[3] == "shell" else "")
        android = sync.Android("SERIAL", "/sdcard/Movies/kids-holiday", runner)
        path = android.remote_path("Example Show/Mum's $(false).mp4")
        self.assertIsNone(android.size(path))
        self.assertIn(shlex.quote(path), calls[-1][-1])
        android.push(Path("/tmp/Mum's video.mp4"), path)
        self.assertEqual(calls[-1], ["adb", "-s", "SERIAL", "push", "/tmp/Mum's video.mp4", path])

    def test_one_device_default_or_explicit_serial(self):
        one = lambda *a, **k: result("List of devices attached\nABC device product:pixel\n")
        two = lambda *a, **k: result("List of devices attached\nABC device\nDEF unauthorized\n")
        self.assertEqual(sync.select_device(None, one), "ABC")
        with self.assertRaises(sync.SyncError):
            sync.select_device(None, two)
        self.assertEqual(sync.select_device("ABC", two), "ABC")
        with self.assertRaises(sync.SyncError):
            sync.select_device("DEF", two)

    def test_dry_run_performs_no_mutations(self):
        video = self.video()
        phone = FakeAndroid(20 * sync.GIB)
        messages = []
        code = sync.sync(phone, sync.Scan([video]), apply=False, reserve=8 * sync.GIB, emit=messages.append)
        self.assertEqual(code, 0)
        self.assertTrue(all(call[0] in ("size", "free") for call in phone.calls))
        self.assertIn("DRY RUN: copied=0", messages[-1])

    def test_reserve_blocks_before_mutation_and_counts_existing(self):
        video = self.video()
        existing = self.video("Example Show/existing.mp4", b"existing")
        phone_path = "/phone/" + existing.relative
        phone = FakeAndroid(3 * sync.GIB, {phone_path: b"existing"})
        messages = []
        code = sync.sync(phone, sync.Scan([video, existing]), apply=True, reserve=8 * sync.GIB, emit=messages.append)
        self.assertEqual(code, 1)
        self.assertEqual(phone.files, {phone_path: b"existing"})
        self.assertTrue(all(call[0] in ("size", "free") for call in phone.calls))
        self.assertIn("same_size=1", messages[-1])
        self.assertIn("blocked=1", messages[-1])
        self.assertIn("sync incomplete", messages[-1])

    def test_peak_storage_includes_full_replacement_stage(self):
        a = sync.Copy(self.video("a.mp4", b"a" * 20), 50)
        b = sync.Copy(self.video("b.mp4", b"b" * 40), None)
        self.assertEqual(sync.needed_free_bytes([a, b], 100), 120)
        self.assertEqual(sync.needed_free_bytes([b, a], 100), 160)

    def test_verified_transfer_then_atomic_rename_and_owned_cleanup(self):
        video = self.video()
        phone = FakeAndroid(20 * sync.GIB)
        code = sync.sync(phone, sync.Scan([video]), apply=True, reserve=8 * sync.GIB, emit=lambda _: None)
        self.assertEqual(code, 0)
        self.assertEqual(phone.files, {"/phone/" + video.relative: video.path.read_bytes()})
        actions = [call[0] for call in phone.calls]
        self.assertLess(actions.index("push"), actions.index("sha256"))
        self.assertLess(actions.index("sha256"), actions.index("rename"))
        self.assertEqual(actions[-1], "cleanup")
        stage = next(call[-1] for call in phone.calls if call[0] == "push")
        self.assertRegex(stage, r"/\.codex-sync-[a-f0-9]{32}\.part$")

    def test_transfer_failures_preserve_existing_and_remove_only_own_stage(self):
        for failure in ("push", "size", "hash", "rename", "source", "space"):
            with self.subTest(failure=failure):
                video = self.video()
                old = b"original existing video"
                phone = FakeAndroid(20 * sync.GIB, {"/phone/" + video.relative: old}, fail=failure)
                messages = []
                code = sync.sync(phone, sync.Scan([video]), apply=True, reserve=8 * sync.GIB, emit=messages.append)
                self.assertEqual(code, 1)
                self.assertEqual(phone.files, {"/phone/" + video.relative: old})
                self.assertEqual(phone.calls[-1][0], "cleanup")
                self.assertIn("sync incomplete", messages[-1])

    def test_interrupt_cleans_owned_stage(self):
        video = self.video()
        phone = FakeAndroid(20 * sync.GIB, fail="interrupt")
        with self.assertRaises(KeyboardInterrupt):
            sync.copy_verified(phone, sync.Copy(video, None), 8 * sync.GIB)
        self.assertEqual(phone.files, {})
        self.assertEqual(phone.calls[-1][0], "cleanup")

    def test_cleanup_refuses_non_stage_files(self):
        android = sync.Android("SERIAL", "/sdcard/Movies/kids-holiday", lambda *a, **k: self.fail("runner called"))
        with self.assertRaises(sync.SyncError):
            android.cleanup("/sdcard/Movies/kids-holiday/family-video.mp4")

    def test_invalid_media_prevents_success_even_when_other_files_are_present(self):
        video = self.video()
        phone = FakeAndroid(20 * sync.GIB, {"/phone/" + video.relative: video.path.read_bytes()})
        code = sync.sync(phone, sync.Scan([video], invalid=[("broken.mp4", "bad metadata")]),
                         apply=True, reserve=8 * sync.GIB, emit=lambda _: None)
        self.assertEqual(code, 1)

    def test_cli_is_dry_run_by_default_and_reserve_configurable(self):
        with patch.object(sync, "select_device", return_value="SERIAL"), \
             patch.object(sync, "scan_library", return_value=sync.Scan()), \
             patch.object(sync, "sync", return_value=0) as run_sync:
            self.assertEqual(sync.main(["--library", str(self.root), "--reserve-gib", "3"]), 0)
            self.assertEqual(run_sync.call_args.kwargs["reserve"], 3 * sync.GIB)
            self.assertFalse(run_sync.call_args.kwargs["apply"])


if __name__ == "__main__":
    unittest.main()
