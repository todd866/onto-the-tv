#!/usr/bin/env python3
"""shelf_to_cloud.py: make a shelf cloud-only, safely, or just say how ready each shelf is.

  scripts/shelf_to_cloud.py plan [--hub HOST] [--shelf NAME ...]        read-only: what the cloud copy holds
  scripts/shelf_to_cloud.py move --shelf NAME --openings-dir DIR --yes [--hub HOST] [--seconds 30]

`plan` lists every shelf: how many of its files the cloud copy holds at the same size, and what is not ready.
"The cloud copy" is the object the TV's reader would read (docs/media-cache.md, "Cloud source"): the listing is
made through the same remote, with the same site config, not taken from a backup tool's receipts.

`move` does one shelf, in the order the notes give, and stops at the first step that fails:
  1. hold the shelf's openings (bin/hold-openings.js), so its titles still start at once;
  2. inside ONE hold on the drive: check each file is still the size and date it was when the cloud was checked,
     record it in cloud-manifest.json, and move only what was recorded to the Bin (never deleted);
  3. leave every folder in place and say what moved.
It refuses a shelf that is meant to stay whole (kids' shelves, music), a hub whose manifest file does not exist
yet (the backup tool decides by that file whether to look), and anything not in the cloud at the same size.

Where it runs: the cloud listing needs the backup password from the login keychain, which ssh cannot read, so
run it in a logged-in session. With --hub HOST the drive side (listing, recording, moving) runs on the hub over
ssh and the cloud listing here. Site config: cloud-source.json (--config; default in the TV server's data folder).
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import time

APP = pathlib.Path(os.environ.get("SHELF_APP_DATA") or pathlib.Path.home() / "Library/Application Support/Onto the TV")
_here = pathlib.Path(__file__).resolve().parent.parent
# Copied to a hub's temp folder (--hub), the script is not inside the repository: use the hub's deployed copy.
REPO = pathlib.Path(os.environ.get("SHELF_REPO") or (_here if (_here / "shuffler/make_shuffler.py").is_file() else pathlib.Path.home() / "onto-the-tv"))
SLOT = pathlib.Path.home() / ".local/bin/disk-slot"
VIDEO = {".mp4", ".m4v", ".mkv", ".webm", ".mov"}
# Shelves that play from the cloud. Everything else (kids' shelves, music) stays whole on the hub.
CLOUD_TIERS = {"grownup", "couple", "sitcom", "scifi", "adultanim", "comedy", "docs", "classic", "bbc", "standup",
               "50s", "60s", "70s", "80s", "90s"}
GB = 1e9


# --- the drive side (runs where the library is) --------------------------------------------------------------------

def read_json(path, default=None):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        return default


def roots():
    settings = read_json(APP / "settings.json", {})
    sources = read_json(settings.get("sourcesPath") or "", {}) or {}
    out, seen = [], set()
    for r in sources.get("roots", []):
        p = os.path.expanduser(r.get("path") or "").rstrip("/")
        if p and p not in seen:
            seen.add(p)
            out.append({"label": r.get("label") or os.path.basename(p), "path": p, "tier": r.get("tier")})
    return out


def in_slot(paths, argv):
    """Re-run this command inside disk-slot when it will read or change an external drive."""
    drives = sorted({p for p in paths if p.startswith("/Volumes/")})
    if not drives or os.environ.get("SHELF_IN_SLOT") or not SLOT.exists():
        return
    os.environ["SHELF_IN_SLOT"] = "1"
    os.execv(str(SLOT), [str(SLOT), "--wait", "1800", "--label", "shelf-to-cloud"] + drives + ["--", sys.executable] + argv)


def drive_facts(wanted):
    rs = [r for r in roots() if not wanted or r["label"] in wanted]
    in_slot([r["path"] for r in rs], [str(pathlib.Path(__file__).resolve()), "_facts"] + wanted)
    probe = (read_json(APP / "tv-server/.catalogue.html.probe-cache.json", {}) or {}).get("entries", {})
    manifest = APP / "tv-server/cloud-manifest.json"
    held = (read_json(manifest, {}) or {}).get("entries", {})
    for r in rs:
        base = pathlib.Path(r["path"])
        r["present"], r["files"] = base.is_dir(), []
        if not r["present"]:
            continue
        for folder, dirs, names in os.walk(base):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for name in sorted(names):
                p = pathlib.Path(folder) / name
                if name.startswith(".") or p.suffix.lower() not in VIDEO:
                    continue
                st = p.stat()
                hit = probe.get("1|" + str(p)) or {}
                r["files"].append({"rel": str(p.relative_to(base)), "size": st.st_size, "mtime_ns": st.st_mtime_ns,
                                   "probed": bool(hit.get("duration")) and not hit.get("error") and hit.get("size") == st.st_size})
        r["held"] = sum(1 for k in held if k.startswith(r["path"] + "/"))
    return {"roots": rs, "manifest": manifest.is_file(), "openings_tool": (REPO / "bin/hold-openings.js").is_file()}


def drive_commit(job):
    """Inside one hold on the drive: re-check, record, then move what was recorded to the Bin."""
    root = job["root"]
    in_slot([root], [str(pathlib.Path(__file__).resolve()), "_commit", job["file"]])
    manifest = APP / "tv-server/cloud-manifest.json"
    if not manifest.is_file():
        return {"error": "the manifest file does not exist on this Mac; nothing moved"}
    sys.path.insert(0, str(REPO / "shuffler"))
    import make_shuffler
    probe = (read_json(APP / "tv-server/.catalogue.html.probe-cache.json", {}) or {}).get("entries", {})
    same, changed = [], []
    for f in job["files"]:
        p = pathlib.Path(root) / f["rel"]
        try:
            st = p.stat()
        except OSError:
            changed.append(f["rel"])
            continue
        if (st.st_size, st.st_mtime_ns) == (f["size"], f["mtime_ns"]):
            same.append(str(p))
        else:
            changed.append(f["rel"])                # touched since the cloud was checked: it stays
    recorded, skipped = make_shuffler.record_cloud(manifest, probe, same)
    mover = os.environ.get("SHELF_BIN_CMD", "/usr/bin/trash").split()
    moved, failed, size = [], [], 0
    for path in recorded:
        bytes_ = os.path.getsize(path)
        done = subprocess.run(mover + [path], capture_output=True, text=True)
        if done.returncode == 0 and not os.path.exists(path):
            moved.append(path)
            size += bytes_
        else:
            failed.append(path)
    os.utime(root)
    return {"moved": len(moved), "bytes": size, "changed": changed, "skipped": skipped, "failed": failed}


# --- the controller ------------------------------------------------------------------------------------------------

def on_drive_side(hub, mode, args, payload=None):
    """Run a drive-side step here, or on the hub over ssh (the script is copied to its temp folder first)."""
    if not hub:
        cmd = [sys.executable, str(pathlib.Path(__file__).resolve()), mode] + args
    else:
        remote = "/private/tmp/shelf-to-cloud-%s.py" % os.getuid()
        ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", hub]
        subprocess.run(ssh + ["cat > %s" % remote], input=pathlib.Path(__file__).read_bytes(), check=True)
        if payload is not None:
            args = [remote + ".job.json"]
            subprocess.run(ssh + ["cat > %s" % args[0]], input=json.dumps(payload).encode(), check=True)
        cmd = ssh + ["/usr/bin/python3 %s %s %s" % (remote, mode, " ".join("'%s'" % a.replace("'", "'\\''") for a in args))]
    done = subprocess.run(cmd, capture_output=True, text=True)
    lines = [l for l in done.stdout.splitlines() if l.startswith("{")]
    if done.returncode or not lines:
        raise SystemExit("shelf_to_cloud: the drive side failed (%s): %s" % (mode, (done.stderr or done.stdout).strip()[-400:]))
    return json.loads(lines[-1])


def cloud_env(config):
    """The reader's own way in: keychain -> `rclone obscure -` on stdin -> the child's environment only."""
    site = read_json(config)
    if not site or not site.get("remote") or not site.get("keychain"):
        raise SystemExit("shelf_to_cloud: %s must name the backup's remote and keychain item (see src/cloud-source.js)." % config)
    secret = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", site["keychain"], "-w"], capture_output=True, text=True).stdout.rstrip("\n")
    if not secret:
        raise SystemExit("shelf_to_cloud: the backup password could not be read from the keychain (run this in a logged-in session, not over ssh).")
    obscured = subprocess.run([rclone(), "obscure", "-"], input=secret, capture_output=True, text=True).stdout.strip()
    env = dict(os.environ, RCLONE_CONFIG_GCRYPT_TYPE="crypt", RCLONE_CONFIG_GCRYPT_REMOTE=site["remote"], RCLONE_CONFIG_GCRYPT_PASSWORD=obscured,
               RCLONE_CONFIG_GCRYPT_FILENAME_ENCRYPTION="standard", RCLONE_CONFIG_GCRYPT_DIRECTORY_NAME_ENCRYPTION="true")
    listed = site.get("roots")
    if not isinstance(listed, list) and site.get("rootsFrom"):
        listed = (read_json(os.path.expanduser(site["rootsFrom"]), {}) or {}).get("sources")
    return env, "gcrypt:" + str(site.get("prefix", "current")).strip("/"), [s for s in listed or [] if isinstance(s.get("name"), str) and isinstance(s.get("path"), str)]


def rclone():
    return "/opt/homebrew/bin/rclone" if os.path.exists("/opt/homebrew/bin/rclone") else "rclone"


def cloud_listing(env, base, sources, root_path):
    """{relative path: size} of what the cloud copy holds under this shelf's folder, or None if it maps nowhere."""
    for s in sorted(sources, key=lambda s: -len(s["path"])):
        top = os.path.expanduser(s["path"]).rstrip("/")
        if root_path == top or root_path.startswith(top + "/"):
            where = "/".join(x for x in (base.rstrip("/"), s["name"], root_path[len(top):].strip("/")) if x)
            done = subprocess.run([rclone(), "lsjson", "-R", "--files-only", "--no-modtime", "--no-mimetype", where], env=env, capture_output=True, text=True)
            if done.returncode not in (0, 3):                   # 3: the folder is not there yet
                raise SystemExit("shelf_to_cloud: the cloud copy could not be listed (%s)." % done.stderr.strip()[-200:])
            return {e["Path"]: e["Size"] for e in (json.loads(done.stdout) if done.returncode == 0 and done.stdout.strip() else [])}
    return None


def assess(args):
    facts = on_drive_side(args.hub, "_facts", args.shelf or [])
    if args.cloud_root:                                           # a plain folder laid out like the backup (tests)
        env, base, sources = dict(os.environ, RCLONE_CONFIG="/dev/null"), args.cloud_root, json.loads(args.cloud_sources)
    else:
        env, base, sources = cloud_env(args.config or APP / "tv-server/cloud-source.json")
    for r in facts["roots"]:
        r["movable"] = r.get("tier") in CLOUD_TIERS
        listing = cloud_listing(env, base, sources, r["path"]) if r["present"] else {}
        r["mapped"] = listing is not None
        for f in r.get("files", []):
            size = (listing or {}).get(f["rel"])
            f["state"] = ("not probed" if not f["probed"] else "ready") if size == f["size"] else ("not in the cloud" if size is None else "size differs")
    return facts


def plan(args):
    facts = assess(args)
    print("%-20s %-9s %6s %8s %9s %8s  %s" % ("shelf", "plays", "files", "GB", "in cloud", "ready GB", "not ready"))
    for r in facts["roots"]:
        files = r.get("files", [])
        counts = {}
        for f in files:
            counts[f["state"]] = counts.get(f["state"], 0) + 1
        ready = sum(f["size"] for f in files if f["state"] == "ready")
        rest = ", ".join("%d %s" % (n, k) for k, n in sorted(counts.items()) if k != "ready")
        note = "drive away" if not r["present"] else ("not in the backup's sources" if not r["mapped"] else rest or ("all ready" if files else "empty (%d held in the cloud)" % r.get("held", 0)))
        print("%-20s %-9s %6d %8.1f %9d %8.1f  %s" % (r["label"][:20], "cloud" if r["movable"] else "whole", len(files), sum(f["size"] for f in files) / GB,
                                                    sum(1 for f in files if f["state"] in ("ready", "not probed")), ready / GB, note))
    movable = [f for r in facts["roots"] if r["movable"] for f in r.get("files", [])]
    print("cloud shelves: %.1f GB on the drive, %.1f GB ready to go cloud-only." % (sum(f["size"] for f in movable) / GB, sum(f["size"] for f in movable if f["state"] == "ready") / GB))
    print("on the hub: manifest file %s; openings tool %s." % ("exists" if facts["manifest"] else "MISSING (the cloud source is not switched on)",
                                                                "present" if facts["openings_tool"] else "MISSING (this branch is not deployed there)"))
    return 0


def move(args):
    if len(args.shelf or []) != 1:
        raise SystemExit("shelf_to_cloud: move takes exactly one --shelf.")
    facts = assess(args)
    r = next((r for r in facts["roots"] if r["label"] == args.shelf[0]), None)
    if not r or not r["present"]:
        raise SystemExit("shelf_to_cloud: no shelf called %s is on a drive here." % args.shelf[0])
    if not r["movable"]:
        raise SystemExit("shelf_to_cloud: %s stays whole on the hub (kids' shelves and music do); nothing moved." % r["label"])
    if not facts["manifest"]:
        raise SystemExit("shelf_to_cloud: the manifest file does not exist on the hub, so the cloud source is not switched on; nothing moved.")
    ready = [f for f in r["files"] if f["state"] == "ready"]
    left = len(r["files"]) - len(ready)
    if not ready:
        raise SystemExit("shelf_to_cloud: nothing on %s is in the cloud at the same size yet; nothing moved." % r["label"])
    print("%s: %d files (%.1f GB) are in the cloud at the same size; %d are not and stay." % (r["label"], len(ready), sum(f["size"] for f in ready) / GB, left))
    if not args.yes:
        print("Nothing moved: add --yes to do it.")
        return 0
    if not args.openings_dir:
        raise SystemExit("shelf_to_cloud: --openings-dir is needed, so the shelf's titles still start at once.")
    hold = os.environ.get("SHELF_OPENINGS_CMD")
    hold = hold.split() if hold else ["node", str(REPO / "bin/hold-openings.js")]
    hold += ["--openings-dir", args.openings_dir, "--shelf", r["label"], "--seconds", str(args.seconds)]
    if args.hub:
        raise SystemExit("shelf_to_cloud: with --hub, run the move on the hub itself once this branch is deployed there (the openings step reads every title).")
    if r["path"].startswith("/Volumes/") and SLOT.exists():
        hold = [str(SLOT), "--wait", "1800", "--label", "shelf-openings", r["path"], "--"] + hold
    if subprocess.run(hold).returncode:
        raise SystemExit("shelf_to_cloud: the openings could not be held; nothing moved.")
    job = APP / "tv-server" / "shelf-move.job.json"
    job.write_text(json.dumps({"root": r["path"], "files": ready, "file": str(job)}))
    out = on_drive_side(None, "_commit", [str(job)])
    job.unlink()
    if out.get("error"):
        raise SystemExit("shelf_to_cloud: " + out["error"])
    print("moved to the Bin: %d files, %.1f GB. Left in place: %d changed since the check, %d the catalogue had not probed, %d the Bin refused."
          % (out["moved"], out["bytes"] / GB, len(out["changed"]), len(out["skipped"]), len(out["failed"])))
    print("The drive's room comes back when its Bin is emptied. Ledger line: %s | %s | %.1f GB | cloud copy (encrypted) + Bin on the drive | plays from the cloud"
          % (time.strftime("%d %b %Y"), r["path"], out["bytes"] / GB))
    return 1 if out["failed"] else 0


def main():
    a = sys.argv[1:]
    if a[:1] == ["_facts"]:
        print(json.dumps(drive_facts(a[1:])))
        return 0
    if a[:1] == ["_commit"]:
        job = read_json(a[1])
        print(json.dumps(drive_commit(dict(job, file=a[1]))))
        return 0
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("mode", choices=["plan", "move"])
    p.add_argument("--shelf", action="append")
    p.add_argument("--hub")
    p.add_argument("--config")
    p.add_argument("--openings-dir")
    p.add_argument("--seconds", type=int, default=30)
    p.add_argument("--yes", action="store_true")
    p.add_argument("--cloud-root", help="a plain folder laid out like the backup, instead of the encrypted remote (tests)")
    p.add_argument("--cloud-sources", default="[]", help="with --cloud-root: the sources as JSON [{name, path}]")
    args = p.parse_args()
    return plan(args) if args.mode == "plan" else move(args)


if __name__ == "__main__":
    sys.exit(main())
