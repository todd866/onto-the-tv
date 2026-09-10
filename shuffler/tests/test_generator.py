import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('make_shuffler', ROOT / 'make_shuffler.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class GeneratorTests(unittest.TestCase):
    def test_embedded_filenames_cannot_close_script(self):
        payload = [{'src': 'odd.mp4', 'title': '</script><img src=x>\u2028 __PLAYER_JS__'}]
        html = generator.render_html(payload)
        raw = html.split('const VIDEOS = ', 1)[1].split(';</script>', 1)[0]
        self.assertEqual(json.loads(raw), payload)
        self.assertNotIn('</script>', raw)
        self.assertIn('\\u003c/script>', raw)
        self.assertNotIn('src="player.js"', html)

    def test_atomic_write_replaces_existing_and_leaves_no_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'player.html'
            output.write_text('original')
            generator.atomic_write(output, 'new content')
            self.assertEqual(output.read_text(), 'new content')
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['player.html'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_real_probe_includes_tiny_valid_clip_and_excludes_corrupt_or_audio_only_mp4(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            library = root / 'library'
            channel = library / 'Example Show'
            channel.mkdir(parents=True)
            valid = channel / 'Mini #1? [abcdefgh].mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=0.2',
                            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(valid)], check=True)
            self.assertLess(valid.stat().st_size, 10_000_000)
            (channel / 'broken.mp4').write_bytes(b'not a movie')
            (channel / 'unfinished.mp4.part').write_bytes(b'partial')
            audio = channel / 'sound.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
                            '-t', '0.2', '-c:a', 'aac', str(audio)], check=True)
            output = root / 'stage' / 'kids-shuffler.html'
            videos, rejected = generator.collect_videos(library, output, tiers={"shared": {"Example Show"}})
            self.assertEqual(len(videos), 1)
            self.assertEqual(videos[0]['title'], 'Mini #1?')
            self.assertEqual(videos[0]['src'], 'Example Show/Mini #1? [abcdefgh].mp4')
            self.assertEqual(videos[0]['path'], '../library/Example Show/Mini #1? [abcdefgh].mp4')
            self.assertEqual(videos[0]['tier'], 'shared')
            self.assertGreater(videos[0]['duration'], 0)
            self.assertEqual({name for name, _ in rejected}, {'Example Show/broken.mp4', 'Example Show/sound.mp4'})
            tiers = root / 'tiers.json'
            tiers.write_text(json.dumps({'shared': ['Example Show']}))
            result = subprocess.run(['python3', str(ROOT / 'make_shuffler.py'), '--library', str(library),
                                     '--tiers', str(tiers), '--no-sources', '--output', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())
            self.assertIn('excluded 2 invalid files', result.stdout)
            self.assertIn('Little Kids', result.stdout)
            self.assertIn('\"tier\": \"shared\"', output.read_text())

    def test_empty_library_leaves_existing_output_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'kids-shuffler.html'
            output.write_text('old player')
            result = subprocess.run(['python3', str(ROOT / 'make_shuffler.py'), '--library', directory, '--no-sources'],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(), 'old player')


class TierTests(unittest.TestCase):
    def test_streams_remain_explicit_and_unknown_shows_never_reach_kid_streams(self):
        self.assertEqual(generator.duplicate_tiers(), [])
        self.assertEqual(set(generator.STREAMS), {2, 6, 'grown', 'music', 'all'})
        self.assertEqual(set(generator.STREAMS) - set(generator.STREAM_NAMES), set())
        self.assertEqual(generator.STREAMS[2], ('preschool', 'shared'))
        self.assertEqual(generator.STREAMS[6], ('shared', 'big'))
        self.assertEqual(set().union(*generator.TIERS.values()), set())

    def test_external_tiers_classify_show_folders_without_changing_global_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'tiers.json'
            config.write_text(json.dumps({'shared': ['Example Show'], 'big': ['Another Show']}))
            tiers = generator.load_tiers(config)
            self.assertEqual(generator.tier_for('Example Show', tiers=tiers), 'shared')
            self.assertEqual(generator.tier_for('Another Show', tiers=tiers), 'big')
            self.assertEqual(generator.tier_for('Example Show'), 'older')
            self.assertEqual(tiers['preschool'], set())

    def test_tiers_reject_ambiguous_names_invalid_shapes_and_missing_explicit_file(self):
        invalid = [[], {'share': ['Example Show']}, {'shared': 'Example Show'},
                   {'shared': [3]}, {'shared': ['']}, {'shared': ['nested/show']},
                   {'shared': ['Example Show'], 'big': ['Example Show']}]
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'tiers.json'
            with self.assertRaises(ValueError):
                generator.load_tiers(config)
            for value in invalid:
                with self.subTest(value=value):
                    config.write_text(json.dumps(value))
                    with self.assertRaises(ValueError):
                        generator.load_tiers(config)

    def test_an_unlisted_show_is_routed_to_older_with_a_warning(self):
        warned = set()
        self.assertEqual(generator.tier_for('Brand New Channel', warned), 'older')
        self.assertEqual(warned, {'Brand New Channel'})
        self.assertNotIn('older', generator.STREAMS[2])
        self.assertNotIn('older', generator.STREAMS[6])
        for stream in (2, 6):
            for source_tier in generator.SOURCE_TIERS:
                self.assertNotIn(source_tier, generator.STREAMS[stream],
                                 f'{source_tier} must not reach a kids stream')



class SourceTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_browser_unplayable_media_is_excluded_with_a_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'Films'
            root.mkdir(parents=True)
            base = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.2',
                    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.2', '-shortest']
            good = root / 'Playable.mp4'
            subprocess.run(base + ['-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', str(good)], check=True)
            mkv = root / 'WrongContainer.mkv'
            subprocess.run(base + ['-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', str(mkv)], check=True)
            ac3 = root / 'WrongAudio.mp4'
            subprocess.run(base + ['-c:v', 'libx264', '-c:a', 'ac3', '-pix_fmt', 'yuv420p', str(ac3)], check=True)
            output = Path(directory) / 'stage' / 'out.html'
            roots = [{'label': 'grown-ups', 'path': Path(directory), 'tier': 'grownup'}]
            videos, rejected = generator.collect_videos(Path(directory), output, roots=roots)
            self.assertEqual([v['src'] for v in videos], ['grown-ups/Films/Playable.mp4'])
            self.assertEqual(videos[0]['tier'], 'grownup')
            self.assertEqual(videos[0]['channel'], 'Films')
            reasons = dict(rejected)
            self.assertIn('.mkv container', reasons['grown-ups/Films/WrongContainer.mkv'])
            self.assertIn('ac3 audio', reasons['grown-ups/Films/WrongAudio.mp4'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_an_empty_library_is_refused_even_when_other_sources_have_videos(self):
        with tempfile.TemporaryDirectory() as directory:
            empty = Path(directory) / 'library'
            empty.mkdir()
            other = Path(directory) / 'grown-ups' / 'Films'
            other.mkdir(parents=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.2',
                            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(other / 'A.mp4')], check=True)
            sources = Path(directory) / 'sources.json'
            sources.write_text(json.dumps({'roots': [
                {'label': 'grown-ups', 'path': str(Path(directory) / 'grown-ups'), 'tier': 'grownup'}]}))
            output = Path(directory) / 'out.html'
            result = subprocess.run(['python3', str(ROOT / 'make_shuffler.py'), '--library', str(empty),
                                     '--sources', str(sources), '--output', str(output)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_source_paths_expand_home_or_resolve_relative_to_the_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'sources.json'
            config.write_text(json.dumps({'roots': [
                {'label': 'extra', 'path': './clips', 'classify': 'shows'},
                {'label': 'music', 'path': '~/Music/Videos', 'tier': 'music'}],
                'picks': [{'path': 'one.mp4', 'tier': 'grownup'}]}))
            roots, picks = generator.load_sources(config, home=Path(directory) / 'home')
            self.assertEqual(roots[0]['path'], Path(directory).resolve() / 'clips')
            self.assertEqual(roots[1]['path'], Path(directory) / 'home/Music/Videos')
            self.assertEqual(picks[0]['path'], Path(directory).resolve() / 'one.mp4')

    def test_sources_reject_invalid_shape_tier_and_explicit_missing_file(self):
        invalid = [[], {'root': []}, {'roots': {}}, {'picks': [3]},
                   {'roots': [{'path': 42}]},
                   {'roots': [{'path': 'clips', 'tier': []}]},
                   {'roots': [{'path': 'clips', 'tier': 'shared-typo'}]},
                   {'roots': [{'path': 'clips', 'classify': 'show'}]},
                   {'roots': [{'path': 'clips', 'classify': 'shows', 'tier': 'big'}]}]
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'sources.json'
            with self.assertRaises(ValueError):
                generator.load_sources(config)
            for value in invalid:
                with self.subTest(value=value):
                    config.write_text(json.dumps(value))
                    with self.assertRaises(ValueError):
                        generator.load_sources(config)

    def test_existing_source_comments_do_not_change_library_routing(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'sources.json'
            config.write_text(json.dumps({'_comment': ['Private setup notes'],
                'roots': [{'path': 'clips', 'classify': 'shows'}], 'picks': []}))
            roots, picks = generator.load_sources(config)
            self.assertEqual(roots[0]['classify'], 'shows')
            self.assertEqual(roots[0]['path'], Path(directory).resolve() / 'clips')
            self.assertEqual(picks, [])


if __name__ == '__main__':
    unittest.main()
