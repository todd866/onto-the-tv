import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('make_phone_playlists', ROOT / 'make_phone_playlists.py')
playlists = importlib.util.module_from_spec(spec)
spec.loader.exec_module(playlists)


class PlaylistTests(unittest.TestCase):
    def test_inventory_selects_only_existing_listed_mp4s_inside_the_requested_root(self):
        raw = b'/sdcard/Shows/Shared/one.mp4\0/sdcard/Other/two.mp4\0/sdcard/Shows/.hidden.mp4\0/sdcard/Shows/partial.mp4.part\0/sdcard/Shows/Shared/one.mp4\0'
        self.assertEqual(playlists.inventory_paths(raw, '/sdcard/Shows'), ['Shared/one.mp4'])

    def test_inventory_rejects_paths_that_cannot_be_safely_represented(self):
        for value in (b'/sdcard/Shows/../private.mp4\0', b'/sdcard/Shows/A\nB.mp4\0'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                playlists.inventory_paths(value, '/sdcard/Shows')

    def test_everything_uses_current_stream_key_and_unknown_shows_stay_out_of_kid_lists(self):
        content = playlists.render_playlists(['Shared/one.mp4', 'Unknown/two.mp4', 'Big/three.mp4'],
                                              '/storage/emulated/0/Shows',
                                              {'shared': {'Shared'}, 'big': {'Big'}})
        self.assertEqual({name: count for name, (_, count) in content.items()},
                         {'Little Kids': 1, 'Big Kids': 2, 'Everything': 3})
        self.assertIn('/storage/emulated/0/Shows/Unknown/two.mp4', content['Everything'][0])
        self.assertNotIn('Unknown', content['Little Kids'][0])

    def test_cli_requires_no_private_audit_file_and_leaves_unrelated_playlists_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = root / 'inventory.nul'
            inventory.write_bytes(b'/sdcard/Shows/Unknown/one.mp4\0')
            output = root / 'playlists'
            output.mkdir()
            unrelated = output / 'My playlist.m3u'
            unrelated.write_text('keep this')
            result = playlists.main(['--inventory', str(inventory), '--output', str(output),
                                     '--phone-root', '/sdcard/Shows', '--playback-root', '/storage/emulated/0/Shows'])
            self.assertEqual(result, 0)
            self.assertEqual(unrelated.read_text(), 'keep this')
            self.assertIn('/storage/emulated/0/Shows/Unknown/one.mp4', (output / 'Everything.m3u').read_text())


if __name__ == '__main__':
    unittest.main()
