import errno
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('make_shuffler', ROOT / 'make_shuffler.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class GeneratorTests(unittest.TestCase):
    def test_a_missing_extra_root_is_offline_and_does_not_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            library = Path(directory) / 'library'
            library.mkdir()
            missing = Path(directory) / 'Stash' / 'Movies'
            output = Path(directory) / 'out.html'
            output.write_text('previous catalogue')
            with self.assertRaises(generator.RootOffline) as caught:
                generator.collect_videos(library, output, roots=[
                    {'label': 'stash', 'path': missing, 'tier': 'older'},
                    {'label': '', 'path': library, 'classify': 'shows'},
                ])
            self.assertEqual(caught.exception.path, str(missing))
            self.assertEqual(caught.exception.errno, errno.ENOENT)
            self.assertEqual(output.read_text(), 'previous catalogue')

    def test_a_read_error_while_walking_a_root_is_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            library = Path(directory) / 'library'
            library.mkdir()
            real = Path.rglob

            def fail(self, pattern):
                if self == library:
                    raise OSError(errno.EIO, 'Input/output error')
                return real(self, pattern)

            with mock.patch.object(Path, 'rglob', fail):
                with self.assertRaises(generator.RootOffline) as caught:
                    generator.collect_videos(library, Path(directory) / 'out.html', roots=[
                        {'label': '', 'path': library, 'classify': 'shows'},
                    ])
            self.assertEqual(caught.exception.errno, errno.EIO)
            self.assertEqual(caught.exception.path, str(library))

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
        adult_streams = {'grown', 'both', 'sitcoms', 'scifi', 'adultanim', 'comedy',
                         'docs', 'classic', 'bbc', 'standup', 'd50', 'd60', 'd70', 'd80', 'd90'}
        self.assertEqual(set(generator.STREAMS), {2, 6, 'music', 'all'} | adult_streams)
        for stream in adult_streams:
            self.assertTrue(set(generator.STREAMS[stream]).isdisjoint({'preschool', 'shared', 'big'}))
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
            # The TV's own player takes both; the browser rules are unchanged afterwards.
            videos, rejected = generator.collect_videos(Path(directory), output, roots=roots, tv=True)
            self.assertEqual(sorted(v['src'] for v in videos), ['grown-ups/Films/Playable.mp4',
                             'grown-ups/Films/WrongAudio.mp4', 'grown-ups/Films/WrongContainer.mkv'])
            self.assertEqual(len(generator.collect_videos(Path(directory), output, roots=roots)[0]), 1)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_a_rebuild_probes_only_new_or_changed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'Films'
            root.mkdir(parents=True)
            base = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.2',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p']
            for name in ('A.mp4', 'B.mp4'):
                subprocess.run(base + [str(root / name)], check=True)
            (root / 'Broken.mp4').write_bytes(b'not a video')
            output = Path(directory) / 'stage' / 'out.html'
            roots = [{'label': 'grown-ups', 'path': Path(directory), 'tier': 'grownup'}]
            first_used, ticks = {}, []
            first = generator.collect_videos(Path(directory), output, roots=roots, cache={}, used=first_used,
                                             checkpoint=lambda: ticks.append(1))
            self.assertEqual(len(first_used), 3, 'every file, including the rejected one, is cached')
            self.assertEqual(len(ticks), 3, 'a checkpoint after each new probe, so a stopped build keeps them')
            generator.collect_videos(Path(directory), output, roots=roots, cache=first_used, used={},
                                     checkpoint=lambda: ticks.append(1))
            self.assertEqual(len(ticks), 3, 'cache hits are not new probes')
            calls = []
            real = generator.probe_video
            generator.probe_video = lambda path, *rest: (calls.append(path.name), real(path, *rest))[1]
            try:
                second_used = {}
                second = generator.collect_videos(Path(directory), output, roots=roots, cache=first_used, used=second_used)
                self.assertEqual(calls, [], 'nothing re-probed')
                self.assertEqual(second, first)
                subprocess.run(base + ['-t', '0.1', str(root / 'B.mp4')], check=True)   # B changes
                (root / 'A.mp4').rename(Path(directory) / 'A-moved-out.mp4')         # A leaves the library
                third_used = {}
                generator.collect_videos(Path(directory) / 'Films', output,
                                         roots=[{'label': 'grown-ups', 'path': root, 'tier': 'grownup'}],
                                         cache=second_used, used=third_used)
                self.assertEqual(calls, ['B.mp4'])
                self.assertEqual(len(third_used), 2, 'files no longer present drop out of the cache')
            finally:
                generator.probe_video = real

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

    def test_sports_is_a_valid_source_tier(self):
        self.assertIn('sports', generator.SOURCE_TIERS)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'sources.json'
            config.write_text(json.dumps({'roots': [
                {'label': 'sport', 'path': '~/Sports', 'tier': 'sports'}]}))
            roots, picks = generator.load_sources(config, home=Path(directory) / 'home')
            self.assertEqual(roots[0]['tier'], 'sports')
            self.assertEqual(roots[0]['path'], Path(directory) / 'home/Sports')
            self.assertEqual(picks, [])

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


class CloudManifestTests(unittest.TestCase):
    """22 Nov 2026: a title whose file has left the drives (it plays from the cloud copy) stays in the catalogue."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.library = self.base / 'library'
        (self.library / 'Example Show').mkdir(parents=True)
        self.output = self.base / 'out.html'
        self.probe = mock.patch.object(generator, 'probe_video', return_value=(60.0, None))
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def entry(self, size=1000, mtime=1731234567123456789, duration=1500.5):
        return {'size': size, 'mtime': mtime, 'duration': duration}

    def test_a_title_held_only_in_the_cloud_is_listed_from_the_manifest(self):
        here = self.library / 'Example Show' / 'Episode 1.mp4'
        here.write_bytes(b'x')
        gone = self.library / 'Example Show' / 'Episode 2.mp4'
        videos, rejected = generator.collect_videos(self.library, self.output, tiers={'shared': {'Example Show'}},
                                                    cloud={str(gone): self.entry()})
        self.assertEqual(rejected, [])
        by_src = {v['src']: v for v in videos}
        self.assertEqual(sorted(by_src), ['Example Show/Episode 1.mp4', 'Example Show/Episode 2.mp4'])
        self.assertNotIn('cloud', by_src['Example Show/Episode 1.mp4'])
        held = by_src['Example Show/Episode 2.mp4']
        self.assertEqual(held['cloud'], {'size': 1000, 'mtime': '1731234567123456789'})
        self.assertEqual((held['channel'], held['tier'], held['duration'], held['title']), ('Example Show', 'shared', 1500.5, 'Episode 2'))
        self.assertEqual(held['path'], 'library/Example Show/Episode 2.mp4')

    def test_a_file_on_the_drive_is_listed_from_the_drive_even_if_the_manifest_names_it(self):
        here = self.library / 'Example Show' / 'Episode 1.mp4'
        here.write_bytes(b'x')
        videos, _ = generator.collect_videos(self.library, self.output, cloud={str(here): self.entry(duration=9.0)})
        self.assertEqual(len(videos), 1)
        self.assertNotIn('cloud', videos[0])
        self.assertEqual(videos[0]['duration'], 60.0)

    def test_an_extra_root_keeps_its_label_and_fixed_tier_for_cloud_titles(self):
        (self.library / 'Example Show' / 'Episode 1.mp4').write_bytes(b'x')
        stash = self.base / 'Stash' / 'sitcoms'
        (stash / 'A Sitcom').mkdir(parents=True)
        gone = stash / 'A Sitcom' / 'S01E01.mkv'
        videos, _ = generator.collect_videos(self.library, self.output, roots=[
            {'label': '', 'path': self.library, 'classify': 'shows'},
            {'label': 'sitcoms', 'path': stash, 'tier': 'sitcom'}], cloud={str(gone): self.entry()})
        held = next(v for v in videos if 'cloud' in v)
        self.assertEqual((held['src'], held['channel'], held['tier']), ('sitcoms/A Sitcom/S01E01.mkv', 'A Sitcom', 'sitcom'))

    def test_a_pick_held_only_in_the_cloud_is_listed_and_one_that_is_simply_missing_is_still_refused(self):
        (self.library / 'Example Show' / 'Episode 1.mp4').write_bytes(b'x')
        films = self.base / 'films'
        held, lost = films / 'A Film (1950)' / 'A Film (1950).mp4', films / 'Lost' / 'Lost.mp4'
        videos, rejected = generator.collect_videos(self.library, self.output, picks=[
            {'path': str(held), 'title': 'A Film (1950)', 'show': 'Films', 'tier': 'grownup'},
            {'path': str(lost), 'title': 'Lost', 'show': 'Films', 'tier': 'grownup'}], cloud={str(held): self.entry()})
        film = next(v for v in videos if v['channel'] == 'Films')
        self.assertEqual((film['src'], film['title'], film['tier'], film['cloud']['size']), ('Films/A Film (1950).mp4', 'A Film (1950)', 'grownup', 1000))
        self.assertEqual(rejected, [('Lost', 'listed in sources.json but not on disk')])

    def test_manifest_entries_outside_every_root_hidden_or_not_video_are_ignored(self):
        (self.library / 'Example Show' / 'Episode 1.mp4').write_bytes(b'x')
        videos, _ = generator.collect_videos(self.library, self.output, cloud={
            str(self.base / 'elsewhere' / 'x.mp4'): self.entry(),
            str(self.library / 'Example Show' / '.hidden.mp4'): self.entry(),
            str(self.library / '.staging' / 'y.mp4'): self.entry(),
            str(self.library / 'Example Show' / 'notes.txt'): self.entry()})
        self.assertEqual([v['src'] for v in videos], ['Example Show/Episode 1.mp4'])

    def test_the_manifest_never_stands_in_for_a_drive_that_is_away(self):
        (self.library / 'Example Show' / 'Episode 1.mp4').write_bytes(b'x')
        missing = self.base / 'Stash' / 'Movies'
        with self.assertRaises(generator.RootOffline):
            generator.collect_videos(self.library, self.output, roots=[
                {'label': '', 'path': self.library, 'classify': 'shows'},
                {'label': 'stash', 'path': missing, 'tier': 'older'}], cloud={str(missing / 'A' / 'b.mp4'): self.entry()})

    def test_a_shelf_whose_files_have_all_left_is_listed_whole_as_long_as_its_folder_remains(self):
        # The mover must leave each root folder in place: a root that is missing means "drive away" and stops
        # the whole build (the test above). An empty one is simply a shelf that now lives in the cloud.
        (self.library / 'Example Show' / 'Episode 1.mp4').write_bytes(b'x')
        shelf = self.base / 'Stash' / 'sitcoms'
        shelf.mkdir(parents=True)
        cloud = {str(shelf / 'A Sitcom' / f'S01E0{n}.mp4'): self.entry(size=100 + n) for n in (1, 2, 3)}
        videos, rejected = generator.collect_videos(self.library, self.output, roots=[
            {'label': '', 'path': self.library, 'classify': 'shows'},
            {'label': 'sitcoms', 'path': shelf, 'tier': 'sitcom'}], cloud=cloud)
        self.assertEqual(rejected, [])
        self.assertEqual(sorted(v['src'] for v in videos if 'cloud' in v),
                         ['sitcoms/A Sitcom/S01E01.mp4', 'sitcoms/A Sitcom/S01E02.mp4', 'sitcoms/A Sitcom/S01E03.mp4'])

    def test_the_command_itself_lists_a_cloud_title_from_the_manifest_beside_the_catalogue(self):
        # Through main(), as the server runs it, with a real probe of the file that is on the drive.
        self.probe.stop()
        self.addCleanup(self.probe.start)
        here = self.library / 'Example Show' / 'Episode 1.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=0.2',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(here)], check=True)
        gone = self.library / 'Example Show' / 'Episode 2.mp4'
        output = self.base / 'tv-server' / 'catalogue.html'
        tiers = self.base / 'tiers.json'
        tiers.write_text(json.dumps({'shared': ['Example Show']}))
        command = ['python3', str(ROOT / 'make_shuffler.py'), '--library', str(self.library), '--tiers', str(tiers),
                   '--no-sources', '--output', str(output)]
        before = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(before.returncode, 0, before.stderr)
        self.assertIn('1 videos', before.stdout)
        generator.record_cloud(generator.cloud_manifest_path(output),
                               {'0|' + str(gone): {'size': 4321, 'mtime': 1731234567123456789, 'duration': 600.0, 'error': None}}, [str(gone)], tv=False)
        after = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertIn('2 videos', after.stdout)
        page = output.read_text()
        self.assertIn('"cloud": {"size": 4321, "mtime": "1731234567123456789"}', page)
        self.assertIn('Example Show/Episode 2.mp4', page)
        elsewhere = self.base / 'other' / 'manifest.json'
        elsewhere.parent.mkdir()
        elsewhere.write_text(json.dumps({'version': 1, 'entries': {}}))
        named = subprocess.run(command + ['--cloud-manifest', str(elsewhere)], capture_output=True, text=True)
        self.assertIn('1 videos', named.stdout)        # an explicit manifest replaces the one beside the catalogue

    def test_recording_copies_what_the_probe_cache_knows_and_loading_drops_anything_malformed(self):
        manifest = self.base / 'tv-server' / 'cloud-manifest.json'
        drive = '/Volumes' + '/Stash/Movies'
        a, b, c = drive + '/sitcoms/A/1.mp4', drive + '/sitcoms/A/2.mp4', drive + '/sitcoms/A/3.mkv'
        cache = {'1|' + a: {'size': 10, 'mtime': 111, 'duration': 5.0, 'error': None},
                 '1|' + b: {'size': 20, 'mtime': 222, 'duration': None, 'error': 'hevc video does not play in a browser'},
                 '0|' + c: {'size': 30, 'mtime': 333, 'duration': 7.0, 'error': None}}
        recorded, skipped = generator.record_cloud(manifest, cache, [a, b, c, drive + '/unknown.mp4'], tv=True)
        self.assertEqual(recorded, [a])
        self.assertEqual(sorted(skipped), sorted([b, c, drive + '/unknown.mp4']))
        self.assertEqual(generator.load_cloud_manifest(manifest), {a: {'size': 10, 'mtime': 111, 'duration': 5.0}})
        generator.record_cloud(manifest, {'1|' + c: {'size': 30, 'mtime': 333, 'duration': 7.0, 'error': None}}, [c], tv=True)
        self.assertEqual(sorted(generator.load_cloud_manifest(manifest)), [a, c])       # earlier entries are kept
        manifest.write_text(json.dumps({'version': 1, 'entries': {a: {'size': 10, 'mtime': 111, 'duration': 5.0},
                            'relative/path.mp4': {'size': 1, 'mtime': 1, 'duration': 1.0}, b: {'size': 0, 'mtime': 1, 'duration': 1.0},
                            c: {'size': 5, 'mtime': 'soon', 'duration': 1.0}}}))
        self.assertEqual(sorted(generator.load_cloud_manifest(manifest)), [a])
        self.assertEqual(generator.load_cloud_manifest(self.base / 'no-such-file.json'), {})
        manifest.write_text('not json')
        self.assertEqual(generator.load_cloud_manifest(manifest), {})


if __name__ == '__main__':
    unittest.main()
