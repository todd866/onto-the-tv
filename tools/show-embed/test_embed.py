"""Offline integration and cache tests; no third-party imports or model downloads."""
import contextlib
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('show_embed', Path(__file__).with_name('embed.py'))
embed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(embed)


class EmbeddingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.meta = self.state / 'meta'
        shutil.copytree(Path(__file__).with_name('fixtures'), self.meta)

    def build(self, backend=None):
        return embed.embed(self.meta, self.state, backend or embed.HashBackend())

    def load(self):
        return embed.load_store(self.state / 'vectors')

    def test_text(self):
        meta = json.loads((self.meta / 'space-school.json').read_text())
        text = embed.build_text(meta)
        self.assertTrue(text.startswith('Space School. series. Genres: Science fiction, Adventure, Family.'))
        self.assertIn('IMDb: Adventure, Family, 2001', text)
        self.assertIn('Science adventures for the family', text)
        self.assertNotIn('THIRD', text)
        self.assertNotIn('Q24925', text)
        self.assertEqual(embed.build_text({'name': ' Bare ', 'wikipedia': None}), 'Bare')
        meta['wikipedia']['extract'] = 'summary ' * 500
        meta['youtube']['descriptions'][0]['description'] = 'first ' * 500
        meta['youtube']['descriptions'][1]['description'] = 'second ' * 500
        text = embed.build_text(meta)
        self.assertLessEqual(len(text), 1500)
        self.assertIn('first', text)
        self.assertIn('second', text)

    def test_incremental_and_binary(self):
        self.assertEqual(self.build(), (3, 0))
        rows, vectors, _ = self.load()
        self.assertEqual([r['slug'] for r in rows], ['kitchen', 'planet-pals', 'space-school'])
        raw = (self.state / 'vectors/shows.f32').read_bytes()
        self.assertEqual(len(raw), 3 * 384 * 4)
        self.assertEqual(struct.unpack('<384f', raw[:384*4]), vectors[0])
        for vector in vectors:
            self.assertAlmostEqual(math.sqrt(sum(x*x for x in vector)), 1, places=6)
        with patch.object(embed.HashBackend, 'encode', side_effect=AssertionError('cache miss')):
            self.assertEqual(self.build(), (0, 3))
        path = self.meta / 'space-school.json'
        meta = json.loads(path.read_text())
        meta['harvestedAt'] = 'tomorrow'
        path.write_text(json.dumps(meta))
        self.assertEqual(self.build(), (0, 3))
        meta['wikipedia']['extract'] = 'An entirely changed story.'
        path.write_text(json.dumps(meta))
        backend = embed.HashBackend()
        with patch.object(backend, 'encode', wraps=backend.encode) as encode:
            self.assertEqual(self.build(backend), (1, 2))
            self.assertEqual(len(encode.call_args.args[0]), 1)
        self.assertEqual(self.load()[1][:2], vectors[:2])
        (self.meta / 'kitchen.json').unlink()
        self.assertEqual(self.build(), (0, 2))
        self.assertEqual(len(self.load()[0]), 2)
        (self.meta / 'new.json').write_text('{"name":"New","kind":"film"}')
        self.assertEqual(self.build(), (1, 2))

    def test_backend_identity_and_corruption(self):
        self.build()
        backend = embed.HashBackend()
        backend.identity = dict(backend.identity, model='changed')
        self.assertEqual(self.build(backend), (3, 0))
        (self.state / 'vectors/shows.f32').write_bytes(b'broken')
        with self.assertRaises(ValueError):
            self.load()
        self.assertEqual(self.build(), (3, 0))

    def test_failed_encoding_preserves_store(self):
        self.build()
        before = (self.state / 'vectors/shows.f32').read_bytes()
        backend = embed.HashBackend()
        backend.identity = {'backend': 'broken'}
        for output in ([], [[0]*384]*3, [[float('nan')]*384]*3, [[1]*2]*3):
            with patch.object(backend, 'encode', return_value=output):
                with self.assertRaises(ValueError):
                    self.build(backend)
            self.assertEqual((self.state / 'vectors/shows.f32').read_bytes(), before)
            self.load()

    def cli(self, *args):
        # -S disables site-packages: the entire hash/query/export path is stdlib-only.
        return subprocess.run([sys.executable, '-S', str(Path(embed.__file__)), '--state-dir', str(self.state), *args],
                              capture_output=True, text=True)

    def test_cli_export_and_reproducibility(self):
        result = self.cli('embed', '--backend', 'hash')
        self.assertEqual(result.returncode, 0, result.stderr)
        first = (self.state / 'vectors/shows.f32').read_bytes()
        other = self.state / 'other'
        embed.embed(self.meta, other, embed.HashBackend())
        self.assertEqual(first, (other / 'vectors/shows.f32').read_bytes())
        result = self.cli('neighbours', 'SPACE SCHOOL', '-k', '1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Planet Pals', result.stdout)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertNotEqual(self.cli('neighbours', 'missing').returncode, 0)
        self.assertNotEqual(self.cli('neighbours', 'Kitchen', '-k', '0').returncode, 0)
        result = self.cli('export')
        self.assertEqual(result.returncode, 0, result.stderr)
        space = json.loads((self.state / 'show-space.json').read_text())
        rows, vectors, _ = self.load()
        for i, row in enumerate(rows):
            neighbours = space[row['slug']]['next']
            self.assertEqual(len(neighbours), 2)
            self.assertNotIn(row['slug'], [slug for slug, _ in neighbours])
            self.assertEqual(neighbours, [[rows[j]['slug'], score] for j, score in embed.nearest(rows, vectors, i, 24)])

    def test_export_limit_empty_and_singleton(self):
        for i in range(26):
            (self.meta / f'extra-{i}.json').write_text(json.dumps({'name': f'Extra {i}'}))
        self.build()
        self.assertEqual(self.cli('export').returncode, 0)
        space = json.loads((self.state / 'show-space.json').read_text())
        self.assertTrue(all(len(row['next']) == 24 for row in space.values()))
        empty = self.state / 'empty'
        empty.mkdir()
        self.assertEqual(embed.embed(empty, self.state, embed.HashBackend()), (0, 0))
        self.assertEqual(self.cli('export').returncode, 0)
        self.assertEqual(json.loads((self.state / 'show-space.json').read_text()), {})
        (empty / 'one.json').write_text('{"name":"One"}')
        embed.embed(empty, self.state, embed.HashBackend())
        self.assertEqual(self.cli('neighbours', 'One').stdout, '')

    def test_missing_and_duplicate_input(self):
        with self.assertRaises(ValueError):
            embed.embed(self.state / 'absent', self.state, embed.HashBackend())
        (self.meta / 'duplicate.json').write_text('{"slug":"kitchen","name":"Duplicate"}')
        with self.assertRaises(ValueError):
            self.build()

    def test_ambiguous_names_and_ties(self):
        rows = [{'slug': 'b', 'name': 'Same'}, {'slug': 'a', 'name': 'Same'}, {'slug': 'c', 'name': 'Other'}]
        with self.assertRaises(ValueError):
            embed.lookup(rows, 'Same')
        self.assertEqual(embed.lookup(rows, 'b'), 0)
        self.assertEqual(embed.nearest(rows, [[1, 0]]*3, 2, 12), [(1, 1.0), (0, 1.0)])


if __name__ == '__main__':
    unittest.main()
