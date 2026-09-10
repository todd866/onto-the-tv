import plistlib
import tempfile
import unittest
from pathlib import Path

import install_mac_app as installer


def fake_app(path: Path, bundle_id: str) -> Path:
    (path / "Contents").mkdir(parents=True)
    with (path / "Contents/Info.plist").open("wb") as handle:
        plistlib.dump({"CFBundleIdentifier": bundle_id}, handle)
    return path


class PruneBackups(unittest.TestCase):
    def test_keeps_only_the_newest_backup_of_this_app(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            output = parent / "Onto the TV.app"
            ours = [fake_app(parent / f".Onto the TV.backup-2026091{i}T000000000000Z-{'a' * 8}.app", installer.BUNDLE_ID)
                    for i in range(3)]
            foreign = fake_app(parent / ".Onto the TV.backup-20260919T000000000000Z-bbbbbbbb.app", "com.example.other")
            unrelated = fake_app(parent / "Other.app", installer.BUNDLE_ID)
            removed = installer.prune_backups(output)
            self.assertEqual(sorted(removed), sorted(ours[:2]))
            self.assertFalse(ours[0].exists())
            self.assertFalse(ours[1].exists())
            self.assertTrue(ours[2].exists())
            self.assertTrue(foreign.exists())
            self.assertTrue(unrelated.exists())

    def test_install_leaves_one_backup_after_repeated_installs(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            output = parent / "Onto the TV.app"

            def stub_build(root, stage, runner):
                fake_app(stage, installer.BUNDLE_ID)

            original = installer.build_bundle
            installer.build_bundle = stub_build
            try:
                for _ in range(4):
                    installer.install(Path(tmp), output, register=False, runner=lambda arguments: None)
            finally:
                installer.build_bundle = original
            backups = [path for path in parent.iterdir() if path.name.startswith(".Onto the TV.backup-")]
            self.assertEqual(len(backups), 1)
            self.assertTrue(output.exists())


if __name__ == "__main__":
    unittest.main()
