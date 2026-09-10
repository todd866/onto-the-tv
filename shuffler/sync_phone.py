#!/usr/bin/env python3
"""Validate and safely sync completed MP4s to one explicitly selected Android.

Dry run is the default. --apply copies via an owned temporary file, checks its
SHA-256, and atomically renames it. Nothing is deleted to recover space. Existing
files with the same relative path and size are skipped (not checksum-verified).
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import uuid

GIB = 1024**3
DEFAULT_LIBRARY = Path.home() / "Movies/kids-holiday"
DEFAULT_DEST = "/sdcard/Movies/kids-holiday"
DEFAULT_EXCLUSIONS = Path(__file__).with_name("phone-exclusions.json")


class SyncError(RuntimeError):
    pass


class ReserveError(SyncError):
    pass


def run_command(argv: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess:
    """No host shell: a filename can never become a command on this computer."""
    try:
        return subprocess.run(
            argv, stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=timeout, check=False,
        )
    except FileNotFoundError as exc:
        raise SyncError(f"Required program is unavailable: {argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise SyncError(f"Command timed out after {timeout}s: {argv[0]}") from exc


def checked(result: subprocess.CompletedProcess, action: str) -> str:
    if result.returncode:
        detail = (result.stderr or result.stdout or "no error text").strip()
        raise SyncError(f"{action} failed (exit {result.returncode}): {detail[:1000]}")
    return result.stdout.strip()


def select_device(serial: str | None, runner=run_command) -> str:
    listing = checked(runner(["adb", "devices", "-l"]), "Listing Android devices")
    devices = {}
    for line in listing.splitlines():
        if not line.strip() or line.startswith("List of devices") or line.startswith("*"):
            continue
        fields = line.split()
        if len(fields) >= 2:
            devices[fields[0]] = fields[1]
    if serial is None:
        if len(devices) != 1:
            raise SyncError(
                f"Expected exactly one connected Android; found {len(devices)}. "
                "Connect/unlock the intended phone, or specify --serial SERIAL."
            )
        serial = next(iter(devices))
    state = devices.get(serial)
    if state != "device":
        raise SyncError(
            f"Android {serial!r} is {state or 'not connected'}. "
            "Unlock the phone and accept its USB debugging prompt."
        )
    return serial


def safe_relative(value: str) -> str:
    if not isinstance(value, str) or not value or "\0" in value:
        raise SyncError(f"Invalid exclusion path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ("", ".", "..") for p in value.split("/")):
        raise SyncError(f"Exclusion must be an exact, safe relative file path: {value!r}")
    return path.as_posix()


def load_exclusions(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SyncError(f"Cannot read exclusions {path}: {exc}") from exc
    if isinstance(value, dict):
        if "exclude" not in value:
            raise SyncError(f"{path} must contain an 'exclude' list.")
        value = value["exclude"]
    if not isinstance(value, list):
        raise SyncError(f"{path} must be a list or an object with an 'exclude' list.")
    return {safe_relative(item) for item in value}


def is_completed_name(path: Path) -> bool:
    name = path.name.lower()
    if path.suffix.lower() != ".mp4" or any(part.startswith(".") for part in path.parts):
        return False
    if re.search(r"(?:^|[._-])(?:part|tmp|temp)(?:[._-]|$)", name):
        return False
    # yt-dlp's separate video/audio streams are not the final merged download.
    return re.search(r"\.f\d+[a-z0-9_-]*\.mp4$", name) is None


@dataclass(frozen=True)
class Video:
    path: Path
    relative: str
    size: int
    mtime_ns: int

    def assert_unchanged(self) -> None:
        info = self.path.stat()
        if self.path.is_symlink() or (info.st_size, info.st_mtime_ns) != (self.size, self.mtime_ns):
            raise SyncError(f"Local file changed during sync: {self.relative!r}; retry when downloads finish.")


def validate_video(path: Path, relative: str, runner=run_command) -> Video:
    before = path.stat()
    if path.is_symlink() or before.st_size == 0:
        raise SyncError("empty file or symbolic link")
    probe_result = runner([
        "ffprobe", "-v", "error", "-show_entries",
        "format=format_name,duration,size:stream=codec_type,codec_name",
        "-of", "json", str(path),
    ])
    raw = checked(probe_result, f"Validating {relative!r}")
    # ffprobe can exit zero while reporting corrupt packet/stream errors. With
    # '-v error', any stderr means this file must not be treated as validated.
    if probe_result.stderr.strip():
        raise SyncError(f"ffprobe reported media errors: {probe_result.stderr.strip()[:1000]}")
    try:
        probe = json.loads(raw)
        metadata = probe["format"]
        duration = float(metadata["duration"])
        size = int(metadata["size"])
        formats = metadata["format_name"].split(",")
        video_stream = any(s.get("codec_type") == "video" and s.get("codec_name")
                           for s in probe.get("streams", []))
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise SyncError("ffprobe returned incomplete or invalid media metadata") from exc
    if "mp4" not in formats or not video_stream or not math.isfinite(duration) or duration <= 0:
        raise SyncError("not a valid, positive-duration MP4 with a video stream")
    if size != before.st_size:
        raise SyncError("file size changed during validation")
    video = Video(path, relative, before.st_size, before.st_mtime_ns)
    video.assert_unchanged()
    return video


@dataclass
class Scan:
    videos: list[Video] = field(default_factory=list)
    excluded: int = 0
    invalid: list[tuple[str, str]] = field(default_factory=list)


def scan_library(library: Path, exclusions: set[str], runner=run_command, emit=print) -> Scan:
    if not library.is_dir():
        raise SyncError(f"Library directory does not exist: {library}")
    result = Scan()
    for path in sorted(library.rglob("*")):
        relative_path = path.relative_to(library)
        if not path.is_file() or not is_completed_name(relative_path):
            continue
        relative = relative_path.as_posix()
        if relative in exclusions:
            result.excluded += 1
            emit(f"EXCLUDE {relative!r}")
            continue
        try:
            result.videos.append(validate_video(path, relative, runner))
        except (SyncError, OSError) as exc:
            result.invalid.append((relative, str(exc)))
            emit(f"INVALID {relative!r}: {exc}")
        if (len(result.videos) + len(result.invalid)) % 50 == 0:
            emit(f"Validated {len(result.videos)} completed MP4s...")
    return result


def remote_command(arguments: list[str]) -> str:
    """adb shell executes remotely through sh, even with host argument arrays."""
    return shlex.join(arguments)


class Android:
    def __init__(self, serial: str, destination: str, runner=run_command):
        path = PurePosixPath(destination)
        if not path.is_absolute() or ".." in path.parts or "\0" in destination:
            raise SyncError("Phone destination must be an absolute path without '..'.")
        if path.as_posix() == "/":
            raise SyncError("Choose a dedicated phone destination directory, not '/'.")
        self.serial = serial
        self.destination = path.as_posix()
        self.runner = runner

    def shell(self, command: str, action: str, *, timeout: int = 120) -> str:
        return checked(self.runner(["adb", "-s", self.serial, "shell", command], timeout=timeout), action)

    def remote_path(self, relative: str) -> str:
        return f"{self.destination}/{safe_relative(relative)}"

    def size(self, path: str) -> int | None:
        quoted = shlex.quote(path)
        command = (
            f"if [ -L {quoted} ]; then echo 'Refusing a symbolic-link target' >&2; exit 8; "
            f"elif [ -e {quoted} ]; then [ -f {quoted} ] || exit 9; stat -c %s {quoted}; "
            "else printf 'MISSING\\n'; fi"
        )
        raw = self.shell(command, f"Reading phone file {path!r}")
        if raw == "MISSING":
            return None
        if not re.fullmatch(r"\d+", raw):
            raise SyncError(f"Unexpected phone size for {path!r}: {raw!r}")
        return int(raw)

    def free_bytes(self) -> int:
        # Query the destination's nearest existing ancestor; dry runs create nothing.
        command = (
            f"p={shlex.quote(self.destination)}; "
            'while [ ! -d "$p" ]; do '
            '[ ! -e "$p" ] && [ ! -L "$p" ] || exit 8; '
            'p=${p%/*}; [ -n "$p" ] || p=/; done; df -kP "$p"'
        )
        raw = self.shell(command, "Checking phone storage")
        for line in reversed(raw.splitlines()):
            fields = line.split()
            if len(fields) >= 6 and all(re.fullmatch(r"\d+", part) for part in fields[1:4]):
                return int(fields[3]) * 1024
        raise SyncError(f"Could not interpret phone free-space report: {raw!r}")

    def ensure_directory(self, path: str) -> None:
        # /sdcard itself is normally an Android-managed symlink; reject symlinks
        # inside our library so filenames cannot redirect copies elsewhere.
        relative = PurePosixPath(path).relative_to(self.destination)
        ancestors = [self.destination]
        current = self.destination
        for part in relative.parts:
            current += "/" + part
            ancestors.append(current)
        guards = [f"[ ! -L {shlex.quote(parent)} ] || exit 8" for parent in ancestors]
        self.shell("; ".join(guards + [remote_command(["mkdir", "-p", path])]), "Creating phone folder")

    def sha256(self, path: str) -> str:
        output = self.shell(f"sha256sum < {shlex.quote(path)}", "Checking transferred SHA-256", timeout=600)
        match = re.fullmatch(r"([a-fA-F0-9]{64})\s+-", output)
        if not match:
            raise SyncError(f"Unexpected phone SHA-256 response: {output!r}")
        return match[1].lower()

    def push(self, local: Path, remote: str) -> None:
        checked(self.runner(
            ["adb", "-s", self.serial, "push", str(local), remote], timeout=1800,
        ), "Transferring video")

    def rename(self, source: str, destination: str) -> None:
        self.shell(remote_command(["mv", "-f", source, destination]), "Committing verified video")

    def cleanup(self, path: str) -> None:
        if not re.fullmatch(r"\.codex-sync-[a-f0-9]{32}\.part", PurePosixPath(path).name):
            raise SyncError("Refusing to clean an unowned phone path")
        self.shell(remote_command(["rm", "-f", path]), "Removing owned staging file")


@dataclass(frozen=True)
class Copy:
    video: Video
    old_size: int | None


def needed_free_bytes(copies: list[Copy], reserve: int) -> int:
    """Peak storage includes staging a replacement before its predecessor is freed."""
    growth = 0
    peak = 0
    for item in copies:
        peak = max(peak, growth + item.video.size)
        growth += item.video.size - (item.old_size or 0)
    return reserve + peak


def require_reserve(free: int, required: int, reserve: int) -> None:
    if free < required:
        raise ReserveError(
            f"Phone has {free / GIB:.2f} GiB free; {required / GIB:.2f} GiB is required "
            f"to preserve the {reserve / GIB:.2f} GiB reserve. "
            f"Free at least {(required - free) / GIB:.2f} GiB "
            f"({required - free:,} bytes), exclude more videos in phone-exclusions.json, "
            "or explicitly choose another --reserve-gib value. No videos were deleted."
        )


def local_sha256(video: Video) -> str:
    video.assert_unchanged()
    digest = hashlib.sha256()
    with video.path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    video.assert_unchanged()
    return digest.hexdigest()


def copy_verified(android: Android, item: Copy, reserve: int) -> None:
    video = item.video
    destination = android.remote_path(video.relative)
    folder = str(PurePosixPath(destination).parent)
    stage = f"{folder}/.codex-sync-{uuid.uuid4().hex}.part"
    digest = local_sha256(video)
    require_reserve(android.free_bytes(), reserve + video.size, reserve)
    android.ensure_directory(folder)
    try:
        android.push(video.path, stage)
        video.assert_unchanged()
        if android.size(stage) != video.size:
            raise SyncError(f"Transferred size differs for {video.relative!r}")
        if android.sha256(stage) != digest:
            raise SyncError(f"SHA-256 mismatch for {video.relative!r}; existing file was preserved")
        require_reserve(android.free_bytes(), reserve, reserve)
        if android.size(destination) != item.old_size:
            raise SyncError(f"Phone target changed during sync: {video.relative!r}; existing file was preserved")
        android.rename(stage, destination)
    finally:
        # Only this invocation's randomly named stage is ever removed. A cleanup
        # failure must be reported, not converted into a successful sync.
        android.cleanup(stage)


def sync(android: Android, scan: Scan, *, apply: bool, reserve: int, emit=print) -> int:
    copies = []
    skipped = copied = failed = blocked = 0
    for video in scan.videos:
        old_size = android.size(android.remote_path(video.relative))
        if old_size == video.size:
            skipped += 1
            emit(f"SKIP {video.relative!r} (same size; not hashed)")
        else:
            copies.append(Copy(video, old_size))
    free = android.free_bytes()
    required = needed_free_bytes(copies, reserve)
    emit(f"Storage: {free / GIB:.2f} GiB free; {required / GIB:.2f} GiB required including reserve.")
    try:
        require_reserve(free, required, reserve)
    except ReserveError as exc:
        blocked = len(copies)
        emit(f"BLOCKED: {exc}")
        emit(f"Summary: copied=0 same_size={skipped} planned={len(copies)} blocked={blocked} "
             f"excluded={scan.excluded} invalid={len(scan.invalid)}; sync incomplete.")
        return 1
    if not apply:
        for item in copies:
            emit(f"WOULD COPY {item.video.relative!r} ({item.video.size:,} bytes)")
        emit(f"DRY RUN: copied=0 same_size={skipped} planned={len(copies)} "
             f"excluded={scan.excluded} invalid={len(scan.invalid)}. Use --apply to copy.")
        return int(bool(scan.invalid))
    if copies:
        android.shell("command -v sha256sum >/dev/null", "Checking phone SHA-256 support")
    for index, item in enumerate(copies):
        try:
            copy_verified(android, item, reserve)
            copied += 1
            emit(f"COPIED {item.video.relative!r} (SHA-256 verified)")
        except ReserveError as exc:
            blocked = len(copies) - index
            emit(f"BLOCKED: {exc}")
            break
        except (SyncError, OSError) as exc:
            failed += 1
            blocked = len(copies) - index - 1
            emit(f"FAILED {item.video.relative!r}: {exc}. Stopping this sync pass.")
            break
    incomplete = bool(failed or blocked or scan.invalid)
    emit(f"Summary: copied={copied} same_size={skipped} planned={len(copies)} failed={failed} "
         f"blocked={blocked} excluded={scan.excluded} invalid={len(scan.invalid)}; "
         f"{'sync incomplete' if incomplete else 'sync complete for eligible files'}.")
    return int(incomplete)


def reserve_value(value: str) -> int:
    try:
        amount = Decimal(value)
        if not amount.is_finite() or amount < 0:
            raise ValueError
        return int(amount * GIB)
    except (InvalidOperation, ValueError, OverflowError) as exc:
        raise argparse.ArgumentTypeError("reserve must be a finite, non-negative number of GiB") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, default=DEFAULT_LIBRARY)
    parser.add_argument("--dest", default=DEFAULT_DEST, help="Phone destination directory")
    parser.add_argument("--serial", help="ADB serial; otherwise exactly one connected Android is required")
    parser.add_argument("--exclusions", type=Path, default=DEFAULT_EXCLUSIONS,
                        help="JSON list, or {\"exclude\": [exact relative paths]}; missing file means no exclusions")
    parser.add_argument("--reserve-gib", type=reserve_value, default=8 * GIB, metavar="GIB",
                        help="Minimum free phone space to preserve (default: 8 GiB)")
    parser.add_argument("--apply", action="store_true", help="Actually copy; otherwise read-only dry run")
    args = parser.parse_args(argv)
    try:
        exclusions = load_exclusions(args.exclusions)
        library = args.library.expanduser().resolve()
        # Fail device selection early instead of probing hundreds of videos first.
        serial = select_device(args.serial)
        android = Android(serial, args.dest)
        print(f"{'APPLY' if args.apply else 'DRY RUN'}: {library} -> {serial}:{android.destination}", flush=True)
        scan = scan_library(library, exclusions, emit=lambda message: print(message, flush=True))
        return sync(android, scan, apply=args.apply, reserve=args.reserve_gib,
                    emit=lambda message: print(message, flush=True))
    except (SyncError, OSError) as exc:
        print(f"ERROR: {exc}. Sync did not complete.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Interrupted; sync did not complete.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
