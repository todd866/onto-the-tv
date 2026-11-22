#!/usr/bin/env python3
"""Build VLC playlists from a NUL-delimited inventory of existing phone files."""
import argparse
import json
from pathlib import Path, PurePosixPath
import sys

from make_shuffler import STREAMS, TIER_CONFIG, TIERS, atomic_write, clean_title, load_tiers, tier_for


def inventory_paths(raw, phone_root):
    root = PurePosixPath(phone_root)
    if not root.is_absolute() or ".." in root.parts:
        raise ValueError("Phone root must be an absolute path without '..'")
    paths = set()
    for value in raw.decode("utf-8").split("\0"):
        if not value:
            continue
        path = PurePosixPath(value)
        if ".." in path.parts:
            raise ValueError("Inventory contains a parent-directory traversal")
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if path.suffix.lower() != ".mp4" or any(part.startswith(".") for part in relative.parts):
            continue
        if "\n" in value or "\r" in value:
            raise ValueError("Newline filenames cannot be represented safely in M3U")
        paths.add(relative.as_posix())
    return sorted(paths)


def render_playlists(paths, playback_root, tiers):
    root = PurePosixPath(playback_root)
    if not root.is_absolute() or ".." in root.parts or any(c in playback_root for c in "\n\r\0"):
        raise ValueError("Playback root must be an absolute path without '..' or newlines")
    streams = [("Little Kids", 2), ("Big Kids", 6), ("Everything", "all")]
    classified = [(src, tier_for(src.split("/")[0], tiers=tiers)) for src in paths]
    result = {}
    for name, stream in streams:
        pool = [src for src, tier in classified if tier in STREAMS[stream]]
        lines = ["#EXTM3U", "#EXTENC:UTF-8", "#PLAYLIST:" + name]
        for src in pool:
            title = clean_title(PurePosixPath(src).stem)
            lines.extend([f"#EXTINF:-1,{src.split('/')[0]} — {title}", str(root / src)])
        result[name] = ("\n".join(lines) + "\n", len(pool))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True, help="NUL-delimited absolute paths from adb find -print0")
    parser.add_argument("--output", type=Path, required=True, help="Folder for generated .m3u playlists")
    parser.add_argument("--phone-root", default="/sdcard/Movies/kids-holiday")
    parser.add_argument("--playback-root", default="/storage/emulated/0/Movies/kids-holiday",
                        help="Absolute path VLC should open on Android")
    parser.add_argument("--tiers", type=Path, help="Same folder classification JSON as the offline player")
    args = parser.parse_args(argv)
    try:
        tier_path = args.tiers or (TIER_CONFIG if TIER_CONFIG.is_file() else None)
        tiers = load_tiers(tier_path) if tier_path is not None else TIERS
        paths = inventory_paths(args.inventory.read_bytes(), args.phone_root)
        playlists = render_playlists(paths, args.playback_root, tiers)
        for name, (content, _) in playlists.items():
            atomic_write(args.output / (name + ".m3u"), content)
        print(json.dumps({name: count for name, (_, count) in playlists.items()}))
        return 0
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
