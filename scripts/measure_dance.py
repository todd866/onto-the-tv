#!/usr/bin/env python3
"""Measure the Dance channel for the youngest viewer: a steady dance beat, and simple flashing lights.

15 Nov 2026: the youngest loves simple danceable techno with flashing lights. This reads a minute from the middle of each Dance video and
measures what that sentence describes:

  beat    how regular the pulse is (autocorrelation of the onset strength), how much of it is a kick
          drum on every beat, and whether the tempo is one to dance to
  lights  how much the whole picture's brightness jumps while the scene itself stays put (a strobe,
          a light show), as against cuts between scenes; how dark the frame is behind the light; how
          few cuts there are

Each measure is ranked against the rest of the channel, so no threshold is tuned by hand, and the
blend is written as 0..1 scores the TV server leans its picks by (docs/scored-channels.md).

  node bin/channel-members.js dance > members.jsonl
  python3 scripts/measure_dance.py --state DIR --members members.jsonl [--limit N] [--workers N]
  python3 scripts/measure_dance.py --state DIR --score OUT.json [--sheet OUT.png]

Needs ffmpeg, numpy and (for --sheet) Pillow. Measurements are cached in DIR/features.jsonl by file
size and time, so a stopped run resumes and a re-run only reads new videos.
"""
import argparse, json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np

FFMPEG = next((p for p in ('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg') if os.path.exists(p)), 'ffmpeg')
WINDOW, FPS, W, H, RATE = 60, 12, 32, 18, 11025


def run(args, timeout=180):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout).stdout


def window(duration):
    """A minute from the middle: intros and credits say little about the video."""
    length = min(WINDOW, duration) if duration > 0 else WINDOW
    start = max(0.0, min(duration * 0.35, duration - length - 5)) if duration > length else 0.0
    return start, length


def picture(path, start, length):
    raw = run([FFMPEG, '-v', 'error', '-ss', f'{start:.2f}', '-t', f'{length:.2f}', '-i', path, '-an',
               '-vf', f'fps={FPS},scale={W}:{H}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    frames = np.frombuffer(raw, dtype=np.uint8)
    count = frames.size // (W * H * 3)
    if count < FPS * 5:
        return None
    rgb = frames[:count * W * H * 3].reshape(count, H * W, 3).astype(np.float32) / 255.0
    luma = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    mean = luma.mean(axis=1)
    jump = np.abs(np.diff(mean))
    # Is it the same scene? Correlate each frame's pattern with the one before, brightness removed.
    centred = luma - mean[:, None]
    norm = np.linalg.norm(centred, axis=1) + 1e-6
    same = (centred[1:] * centred[:-1]).sum(axis=1) / (norm[1:] * norm[:-1])
    flat = norm[1:] < 0.02 * np.sqrt(W * H)          # a blank frame correlates with nothing
    held = (same > 0.6) | flat
    cuts = (same < 0.25) & ~flat
    # The pulse of the light: share of the brightness signal's power at dancing rates (1.5-5 Hz).
    spectrum = np.abs(np.fft.rfft((mean - mean.mean()) * np.hanning(count))) ** 2
    hz = np.fft.rfftfreq(count, 1.0 / FPS)
    band = spectrum[(hz >= 1.5) & (hz <= 5.0)].sum() / (spectrum[hz > 0.15].sum() + 1e-9)
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    return {
        'flash': float((jump * held).mean()),                       # brightness jumps with the scene intact
        'strobe': float(band * mean.std()),                         # ... that come at a beat's pace
        'cutsPerMin': float(cuts.sum() * 60.0 / (count / FPS)),
        'dark': float((luma < 0.12).mean()),
        'colour': float(spread[luma > 0.35].mean()) if (luma > 0.35).any() else 0.0,
        'detail': float(np.abs(np.diff(luma.reshape(count, H, W), axis=2)).mean()),
    }


def beat(path, start, length):
    raw = run([FFMPEG, '-v', 'error', '-ss', f'{start:.2f}', '-t', f'{length:.2f}', '-i', path, '-vn',
               '-ac', '1', '-ar', str(RATE), '-f', 's16le', '-'])
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    size, hop = 1024, 256
    if pcm.size < RATE * 5:
        return None
    count = 1 + (pcm.size - size) // hop
    index = np.arange(size)[None, :] + hop * np.arange(count)[:, None]
    spectrum = np.abs(np.fft.rfft(pcm[index] * np.hanning(size), axis=1))
    spectrum = np.log1p(20 * spectrum)
    rise = np.maximum(0, np.diff(spectrum, axis=0))
    onset, kick = rise.sum(axis=1), rise[:, :14].sum(axis=1)       # bins under about 150 Hz: the kick
    rate = RATE / hop                                               # onset frames a second

    def pulse(signal):
        signal = signal - signal.mean()
        full = np.correlate(signal, signal, 'full')[signal.size - 1:]
        full = full / (full[0] + 1e-9)
        lags = np.arange(int(rate * 60 / 180), int(rate * 60 / 70))   # 70 to 180 beats a minute
        # A dotted rhythm repeats at 4/3 of the beat too. The beat is the rate whose double also repeats,
        # and the one nearest two a second, which is where people hear a beat.
        prior = np.exp(-0.5 * (np.log2((60.0 * rate / lags) / 122.0) / 0.6) ** 2)
        support = full[lags] + 0.5 * full[np.minimum(2 * lags, full.size - 1)]
        best = lags[np.argmax(support * prior)]
        return float(full[best]), 60.0 * rate / best

    clarity, bpm = pulse(onset)
    kicking, _ = pulse(kick)
    # Halves and doubles are the same dance: fold the tempo into 90-180.
    while bpm < 90: bpm *= 2
    while bpm >= 180: bpm /= 2
    return {'pulse': max(0.0, clarity), 'kick': max(0.0, kicking), 'bpm': round(bpm, 1),
            'loud': float(np.sqrt((pcm ** 2).mean()))}


def measure(item):
    path = item['file']
    try:
        info = os.stat(path)
    except OSError as error:
        return {'src': item['src'], 'error': str(error)}
    start, length = window(float(item.get('duration') or 0))
    out = {'src': item['src'], 'show': item.get('show', ''), 'title': item.get('title', ''), 'file': path,
           'size': info.st_size, 'mtime': int(info.st_mtime), 'start': round(start, 1)}
    try:
        seen, heard = picture(path, start, length), beat(path, start, length)
    except Exception as error:                                       # one unreadable video must not stop the run
        return {**out, 'error': f'{type(error).__name__}: {error}'}
    if not seen or not heard:
        return {**out, 'error': 'too short to measure'}
    return {**out, **seen, **heard}


def load(state):
    rows = {}
    try:
        with open(os.path.join(state, 'features.jsonl'), encoding='utf-8') as handle:
            for line in handle:
                try: row = json.loads(line)
                except ValueError: continue
                rows[row['src']] = row
    except FileNotFoundError:
        pass
    return rows


def ranks(values):
    order = np.argsort(np.argsort(values))
    return order / max(1, len(values) - 1)


def tempo_fit(bpm):
    """1 at a dancing tempo (112-140), easing to 0.3 by 95 and 165."""
    if 112 <= bpm <= 140: return 1.0
    edge = (112 - bpm) / 17 if bpm < 112 else (bpm - 140) / 25
    return float(max(0.3, 1.0 - 0.7 * min(1.0, edge)))


def score(rows):
    good = [row for row in rows if 'error' not in row]
    column = lambda key: np.array([row[key] for row in good], dtype=np.float64)
    beat_part = 0.5 * ranks(column('pulse')) + 0.3 * ranks(column('kick')) + 0.2 * np.array([tempo_fit(row['bpm']) for row in good])
    light_part = (0.45 * ranks(column('flash')) + 0.25 * ranks(column('strobe')) + 0.15 * ranks(-column('cutsPerMin'))
                  + 0.10 * ranks(column('dark')) + 0.05 * ranks(-column('detail')))
    blend = ranks(0.5 * ranks(beat_part) + 0.5 * ranks(light_part))
    for row, b, l, s in zip(good, ranks(beat_part), ranks(light_part), blend):
        row['beatRank'], row['lightRank'], row['score'] = round(float(b), 3), round(float(l), 3), round(float(s), 3)
    return sorted(good, key=lambda row: -row['score'])


def sheet(rows, path, each=14):
    """Top and bottom of the ranking as strips of frames, to look at before trusting the numbers."""
    from PIL import Image, ImageDraw
    picks = [('most', row) for row in rows[:each]] + [('least', row) for row in rows[-each:]]
    tile_w, tile_h, frames, label_h = 144, 81, 6, 16
    image = Image.new('RGB', (tile_w * frames, (tile_h + label_h) * len(picks)), (11, 20, 40))
    draw = ImageDraw.Draw(image)
    for n, (kind, row) in enumerate(picks):
        top = n * (tile_h + label_h)
        raw = run([FFMPEG, '-v', 'error', '-ss', f"{row['start']:.2f}", '-t', str(WINDOW), '-i', row['file'], '-an',
                   '-vf', f'fps={frames}/{WINDOW},scale={tile_w}:{tile_h}', '-frames:v', str(frames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        got = len(raw) // (tile_w * tile_h * 3)
        for i in range(got):
            chunk = raw[i * tile_w * tile_h * 3:(i + 1) * tile_w * tile_h * 3]
            image.paste(Image.frombytes('RGB', (tile_w, tile_h), chunk), (i * tile_w, top + label_h))
        text = (f"{kind} {row['score']:.2f}  beat {row['beatRank']:.2f} ({row['bpm']:.0f} bpm, pulse {row['pulse']:.2f}, kick {row['kick']:.2f})  "
                f"light {row['lightRank']:.2f} (flash {row['flash']*1000:.1f}, cuts {row['cutsPerMin']:.0f}/min, dark {row['dark']:.2f})  "
                f"{row['show']} - {row['title']}")[:150]
        draw.text((4, top + 2), text, fill=(255, 181, 71) if kind == 'most' else (154, 170, 202))
    image.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--state', required=True)
    parser.add_argument('--members', help='channel-members.js output; standard input when absent')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--workers', type=int, default=int(os.environ.get('HEAVY_SLOT_WORKERS') or 2))
    parser.add_argument('--score')
    parser.add_argument('--sheet')
    parser.add_argument('--channel', default='dance')
    args = parser.parse_args()
    os.makedirs(args.state, exist_ok=True)
    rows = load(args.state)
    if not args.score and not args.sheet:
        with (open(args.members, encoding='utf-8') if args.members else sys.stdin) as source:
            items = [json.loads(line) for line in source if line.strip()]
        todo = []
        for item in items:
            row = rows.get(item['src'])
            try: info = os.stat(item['file'])
            except OSError: info = None
            if row and info and row.get('size') == info.st_size and row.get('mtime') == int(info.st_mtime) and 'error' not in row: continue
            todo.append(item)
        if args.limit: todo = todo[:args.limit]
        print(f'{len(items)} on the channel, {len(items) - len(todo)} already measured, measuring {len(todo)} with {args.workers} at a time', flush=True)
        began, done = time.time(), 0
        with open(os.path.join(args.state, 'features.jsonl'), 'a', encoding='utf-8') as handle, ThreadPoolExecutor(args.workers) as pool:
            for row in pool.map(measure, todo):
                handle.write(json.dumps(row, ensure_ascii=False) + '\n'); handle.flush()
                done += 1
                if done % 20 == 0 or done == len(todo):
                    print(f'{done}/{len(todo)}  {time.time() - began:.0f}s  last: {row.get("error") or row["src"][:70]}', flush=True)
        return
    ranked = score(list(rows.values()))
    if args.score:
        payload = {'version': 1, 'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                   'channels': {args.channel: {'items': {row['src']: {'score': row['score'],
                       'why': f"beat {row['beatRank']:.2f} at {row['bpm']:.0f} bpm, light {row['lightRank']:.2f}"} for row in ranked}}}}
        temp = args.score + '.tmp'
        with open(temp, 'w', encoding='utf-8') as handle: json.dump(payload, handle, ensure_ascii=False, indent=1)
        os.replace(temp, args.score)
        print(f'{len(ranked)} scored -> {args.score}; {sum(1 for row in rows.values() if "error" in row)} could not be measured')
    if args.sheet:
        sheet(ranked, args.sheet)
        print(f'sheet -> {args.sheet}')


if __name__ == '__main__':
    main()
