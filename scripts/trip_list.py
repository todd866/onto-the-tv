#!/usr/bin/env python3
"""trip_list.py: make the list of what to take on a trip, to a size, before anything is copied.

  scripts/trip_list.py --from m2 --gb 150 --out ~/trip.json        read the hub's state over ssh
  scripts/trip_list.py --state DIR --gb 150 --out ~/trip.json      or from copies of its state files
  … --kids 50 --grownups 35 --music 15     how the room is shared (per cent; default as shown)

The TV should be easy to set up for a trip, perhaps with a drive brought along, and trips come with notice.
So nothing large is kept standing for travel: with notice, this makes the list, and `scripts/copy_holiday_library.sh <drive> --from m2
--list trip.json` packs it. Nothing here copies or changes anything.

What it reads from the hub's TV server (all small files): settings.json, the sources and tiers files it names,
the probe cache (every title's size and length, so no drive is walked), the watch ledger and, if present, the
cloud manifest (titles that are on no drive).

How it chooses, within each audience's share of the room:
- every title gets a score: how much its show has been watched lately (minutes, halving every 21 days), whether
  this title is unwatched (1.0), started (0.8) or finished (0.35), whether it is new (x1.5 within 14 days, x1.15
  within 45), a small preference for shorter files, and for the kids the tier (preschool and shared 1.0, big 0.8,
  older 0.5);
- shows take turns: a show's next-best title competes with every other show's, marked down by 0.9 for each
  title and each GB that show already has, so favourites get the most but everything gets a look-in.
These are the factors `kids-offline` uses for the laptop's kids slice, widened to every shelf.
Room an audience cannot fill goes to the others. A title that is only in the cloud is listed and flagged: the
packer has to fetch it from Google, at the 30-95 Mbit/s measured on 22 Nov 2026 (100 GB takes 2 to 7 hours).
"""
import argparse
import collections
import heapq
import json
import math
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

KIDS = ("preschool", "shared", "big", "older")
TIER_WEIGHT = {"preschool": 1.0, "shared": 1.0, "big": 0.8, "older": 0.5}
HALF_LIFE_DAYS = 21
GB = 1e9
STATE_FILES = {      # name here -> path under the hub's "Library/Application Support/Onto the TV"
    "settings.json": "settings.json",
    "probe.json": "tv-server/.catalogue.html.probe-cache.json",
    "events.jsonl": "tv-server/watch-events.jsonl",
    "cloud-manifest.json": "tv-server/cloud-manifest.json",
}


def audience_of(tier):
    return "kids" if tier in KIDS else "music" if tier == "music" else "grownups"


def fetch_state(host, into):
    """Copy the hub's small state files into a folder. The sources and tiers files are named by its settings."""
    app = "Library/Application Support/Onto the TV"

    def get(remote, name, optional=False):
        out = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, f'cat "{remote}"'], capture_output=True)
        if out.returncode != 0:
            if optional:
                return False
            raise SystemExit(f"trip_list: could not read {remote} from {host}")
        (into / name).write_bytes(out.stdout)
        return True

    for name, rel in STATE_FILES.items():
        get(f"$HOME/{app}/{rel}", name, optional=name in ("events.jsonl", "cloud-manifest.json"))
    settings = json.loads((into / "settings.json").read_text())
    get(settings.get("sourcesPath") or f"$HOME/{app}/kids-sources.json", "sources.json")
    get(settings.get("tiersPath") or f"$HOME/{app}/kids-tiers.json", "tiers.json", optional=True)


def load_state(folder):
    folder = Path(folder)

    def read(name, default=None):
        try:
            return json.loads((folder / name).read_text())
        except (OSError, ValueError):
            if default is None:
                raise SystemExit(f"trip_list: {name} is missing or unreadable in {folder}")
            return default

    events = []
    try:
        for line in (folder / "events.jsonl").read_text().splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    manifest = read("cloud-manifest.json", {})
    return {"settings": read("settings.json"), "sources": read("sources.json"), "tiers": read("tiers.json", {}),
            "probe": read("probe.json").get("entries", {}), "events": events,
            "cloud": manifest.get("entries", {}) if isinstance(manifest, dict) else {}}


def candidates(state):
    """Every playable title the hub knows, from the probe cache and the cloud manifest. No drive is touched."""
    settings, sources = state["settings"], state["sources"]
    home_library = settings["library"].rstrip("/")
    tier_of_show = {show: tier for tier, shows in state["tiers"].items() for show in shows}
    roots, seen = [], set()
    for root in [{"label": "", "path": home_library, "classify": "shows"}] + sources.get("roots", []):
        path = os.path.expanduser(root["path"]).rstrip("/")
        if path in seen:
            continue
        seen.add(path)
        roots.append((path, root.get("label", "").split(" (")[0], None if root.get("classify") == "shows" else root.get("tier", "older")))
    roots.sort(key=lambda r: -len(r[0]))
    picks = {os.path.expanduser(p["path"]): p for p in sources.get("picks", [])}
    movies_root = os.path.commonpath([r[0] for r in roots])
    found = {}

    def consider(path, size, duration, added, in_cloud_only):
        if size <= 0 or duration <= 0 or path in found:
            return
        hit = next((r for r in roots if path.startswith(r[0] + "/")), None)
        if hit:
            base, label, fixed = hit
            parts = path[len(base) + 1:].split("/")
            if any(p.startswith(".") for p in parts):
                return
            show = parts[0] if len(parts) > 1 else (label or os.path.basename(base))
            tier = fixed or tier_of_show.get(show, "older")
            shelf = label or os.path.basename(base)
            src = (label + "/" if label else "") + "/".join(parts)
        elif path in picks:
            pick = picks[path]
            show, tier, shelf = pick.get("show") or "Films", pick.get("tier", "older"), pick.get("show") or "Films"
            src = show + "/" + os.path.basename(path)
        else:
            return
        if not path.startswith(movies_root + "/"):
            return
        found[path] = {"path": path, "rel": path[len(movies_root) + 1:], "src": src, "size": size, "duration": duration,
                       "shelf": shelf, "show": shelf + "/" + show, "tier": tier, "audience": audience_of(tier),
                       "added": added, "cloud": in_cloud_only}

    for key, value in state["probe"].items():
        if not isinstance(value, dict) or value.get("error"):
            continue
        path = key.split("|", 1)[1] if "|" in key else key
        consider(path, value.get("size") or 0, value.get("duration") or 0, (value.get("mtime") or 0) / 1e9, path in state["cloud"])
    for path, value in state["cloud"].items():
        if isinstance(value, dict):
            consider(path, value.get("size") or 0, value.get("duration") or 0, (value.get("mtime") or 0) / 1e9, True)
    return list(found.values()), movies_root


def viewing(state, cands, now):
    """Per show: watch minutes, halving every HALF_LIFE_DAYS. Per title: seconds watched and whether it was finished."""
    by_src = {c["src"]: c for c in cands}
    sessions = {}
    for event in state["events"]:
        key = (event.get("sessionId"), event.get("src"))
        s = sessions.setdefault(key, {"w": 0.0, "d": 0.0, "t": None})
        s["w"] = max(s["w"], float(event.get("watchedSeconds") or 0))
        s["d"] = max(s["d"], float(event.get("durationSeconds") or 0))
        s["t"] = event.get("observedAt") or s["t"]
    minutes, watched = collections.Counter(), {}
    for (_, src), s in sessions.items():
        c = by_src.get(src)
        if not c:
            continue
        try:
            at = time.mktime(time.strptime(str(s["t"])[:19], "%Y-%m-%dT%H:%M:%S"))
        except (TypeError, ValueError):
            at = None
        decay = 0.5 ** (max(0.0, now - at) / (HALF_LIFE_DAYS * 86400)) if at else 0.25
        minutes[c["show"]] += s["w"] / 60 * decay
        w = watched.setdefault(c["path"], {"seconds": 0.0, "done": False})
        w["seconds"] = max(w["seconds"], s["w"])
        w["done"] = w["done"] or (s["d"] > 0 and s["w"] >= 0.8 * s["d"])
    return minutes, watched


def score(cands, minutes, watched, now):
    sizes = sorted(c["size"] for c in cands) or [1]
    median = sizes[len(sizes) // 2]
    for c in cands:
        interest = 1 + min(4.0, math.sqrt(minutes.get(c["show"], 0) / 6.25))
        w = watched.get(c["path"])
        state = 0.35 if w and w["done"] else 0.8 if w and w["seconds"] >= 60 else 1.0
        age_days = (now - c["added"]) / 86400 if c["added"] else 9999
        fresh = 1.5 if age_days <= 14 else 1.15 if age_days <= 45 else 1.0
        c["score"] = TIER_WEIGHT.get(c["tier"], 1.0) * interest * state * fresh * (max(c["size"], 1) / median) ** -0.5


def take(cands, budget):
    """Shows take turns; each show's next-best title is marked down by what that show already has."""
    by_show = collections.defaultdict(list)
    for c in cands:
        by_show[c["show"]].append(c)
    for titles in by_show.values():
        titles.sort(key=lambda c: (-c["score"], c["rel"]))
    heap = [(-titles[0]["score"], show) for show, titles in by_show.items()]
    heapq.heapify(heap)
    at, taken, taken_bytes, chosen, left = collections.Counter(), collections.Counter(), collections.Counter(), [], budget
    while heap:
        _, show = heapq.heappop(heap)
        c = by_show[show][at[show]]
        at[show] += 1
        if c["size"] <= left:
            chosen.append(c)
            left -= c["size"]
            taken[show] += 1
            taken_bytes[show] += c["size"]
        if at[show] < len(by_show[show]):
            nxt = by_show[show][at[show]]
            heapq.heappush(heap, (-nxt["score"] * 0.9 ** (taken[show] + taken_bytes[show] / GB), show))
    return chosen, left


def build(state, budget_gb, shares, now=None):
    now = time.time() if now is None else now
    cands, movies_root = candidates(state)
    minutes, watched = viewing(state, cands, now)
    score(cands, minutes, watched, now)
    total_share = sum(shares.values()) or 1
    chosen, spare = [], 0.0
    for audience in ("kids", "grownups", "music"):
        room = budget_gb * GB * shares.get(audience, 0) / total_share + spare
        picked, spare = take([c for c in cands if c["audience"] == audience], room)
        chosen += picked
    if spare > 0:           # room the last audience could not use goes back to the first that can
        have = {c["path"] for c in chosen}
        extra, spare = take([c for c in cands if c["path"] not in have], spare)
        chosen += extra
    chosen.sort(key=lambda c: c["rel"])
    return {"version": 1, "made": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)), "budget_gb": budget_gb,
            "library_root": movies_root, "library_gb": round(sum(c["size"] for c in cands) / GB, 1), "library_titles": len(cands),
            "bytes": sum(c["size"] for c in chosen), "cloud_bytes": sum(c["size"] for c in chosen if c["cloud"]),
            "items": [{k: c[k] for k in ("rel", "size", "shelf", "show", "tier", "audience", "cloud")} for c in chosen]}


def summary(trip):
    lines = ["trip list: %d titles, %.1f GB of a %s GB budget (the library is %.0f GB, %d titles)" % (
        len(trip["items"]), trip["bytes"] / GB, trip["budget_gb"], trip["library_gb"], trip["library_titles"])]
    for audience, name in (("kids", "kids"), ("grownups", "grown-ups"), ("music", "music")):
        items = [i for i in trip["items"] if i["audience"] == audience]
        shows = collections.Counter()
        for i in items:
            shows[i["show"].split("/", 1)[1]] += i["size"]
        top = ", ".join("%s %.1f" % (show, size / GB) for show, size in shows.most_common(6))
        lines.append("  %-9s %4d titles  %3d shows  %6.1f GB   most room: %s" % (name, len(items), len(shows), sum(i["size"] for i in items) / GB, top or "-"))
    if trip["cloud_bytes"]:
        hours = trip["cloud_bytes"] * 8 / 1e6 / 3600
        lines.append("  %.1f GB of it is only in the cloud: fetching that takes about %.1f to %.1f hours (30-95 Mbit/s, measured 22 Nov 2026)"
                     % (trip["cloud_bytes"] / GB, hours / 95, hours / 30))
    else:
        lines.append("  every title on it is on the hub's drive now; the copy speed from that drive has not been measured")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Make the list of what to take on a trip, to a size. Copies nothing.")
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--from", dest="host", help="ssh name of the hub (the Mac that serves the TV), e.g. m2")
    where.add_argument("--state", type=Path, help="a folder holding copies of the hub's state files")
    parser.add_argument("--gb", type=float, required=True, help="how much room the trip may take")
    parser.add_argument("--kids", type=float, default=50)
    parser.add_argument("--grownups", type=float, default=35)
    parser.add_argument("--music", type=float, default=15)
    parser.add_argument("--out", type=Path, help="where to write the list (JSON); without it only the summary is printed")
    args = parser.parse_args(argv)
    if args.gb <= 0:
        parser.error("--gb must be more than 0")
    with tempfile.TemporaryDirectory() as scratch:
        folder = args.state
        if args.host:
            folder = Path(scratch)
            fetch_state(args.host, folder)
        trip = build(load_state(folder), args.gb, {"kids": args.kids, "grownups": args.grownups, "music": args.music})
    print(summary(trip))
    if args.out:
        out = args.out.expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.name + ".tmp")
        tmp.write_text(json.dumps(trip, indent=1))
        os.replace(tmp, out)
        print(f"written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
