#!/usr/bin/env python3
"""Build one offline HTML player from structurally valid videos.

Re-run after changing the library. ffprobe must be installed. Its structural
check rejects incomplete MP4 containers but is not a full playback/decode test.
Learned preferences use library-relative paths, even for a staged output file.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

LIB = Path.home() / "Movies" / "kids-holiday"
HERE = Path(__file__).resolve().parent

# Families assign their own folders with --tiers. No bundled title list implies
# an age rating. Unknown folders stay in Everything until explicitly classified.
PRESCHOOL, SHARED, BIG, OLDER = set(), set(), set(), set()
TIERS = {"preschool": PRESCHOOL, "shared": SHARED, "big": BIG, "older": OLDER}
TIER_CONFIG = HERE / "tiers.json"

# Tiers that come from a whole source directory rather than a show name.
SOURCE_TIERS = ("grownup", "music")

# Stream id -> tiers it draws from. No stream is a superset of another by accident;
# to widen a stream, name the tier here.
STREAMS = {
    2: ("preschool", "shared"),
    6: ("shared", "big"),
    "grown": ("grownup",),
    "music": ("music",),
    "all": ("preschool", "shared", "big", "older", "grownup", "music"),
}
STREAM_NAMES = {2: "Little Kids", 6: "Big Kids", "grown": "Grown-ups",
                "music": "Music", "all": "Everything"}
SOURCES = HERE / "sources.json"

# Candidate formats for browser playback; exact support varies by browser/OS.
# Commonly unsupported containers and soundtracks are excluded with a reason.
PLAYABLE_SUFFIXES = {".mp4", ".m4v", ".webm"}
PLAYABLE_VIDEO = {"h264", "av1", "vp8", "vp9", "hevc"}
PLAYABLE_AUDIO = {"aac", "mp3", "opus", "vorbis", "flac"}
# Containers worth probing at all. Anything else is not media we can route.
MEDIA_SUFFIXES = {".mp4", ".m4v", ".webm", ".mkv", ".avi", ".mov"}


def tier_for(channel, warned=None, tiers=None):
    """Return the tier of a library folder, defaulting an unknown show to 'older'."""
    for name, shows in (TIERS if tiers is None else tiers).items():
        if channel in shows:
            return name
    if warned is not None and channel not in warned:
        warned.add(channel)
        print(f"Unclassified show {channel!r}: routed to 'older' (Everything only). "
              f"Assign it in a tiers JSON file and pass --tiers PATH.", file=sys.stderr)
    return "older"


def duplicate_tiers(tiers=None):
    """Any show listed in two tiers is a routing bug worth failing on."""
    seen, clashes = {}, []
    for name, shows in (TIERS if tiers is None else tiers).items():
        for show in shows:
            if show in seen:
                clashes.append(f"{show!r} in both {seen[show]} and {name}")
            seen[show] = name
    return clashes


def load_tiers(path=None):
    """Read folder -> stream routing, rejecting ambiguous or misspelled tiers."""
    path = (Path(path) if path is not None else TIER_CONFIG).expanduser()
    if not path.is_file():
        raise ValueError(f"Tier configuration does not exist: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or set(data) - set(TIERS):
        raise ValueError("Tiers must be an object with preschool, shared, big and/or older lists")
    tiers = {name: set() for name in TIERS}
    for name, shows in data.items():
        if not isinstance(shows, list) or any(
            not isinstance(show, str) or not show.strip() or "/" in show or "\0" in show
            for show in shows
        ):
            raise ValueError(f"Tier {name!r} must be a list of non-empty folder names")
        tiers[name] = set(shows)
    clashes = duplicate_tiers(tiers)
    if clashes:
        raise ValueError("A show is listed in more than one tier: " + "; ".join(clashes))
    return tiers


def load_sources(path=None, home=None):
    """Read optional roots and picks; relative paths are based on the config file."""
    home = Path(home or Path.home())
    path = Path(path or SOURCES).expanduser().resolve()
    def expand(value):
        if not isinstance(value, str) or not value.strip() or "\0" in value:
            raise ValueError("Each source needs a non-empty path")
        if value == "~" or value.startswith("~/"):
            return home / value[2:] if value != "~" else home
        result = Path(value)
        return result if result.is_absolute() else path.parent / result
    if not path.is_file():
        raise ValueError(f"Source configuration does not exist: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or set(data) - {"roots", "picks", "_comment"}:
        raise ValueError("Sources must be an object containing roots and/or picks lists")
    values = {}
    for kind in ("roots", "picks"):
        entries = data.get(kind, [])
        if not isinstance(entries, list):
            raise ValueError(f"Sources {kind!r} must be a list")
        values[kind] = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError(f"Each {kind} entry must be an object")
            classified = kind == "roots" and entry.get("classify") == "shows"
            if "classify" in entry and not classified:
                raise ValueError("Only roots may use classify, with the value 'shows'")
            tier = entry.get("tier", "older")
            if not classified and (not isinstance(tier, str) or tier not in set(TIERS) | set(SOURCE_TIERS)):
                raise ValueError(f"Unknown source tier: {entry.get('tier')!r}")
            if classified and "tier" in entry:
                raise ValueError("Choose either classify: shows or a fixed tier for a root")
            for field in ("label", "show", "title"):
                if field in entry and not isinstance(entry[field], str):
                    raise ValueError(f"Source {field} must be a string")
            values[kind].append(dict(entry, path=expand(entry.get("path"))))
    return values["roots"], values["picks"]


def probe_video(path, ffprobe="ffprobe"):
    """Return duration for a readable MP4 with a real video stream, or an error."""
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries",
             "format=duration:stream=codec_type,codec_name,width,height,duration",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=False,
        )
        if result.returncode or result.stderr.strip():
            return None, result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "ffprobe failed"
        data = json.loads(result.stdout)
        streams = [s for s in data.get("streams", [])
                   if s.get("codec_type") == "video" and s.get("codec_name") not in (None, "unknown")
                   and int(s.get("width", 0)) > 0 and int(s.get("height", 0)) > 0]
        if not streams:
            return None, "no usable video stream"
        if path.suffix.lower() not in PLAYABLE_SUFFIXES:
            return None, f"{path.suffix.lower()} container does not play in a browser; convert to a browser-compatible MP4 or WebM"
        video = streams[0].get("codec_name")
        if video not in PLAYABLE_VIDEO:
            return None, f"{video} video does not play in a browser; convert to a browser-compatible MP4 or WebM"
        audio = [s.get("codec_name") for s in data.get("streams", []) if s.get("codec_type") == "audio"]
        if audio and audio[0] not in PLAYABLE_AUDIO:
            return None, f"{audio[0]} audio does not play in a browser; convert to a browser-compatible MP4 or WebM"
        durations = [data.get("format", {}).get("duration")] + [s.get("duration") for s in streams]
        for value in durations:
            try:
                duration = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(duration) and duration > 0:
                return duration, None
        return None, "missing or invalid duration"
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired) as exc:
        return None, str(exc)


def clean_title(stem):
    return re.sub(r"\s*\[[\w-]{8,}\]$", "", stem)


def collect_videos(library, output, ffprobe="ffprobe", roots=None, picks=None, tiers=None):
    """Gather playable videos from every configured root plus the individual picks."""
    if roots is None:
        roots = [{"label": "", "path": library, "classify": "shows"}]
    videos, rejected, warned, seen = [], [], set(), {}

    def add(path, src, channel, title, tier):
        duration, error = probe_video(path, ffprobe)
        if error:
            rejected.append((src, error))
            return
        if src in seen:
            rejected.append((src, f"duplicate name; already used by {seen[src]}"))
            return
        seen[src] = str(path)
        videos.append({
            "src": src,
            "path": Path(os.path.relpath(path, output.parent)).as_posix(),
            "title": title, "channel": channel, "tier": tier, "duration": duration,
        })

    for root in roots:
        base = Path(root["path"])
        if not base.is_dir():
            continue
        label = root.get("label", "")
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in MEDIA_SUFFIXES or path.name.startswith("."):
                continue
            relative = path.relative_to(base)
            channel = relative.parts[0] if len(relative.parts) > 1 else (label or base.name)
            src = (label + "/" + relative.as_posix()) if label else relative.as_posix()
            tier = tier_for(channel, warned, tiers) if root.get("classify") == "shows" else root.get("tier", "older")
            add(path, src, channel, clean_title(path.stem), tier)

    for pick in picks or []:
        path = Path(pick["path"])
        if not path.is_file():
            rejected.append((pick.get("title") or str(path), "listed in sources.json but not on disk"))
            continue
        channel = pick.get("show") or path.parent.name
        title = pick.get("title") or clean_title(path.stem)
        add(path, channel + "/" + path.name, channel, title, pick.get("tier", "older"))

    return videos, rejected


def render_html(videos):
    # A filename containing </script> must never terminate the JSON script block.
    payload = json.dumps(videos, ensure_ascii=False).replace("<", "\\u003c")
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    template = (HERE / "player.html").read_text(encoding="utf-8")
    javascript = (HERE / "player.js").read_text(encoding="utf-8")
    return template.replace("__PLAYER_JS__", javascript).replace("__VIDEOS__", payload)


def atomic_write(output, content):
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                         prefix=".kids-shuffler-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, default=LIB)
    parser.add_argument("--output", type=Path, help="HTML output (default: LIBRARY/kids-shuffler.html)")
    parser.add_argument("--sources", type=Path, help="extra roots and picks (default: sources.json if present)")
    parser.add_argument("--tiers", type=Path, help="folder classification JSON (default: tiers.json if present)")
    parser.add_argument("--no-sources", action="store_true", help="use only --library, ignoring sources.json")
    args = parser.parse_args(argv)
    library = args.library.expanduser().resolve()
    output = (args.output or library / "kids-shuffler.html").expanduser().resolve()
    if not library.is_dir():
        parser.error(f"Library directory does not exist: {library}")
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        parser.error("ffprobe is required to validate the video library")
    try:
        tier_path = args.tiers or (TIER_CONFIG if TIER_CONFIG.is_file() else None)
        tiers = load_tiers(tier_path) if tier_path is not None else TIERS
        source_path = args.sources or (SOURCES if SOURCES.is_file() else None)
        roots, picks = load_sources(source_path) if not args.no_sources and source_path is not None else ([], [])
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    roots = [root for root in roots if Path(root["path"]) != library]
    roots = [{"label": "", "path": library, "classify": "shows"}] + roots
    # The kids library going missing or empty must never quietly publish a player
    # built only from the other roots. This is the mount-failure guard.
    if not any(path.is_file() and path.suffix.lower() in MEDIA_SUFFIXES
               for path in library.rglob("*")):
        parser.error(f"No playable videos found under {library}; existing output left unchanged")
    videos, rejected = collect_videos(library, output, ffprobe, roots, picks, tiers)
    for name, error in rejected:
        print(f"Excluded {name}: {error}", file=sys.stderr)
    if not videos:
        parser.error(f"No playable videos found under {library}; existing output left unchanged")
    atomic_write(output, render_html(videos))
    print(f"Wrote {output}: {len(videos)} videos; excluded {len(rejected)} invalid files")
    for stream, tiers in STREAMS.items():
        chosen = [v for v in videos if v["tier"] in tiers]
        if not chosen:
            print(f"  {STREAM_NAMES[stream]:<12}    0 videos  (button hidden until it has content)")
            continue
        hours = sum(v["duration"] for v in chosen) / 3600
        shows = len({v["channel"] for v in chosen})
        print(f"  {STREAM_NAMES[stream]:<12} {len(chosen):>4} videos  {shows:>3} shows  {hours:6.1f} h")


if __name__ == "__main__":
    main()
