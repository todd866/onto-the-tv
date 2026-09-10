#!/usr/bin/env python3
"""Build and install a self-contained macOS app without launching it.

Run npm ci first to download Electron. A custom --output is a staged build and
is never registered with Launch Services. The previous installation is retained
as a hidden, uniquely named sibling backup; older backups of this app are removed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
APP_NAME = "Onto the TV"
BUNDLE_ID = "com.iantodd.onto-the-tv"
LSREGISTER = Path("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")


class InstallError(RuntimeError):
    pass


def run_command(arguments: list[str]) -> None:
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, check=False, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise InstallError(f"Could not run {Path(arguments[0]).name}: {exc}") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-2000:]
        raise InstallError(f"{Path(arguments[0]).name} failed: {detail or result.returncode}")


def production_files(root: Path) -> list[Path]:
    """An allowlist, never a recursive copy of a developer's checkout."""
    required = [
        Path("package.json"), Path("src/main.js"), Path("src/preload.cjs"),
        Path("ui/index.html"), Path("ui/app.js"), Path("ui/styles.css"),
        Path("brand/onto-the-tv-icon.png"), Path("brand/AppIcon.icns"),
        Path("shuffler/player.js"), Path("shuffler/player.html"),
        Path("shuffler/make_shuffler.py"), Path("shuffler/package.json"),
    ]
    files = set(required)
    for directory, pattern in (("src", "*.js"), ("casting/src", "*.js"),
                               ("brand", "*.png"), ("brand", "*.icns")):
        files.update(path.relative_to(root) for path in (root / directory).glob(pattern)
                     if not path.name.endswith(".test.js") and not path.name.startswith("."))
    if (root / "LICENSE").is_file():
        files.add(Path("LICENSE"))
    for relative in files:
        source = root / relative
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(root.resolve()):
            raise InstallError(f"Required production file is missing or is an external link: {relative}")
    if not any(path.parts[:2] == ("casting", "src") for path in files):
        raise InstallError("The casting sources are missing.")
    return sorted(files)


def build_bundle(root: Path, stage: Path, runner=run_command) -> None:
    electron_dir = root / "node_modules/electron"
    runtime = electron_dir / "dist/Electron.app"
    if not (runtime / "Contents/MacOS/Electron").is_file():
        raise InstallError("Electron is missing. Run npm ci in the project folder first.")
    files = production_files(root)
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = str(package.get("version", "0.0.0"))
    match = re.match(r"^\d+\.\d+\.\d+", version)
    if not match:
        raise InstallError("package.json needs a numeric major.minor.patch version.")

    # ditto preserves the versioned Framework symlinks inside Electron.app.
    runner(["/usr/bin/ditto", str(runtime), str(stage)])
    resources = stage / "Contents/Resources"
    app_code = resources / "app"
    if app_code.exists():
        raise InstallError("The downloaded Electron runtime unexpectedly contains an app directory.")
    app_code.mkdir(parents=True)
    (resources / "default_app.asar").unlink(missing_ok=True)
    for relative in files:
        destination = app_code / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, destination)
    shutil.copy2(root / "brand/AppIcon.icns", resources / "AppIcon.icns")
    for source, name in (
        (electron_dir / "LICENSE", "ELECTRON-LICENSE.txt"),
        (electron_dir / "dist/LICENSES.chromium.html", "LICENSES.chromium.html"),
    ):
        if source.is_file():
            shutil.copy2(source, resources / name)

    info_path = stage / "Contents/Info.plist"
    with info_path.open("rb") as handle:
        info = plistlib.load(handle)
    if info.get("CFBundleExecutable") != "Electron":
        raise InstallError("The downloaded Electron runtime has an unexpected executable.")
    (stage / "Contents/MacOS/Electron").rename(stage / "Contents/MacOS" / APP_NAME)
    info.update({
        "CFBundleExecutable": APP_NAME,
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundleIconFile": "AppIcon",
        "CFBundleShortVersionString": match.group(),
        "CFBundleVersion": match.group(),
        "LSApplicationCategoryType": "public.app-category.entertainment",
        "NSLocalNetworkUsageDescription": "Onto the TV sends videos to a TV on your local network.",
        "CFBundleDocumentTypes": [{
            "CFBundleTypeName": "Movie",
            "CFBundleTypeRole": "Viewer",
            "LSHandlerRank": "Alternate",
            "LSItemContentTypes": ["public.movie", "public.mpeg-4", "public.avi",
                                   "com.apple.quicktime-movie", "public.mp3", "public.mpeg-4-audio"],
        }],
    })
    info.pop("CFBundleIconName", None)
    info.pop("CFBundleURLTypes", None)
    with info_path.open("wb") as handle:
        plistlib.dump(info, handle)
    runner(["/usr/bin/codesign", "--force", "--deep", "--sign", "-",
            "--preserve-metadata=entitlements", str(stage)])
    runner(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(stage)])


def prune_backups(output: Path, keep: int = 1) -> list[Path]:
    """Remove older hidden backups of this app beside OUTPUT, keeping the newest KEEP.

    Only directories named like our backups that carry our bundle identifier are
    touched; anything else beside the app is left alone.
    """
    prefix = f".{output.stem}.backup-"
    candidates = []
    for path in output.parent.iterdir():
        if not path.name.startswith(prefix) or path.suffix != ".app" or path.is_symlink() or not path.is_dir():
            continue
        try:
            with (path / "Contents/Info.plist").open("rb") as handle:
                info = plistlib.load(handle)
        except (OSError, ValueError, plistlib.InvalidFileException):
            continue
        if info.get("CFBundleIdentifier") == BUNDLE_ID:
            candidates.append(path)
    candidates.sort(key=lambda path: path.name)  # the name carries the UTC timestamp
    removed = candidates[:-keep] if keep > 0 else candidates
    for path in removed:
        shutil.rmtree(path)
    return removed


def install(root: Path, output: Path, *, register: bool, runner=run_command) -> Path | None:
    output = output.expanduser().absolute()
    if output.suffix.lower() != ".app" or output.is_symlink():
        raise InstallError("Choose an .app output path that is not a symbolic link.")
    if output.exists():
        try:
            with (output / "Contents/Info.plist").open("rb") as handle:
                previous = plistlib.load(handle)
        except (OSError, ValueError, plistlib.InvalidFileException) as exc:
            raise InstallError("The output already exists and is not a readable macOS app.") from exc
        if previous.get("CFBundleIdentifier") != BUNDLE_ID:
            raise InstallError("The output belongs to another app; choose a different path.")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.stem}.build-", suffix=".app", dir=output.parent))
    backup = None
    installed = False
    try:
        build_bundle(root, stage, runner)
        try:
            if output.exists():
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
                backup = output.with_name(f".{output.stem}.backup-{stamp}-{uuid.uuid4().hex[:8]}.app")
                output.rename(backup)
            stage.rename(output)
            installed = True
            if register:
                os.utime(output, None)
                runner([str(LSREGISTER), "-f", str(output)])
        except BaseException:
            # Move the new bundle aside before restoring the old one. Renames are
            # within one parent/filesystem, and the only deleted tree is our stage.
            if installed and output.exists():
                output.rename(stage)
                installed = False
            if backup is not None and backup.exists():
                backup.rename(output)
                backup = None
            raise
        prune_backups(output)
        return backup
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Custom .app build path; no Launch Services registration")
    parser.add_argument("--no-register", action="store_true", help="Skip touching and registering the installed app")
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        parser.error("This installer requires macOS.")
    output = (args.output or Path.home() / "Applications" / f"{APP_NAME}.app").expanduser().absolute()
    try:
        backup = install(ROOT, output, register=args.output is None and not args.no_register)
    except (InstallError, OSError, ValueError, plistlib.InvalidFileException) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"Installed {output}")
    if backup:
        print(f"Previous app retained at {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
