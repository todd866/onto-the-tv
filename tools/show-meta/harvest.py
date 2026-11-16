#!/usr/bin/env python3
"""Harvest show metadata from the Onto the TV catalogue for embedding."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import logging
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

USER_AGENT = "onto-the-tv-metadata/0.2 (https://github.com/todd866/onto-the-tv)"
WIKI_BATCH_SIZE = 50
WIKI_MAX_RETRIES = 5
TIERS = frozenset(
    {
        "preschool",
        "shared",
        "big",
        "older",
        "grownup",
        "couple",
        "sitcom",
        "scifi",
        "adultanim",
        "comedy",
        "docs",
        "classic",
        "bbc",
        "standup",
        "music",
        "50s",
        "60s",
        "70s",
        "80s",
        "90s",
        "sports",
    }
)
KIDS_TIERS = frozenset({"preschool", "shared", "big", "older"})
TV_TIERS = frozenset(
    {
        "grownup",
        "couple",
        "sitcom",
        "scifi",
        "adultanim",
        "comedy",
        "docs",
        "classic",
        "bbc",
        "standup",
        "50s",
        "60s",
        "70s",
        "80s",
        "90s",
        "sports",
    }
)
FILM_FOLDERS = frozenset({"Films", "Family Films"})
MUSIC_SESSION_FOLDER_HINTS = (
    "kexp",
    "tiny desk",
    "mahogany",
    "colors",
    "cercle",
    "like a version",
    "from the basement",
    "live at the wireless",
    "audiotree",
    "npr",
    "2 meter",
    "meter session",
)
MUSIC_CHANNEL_KEYS = frozenset(
    {"music", "dance", "live sets", "triple j", "double j", "livesets", "triplej", "doublej"}
)
YEAR_SUFFIX = re.compile(r"\s*\((?:19|20)\d\d\)\s*$")
TITLE_YEAR_PAREN = re.compile(r"\s*\((?:19|20)\d{2}\)\s*$")
OFFICIAL_SUFFIX = re.compile(r"\s*-?\s*Official(?: Channel)?\s*$", re.I)
EPISODE_MARK = re.compile(r"\bS\d{1,2}\s?E\d{1,3}\b|\b\d{1,2}x\d{2}\b", re.I)
YEAR_FOLDER = re.compile(r"\((?:19|20)\d\d\)\s*$")
VIDEO_ID_IN_SRC = re.compile(r"\[([A-Za-z0-9_-]{8,15})\]")
CATALOGUE_RE = re.compile(r"<script>\s*const VIDEOS = ([\s\S]*?);\s*</script>")
IMDB_BASICS_URL = "https://datasets.imdbws.com/title.basics.tsv.gz"
IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz"
WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_REST = "https://en.wikipedia.org/api/rest_v1/page/summary/"
META_MAX_AGE = timedelta(days=30)
YOUTUBE_PACE_SECONDS = 20
WIKI_PACE_SECONDS = 1.0
RETRY_HTTP_STATUSES = frozenset({429, 503})
BACKOFF_INITIAL_SECONDS = 5.0
BACKOFF_MAX_SECONDS = 300.0
WIKIPEDIA_MIN_ACCEPT_SCORE = 2.5
YT_DLP = shutil.which("yt-dlp") or "/opt/homebrew/bin/yt-dlp"
SIGN_IN_MARKER = "Sign in to confirm"

# Wikidata instance-of QIDs used when scoring Wikipedia picks.
WD_HUMAN = "Q5"
WD_MUSICAL_GROUP = "Q215380"
WD_RECORD_LABEL = "Q18127"
WD_TV_SERIES = "Q5398426"
WD_FILM = "Q11424"
WD_LIST_ARTICLE = "Q1340646"
WD_ALBUM = "Q482994"
WD_SINGLE = "Q134556"
WD_SONG = "Q7366"
WD_TELEVISION_PROGRAM = "Q15416"

KIND_EXPECTED_INSTANCE_OF: dict[str, frozenset[str]] = {
    "series": frozenset({WD_TV_SERIES, WD_TELEVISION_PROGRAM}),
    "film": frozenset({WD_FILM}),
    "music artist": frozenset({WD_HUMAN, WD_MUSICAL_GROUP}),
    "record label": frozenset({WD_RECORD_LABEL}),
    "live series": frozenset({WD_TV_SERIES, WD_TELEVISION_PROGRAM}),
    "youtube channel": frozenset(),
}

KIND_CONTRADICTING_INSTANCE: dict[str, frozenset[str]] = {
    "series": frozenset({WD_FILM, WD_ALBUM, WD_SINGLE, WD_SONG, WD_LIST_ARTICLE}),
    "live series": frozenset({WD_FILM, WD_ALBUM, WD_SINGLE, WD_SONG, WD_LIST_ARTICLE}),
    "music artist": frozenset({WD_TV_SERIES, WD_TELEVISION_PROGRAM, WD_ALBUM, WD_SINGLE, WD_SONG, WD_FILM}),
    "record label": frozenset({WD_TV_SERIES, WD_ALBUM, WD_SINGLE, WD_SONG, WD_HUMAN, WD_MUSICAL_GROUP}),
    "film": frozenset({WD_TV_SERIES, WD_TELEVISION_PROGRAM, WD_ALBUM, WD_SINGLE, WD_SONG}),
}


class WikiThrottledError(RuntimeError):
    """Wikipedia/Wikidata API remained at 429/503 after retries."""


def default_state_dir() -> Path:
    return Path.home() / ".local" / "state" / "onto-tv-embed"


def default_meta_dir(state_dir: Path | None = None) -> Path:
    return (state_dir or default_state_dir()) / "meta"


def normalize_show_name(channel: str) -> str:
    text = str(channel or "")
    text = YEAR_SUFFIX.sub("", text)
    text = OFFICIAL_SUFFIX.sub("", text)
    return text.strip() or str(channel or "").strip()


def folder_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower().replace("&", "and")).strip()


def is_music_session_folder(channel: str) -> bool:
    key = folder_key(channel)
    if not key:
        return False
    return any(hint in key for hint in MUSIC_SESSION_FOLDER_HINTS)


def is_music_tv_channel(channel: str) -> bool:
    key = folder_key(normalize_show_name(channel))
    return key in MUSIC_CHANNEL_KEYS or any(part in MUSIC_CHANNEL_KEYS for part in key.split())


def looks_like_record_label(name: str) -> bool:
    text = name.strip()
    return bool(re.match(r"^\d+[A-Z]{1,4}$", text))


def looks_like_live_series(name: str, raw_channels: Sequence[str]) -> bool:
    key = folder_key(name)
    if any(marker in key for marker in ("session", "sessions", "tiny desk", "meter", "desk concert", "live at")):
        return True
    return any(is_music_session_folder(ch) for ch in raw_channels)


def slugify(name: str) -> str:
    text = unicodedata.normalize("NFKD", name)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text or "show"


def read_catalogue(html: str, source_path: str | Path = "", output_path: str | Path = "") -> list[dict[str, Any]]:
    """Parse VIDEOS from catalogue HTML the same way as src/shuffler.js readCatalogue."""
    match = CATALOGUE_RE.search(html)
    if not match:
        raise ValueError("Refresh the library to create your channels.")
    videos = json.loads(match.group(1))
    if not isinstance(videos, list) or len(videos) > 100_000:
        raise ValueError("Invalid video library.")
    source = Path(source_path or ".")
    output = Path(output_path or source)
    out: list[dict[str, Any]] = []
    for video in videos:
        path = video.get("path") or video.get("src")
        if (
            not isinstance(path, str)
            or not path
            or "\0" in path
            or re.match(r"^[a-z][\w+.-]*:", path, re.I)
        ):
            raise ValueError("Invalid library entry.")
        if not isinstance(video.get("src"), str) or video.get("tier") not in TIERS:
            raise ValueError("Invalid library entry.")
        resolved = (source.parent / path).resolve()
        out.append(
            {
                "src": video["src"],
                "file": str(resolved),
                # The server's catalogue holds absolute paths on the library drive, not paths under its own folder.
                "path": str(resolved.relative_to(output.parent.resolve())) if resolved.is_relative_to(output.parent.resolve()) else path,
                "title": video["title"] if isinstance(video.get("title"), str) else "",
                "channel": video["channel"] if isinstance(video.get("channel"), str) else "",
                "tier": video["tier"],
                "duration": video["duration"]
                if isinstance(video.get("duration"), (int, float)) and video["duration"] > 0
                else 0,
            }
        )
    return out


def youtube_id_from_src(src: str) -> str | None:
    match = VIDEO_ID_IN_SRC.search(str(src or ""))
    return match.group(1) if match else None


def is_film_entry(item: Mapping[str, Any]) -> bool:
    channel = str(item.get("channel") or "")
    tier = str(item.get("tier") or "")
    src = str(item.get("src") or "")
    grownup_tv = tier in {"grownup", "couple"}
    return (
        channel in FILM_FOLDERS
        or (
            grownup_tv
            and YEAR_FOLDER.search(channel)
            and not EPISODE_MARK.search(src)
            and not EPISODE_MARK.search(str(item.get("title") or ""))
        )
    )


def guess_kind(name: str, items: Sequence[Mapping[str, Any]], *, raw_channels: Sequence[str] | None = None) -> str:
    channels = list(raw_channels or (str(item.get("channel") or "") for item in items))
    tiers = {str(item.get("tier") or "") for item in items}

    if name in FILM_FOLDERS or (items and all(is_film_entry(item) for item in items)):
        return "film"
    if "music" in tiers or any(is_music_tv_channel(ch) for ch in channels):
        if looks_like_live_series(name, channels):
            return "live series"
        if looks_like_record_label(name):
            return "record label"
        return "music artist"
    if tiers & KIDS_TIERS or tiers <= KIDS_TIERS:
        return "series"
    if tiers & TV_TIERS:
        return "series"
    if any(
        EPISODE_MARK.search(str(item.get("title") or "") + " " + str(item.get("src") or "")) for item in items
    ):
        return "series"
    if len(items) <= 2 and any(YEAR_FOLDER.search(str(item.get("channel") or "")) for item in items):
        return "film"
    if any(youtube_id_from_src(item.get("src", "")) for item in items):
        return "youtube channel"
    return "series"


WIKIPEDIA_TRAILING_QUALIFIER = re.compile(r"\s*\([^)]*\)\s*$")


def normalize_for_wikipedia_match(text: str) -> str:
    text = unicodedata.normalize("NFKD", wikipedia_title_stem(str(text or "")))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold().replace("&", " and ")
    text = text.replace("$", "").replace(".", "")
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def wikipedia_title_stem(title: str) -> str:
    return WIKIPEDIA_TRAILING_QUALIFIER.sub("", str(title or "")).strip()


def wikidata_name_variants(wikidata: Mapping[str, Any] | None) -> set[str]:
    if not wikidata:
        return set()
    names: set[str] = set()
    for key in ("label", "labels", "alias", "aliases"):
        value = wikidata.get(key)
        if isinstance(value, str):
            names.add(value)
        elif isinstance(value, (list, tuple, set, frozenset)):
            names.update(str(entry) for entry in value if entry)
    return names


def wikipedia_title_matches_show(
    title: str,
    show_name: str,
    *,
    wikidata: Mapping[str, Any] | None = None,
) -> bool:
    target = normalize_for_wikipedia_match(show_name)
    if not target:
        return False
    if normalize_for_wikipedia_match(wikipedia_title_stem(title)) == target:
        return True
    for name in wikidata_name_variants(wikidata):
        if normalize_for_wikipedia_match(name) == target:
            return True
        if normalize_for_wikipedia_match(wikipedia_title_stem(name)) == target:
            return True
    return False


def wikipedia_kind_title_variants(show_name: str, kind: str) -> list[str]:
    base = show_name.strip()
    if kind == "music artist":
        suffixes = ("", " (band)", " (musician)", " (rapper)", " (singer)")
    elif kind == "record label":
        suffixes = ("", " (record label)")
    elif kind in {"series", "live series"}:
        suffixes = ("", " (TV series)", " (British TV series)", " (Australian TV series)")
    elif kind == "film":
        suffixes = ("", " (film)")
    else:
        suffixes = ("",)
    return list(dict.fromkeys(f"{base}{suffix}" for suffix in suffixes))


def wikipedia_search_queries(show_name: str, kind: str) -> list[str]:
    base = show_name.strip()
    queries = [base]
    if kind == "music artist":
        queries.extend([f"{base} musician", f"{base} band", f"{base} singer"])
    elif kind == "record label":
        queries.append(f"{base} record label")
    elif kind == "live series":
        queries.extend([f"{base} television series", f"{base} TV series", f"{base} Dutch television series"])
    elif kind == "series":
        queries.extend([f"{base} TV series", f"{base} British TV programme", f"{base} television series"])
    elif kind == "film":
        queries.append(f"{base} film")
    return list(dict.fromkeys(queries))


def normalize_title_match(a: str, b: str) -> float:
    na = normalize_for_wikipedia_match(wikipedia_title_stem(a))
    nb = normalize_for_wikipedia_match(wikipedia_title_stem(b))
    if na and nb and na == nb:
        return 3.0
    return 0.0


def reject_wikipedia_candidate(
    title: str,
    kind: str,
    show_name: str,
    *,
    wikidata: Mapping[str, Any] | None = None,
) -> str | None:
    lower = title.lower()
    if lower.startswith("list of"):
        return "list page"
    if lower.endswith("(disambiguation)") or "(disambiguation)" in lower:
        return "disambiguation"
    if not wikipedia_title_matches_show(title, show_name, wikidata=wikidata):
        return "title mismatch"
    if wikidata:
        instances = set(wikidata.get("instanceOf") or [])
        contradicts = KIND_CONTRADICTING_INSTANCE.get(kind, frozenset())
        if instances & contradicts:
            return "wikidata kind mismatch"
        wd_kind = score_wikidata_instance(wikidata.get("instanceOf") or [], kind)
        if wd_kind < 0:
            return "wikidata kind mismatch"
    if kind in {"music artist", "record label"}:
        for bad in ("(ep)", "(album)", "(song)", "(single)", "(compilation album)"):
            if bad in lower:
                return bad
    if kind in {"series", "live series"}:
        if "(film)" in lower or "(movie)" in lower:
            return "film page"
        if TITLE_YEAR_PAREN.search(title):
            return "year in title (likely film)"
    if kind == "series" and show_name.lower() not in lower:
        film_year = TITLE_YEAR_PAREN.search(title)
        if film_year and normalize_title_match(show_name, title) < 1.5:
            return "title year mismatch"
    return None


def score_wikidata_instance(instance_of: Sequence[str], kind: str) -> float:
    expected = KIND_EXPECTED_INSTANCE_OF.get(kind, frozenset())
    if not expected:
        return 0.0
    hits = set(instance_of) & expected
    if hits:
        return 4.0
    bad = {WD_LIST_ARTICLE, WD_ALBUM, WD_SINGLE, WD_SONG, WD_FILM}
    if set(instance_of) & bad:
        return -4.0
    return -1.0


def wikipedia_pick_score(
    title: str,
    snippet: str,
    kind: str,
    show_name: str,
    *,
    wikidata: Mapping[str, Any] | None = None,
    description: str | None = None,
    youtube_text: str = "",
    imdb_year: str | None = None,
) -> tuple[float, str]:
    text = f"{title} {snippet} {description or ''} {youtube_text}".lower()
    score = 0.0
    reasons: list[str] = []

    reject = reject_wikipedia_candidate(title, kind, show_name, wikidata=wikidata)
    if reject:
        return -10.0, f"rejected: {reject}"

    title_score = normalize_title_match(show_name, title)
    if title_score:
        score += title_score
        reasons.append("title match")

    series_markers = ("television series", "tv series", "animated series", "sitcom", "anthology", "british television")
    film_markers = ("film", "movie", "motion picture")
    music_markers = ("band", "musician", "singer", "rapper", "musical group", "record producer", "songwriter")
    label_markers = ("record label", "independent record", "music label")
    if kind in {"series", "live series"}:
        for word in series_markers:
            if word in text:
                score += 2
                reasons.append(word)
                break
    elif kind == "film":
        for word in film_markers:
            if word in text:
                score += 2
                reasons.append(word)
                break
    elif kind == "music artist":
        for word in music_markers:
            if word in text:
                score += 2
                reasons.append(word)
                break
    elif kind == "record label":
        for word in label_markers:
            if word in text:
                score += 3
                reasons.append(word)
                break

    if wikidata:
        wd_score = score_wikidata_instance(wikidata.get("instanceOf") or [], kind)
        score += wd_score
        if wd_score > 0:
            reasons.append("wikidata kind")
        elif wd_score < 0:
            reasons.append("wikidata mismatch")

    if imdb_year and wikidata:
        wd_year = wikidata.get("startYear")
        if wd_year and str(wd_year).startswith(str(imdb_year)[:4]):
            score += 0.5
            reasons.append("year agrees with imdb")

    if youtube_text and show_name.lower() in youtube_text.lower():
        score += 0.5
        reasons.append("youtube description")

    confidence = "high" if score >= 4 else "medium" if score >= WIKIPEDIA_MIN_ACCEPT_SCORE else "low"
    detail = ", ".join(reasons) if reasons else "weak signals"
    return score, f"{confidence} ({detail})"


def pick_wikipedia_title(
    search_payload: Mapping[str, Any] | Sequence[Mapping[str, Any]],
    show_name: str,
    kind: str,
    *,
    wikidata_by_title: Mapping[str, Mapping[str, Any]] | None = None,
    youtube_text: str = "",
    imdb_year: str | None = None,
) -> tuple[str | None, float, str, str]:
    if isinstance(search_payload, Mapping) and "query" in search_payload:
        search_results = search_payload.get("query", {}).get("search", [])
    else:
        search_results = list(search_payload)
    if not search_results:
        return None, 0.0, "low", "no search hits"
    ranked: list[tuple[float, str, str]] = []
    for hit in search_results:
        title = str(hit.get("title") or "")
        if not title:
            continue
        snippet = str(hit.get("snippet") or "")
        wd = (wikidata_by_title or {}).get(title)
        score, confidence = wikipedia_pick_score(
            title,
            snippet,
            kind,
            show_name,
            wikidata=wd,
            youtube_text=youtube_text,
            imdb_year=imdb_year,
        )
        ranked.append((score, title, confidence))
    ranked.sort(key=lambda row: row[0], reverse=True)
    if not ranked or ranked[0][0] < WIKIPEDIA_MIN_ACCEPT_SCORE:
        best_title = ranked[0][1] if ranked else ""
        best_score = ranked[0][0] if ranked else 0.0
        return None, best_score, "low", f"no confident match (best={best_title!r} score={best_score:.1f})"
    best = ranked[0]
    conf_word = best[2].split(" ", 1)[0]
    return best[1], best[0], conf_word, best[2]


def merge_search_hits(payloads: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for payload in payloads:
        for hit in payload.get("query", {}).get("search", []):
            title = str(hit.get("title") or "")
            if title and title not in seen:
                seen[title] = dict(hit)
    return list(seen.values())


def normalize_title_for_imdb(title: str) -> str:
    text = unicodedata.normalize("NFKD", title)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    return text


@dataclass
class ImdbIndex:
    by_title: dict[str, list[dict[str, Any]]]

    @classmethod
    def build(cls, basics_path: Path, ratings_path: Path) -> "ImdbIndex":
        ratings: dict[str, dict[str, str]] = {}
        with gzip.open(ratings_path, "rt", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            for row in reader:
                ratings[row["tconst"]] = row
        by_title: dict[str, list[dict[str, Any]]] = {}
        wanted = {"tvSeries", "tvMiniSeries", "movie", "tvMovie", "tvSpecial", "video"}
        with gzip.open(basics_path, "rt", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            for row in reader:
                if row.get("titleType") not in wanted:
                    continue
                key = normalize_title_for_imdb(row.get("primaryTitle") or "")
                if not key:
                    continue
                entry = {
                    "tconst": row["tconst"],
                    "titleType": row.get("titleType"),
                    "primaryTitle": row.get("primaryTitle"),
                    "startYear": row.get("startYear") if row.get("startYear") != r"\N" else None,
                    "genres": (row.get("genres") or "").split(",") if row.get("genres") != r"\N" else [],
                }
                rating = ratings.get(row["tconst"])
                if rating:
                    entry["averageRating"] = rating.get("averageRating")
                    entry["numVotes"] = rating.get("numVotes")
                by_title.setdefault(key, []).append(entry)
        return cls(by_title=by_title)

    def match(self, show_name: str, kind: str, *, catalogue_hints: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
        if kind not in {"series", "film", "live series"}:
            return None
        key = normalize_title_for_imdb(show_name)
        candidates = self.by_title.get(key, [])
        if not candidates:
            return None
        prefer = {"movie"} if kind == "film" else {"tvSeries", "tvMiniSeries"}
        uk_bias = bool(catalogue_hints and catalogue_hints.get("uk"))
        ranked = sorted(
            candidates,
            key=lambda row: (
                0 if row.get("titleType") in prefer else 1,
                0 if uk_bias and "British" in (row.get("genres") or []) else 1,
                -int(row.get("numVotes") or 0),
            ),
        )
        best = ranked[0]
        return {
            "tconst": best["tconst"],
            "titleType": best.get("titleType"),
            "primaryTitle": best.get("primaryTitle"),
            "startYear": best.get("startYear"),
            "genres": best.get("genres") or [],
            "rating": best.get("averageRating"),
            "numVotes": best.get("numVotes"),
            "match": "exact_title",
        }


def catalogue_hints_for_group(items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    tiers = {str(item.get("tier") or "") for item in items}
    channels = " ".join(str(item.get("channel") or "") for item in items).lower()
    return {
        "uk": "bbc" in tiers or "uk" in channels or "channel 4" in channels,
    }


class RateLimitedSession:
    """Wrap requests.Session with <=1 req/s pacing and 429/503 retries."""

    def __init__(
        self,
        session: requests.Session,
        *,
        pace_seconds: float = WIKI_PACE_SECONDS,
        sleeper: Callable[[float], None] = time.sleep,
        backoff_initial: float = BACKOFF_INITIAL_SECONDS,
        backoff_max: float = BACKOFF_MAX_SECONDS,
        max_retries: int = WIKI_MAX_RETRIES,
    ) -> None:
        self._session = session
        self._pace = pace_seconds
        self._sleeper = sleeper
        self._last_request = 0.0
        self._backoff_initial = backoff_initial
        self._backoff_max = backoff_max
        self._max_retries = max_retries

    def _wait_pace(self) -> None:
        now = time.monotonic()
        wait = self._pace - (now - self._last_request)
        if wait > 0:
            self._sleeper(wait)
        self._last_request = time.monotonic()

    def _retry_after_seconds(self, response: requests.Response, attempt: int) -> float:
        header = response.headers.get("Retry-After")
        if header:
            try:
                return min(float(header), self._backoff_max)
            except ValueError:
                pass
        return min(self._backoff_initial * (2 ** attempt), self._backoff_max)

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        attempt = 0
        while True:
            self._wait_pace()
            response = self._session.request(method, url, **kwargs)
            if response.status_code not in RETRY_HTTP_STATUSES:
                return response
            delay = self._retry_after_seconds(response, attempt)
            logging.warning(
                "HTTP %s from %s; backing off %.1fs (attempt %s)",
                response.status_code,
                url,
                delay,
                attempt + 1,
            )
            if attempt + 1 >= self._max_retries:
                raise WikiThrottledError(
                    f"HTTP {response.status_code} from {url} after {attempt + 1} attempt(s)"
                )
            self._sleeper(delay)
            attempt += 1

    def get(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("GET", url, **kwargs)


def chunk_sequence(items: Sequence[str], size: int) -> Iterable[list[str]]:
    batch: list[str] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _claim_values(claims: Mapping[str, Any], prop: str) -> list[Any]:
    out: list[Any] = []
    for claim in claims.get(prop, []):
        try:
            value = claim["mainsnak"]["datavalue"]["value"]
        except (KeyError, TypeError):
            continue
        if isinstance(value, dict) and "id" in value:
            out.append(value["id"])
        elif isinstance(value, dict) and "time" in value:
            out.append(value["time"].lstrip("+").split("T", 1)[0][:4])
        elif isinstance(value, str):
            out.append(value)
    return out


def parse_wikidata_entity(entity: Mapping[str, Any]) -> dict[str, Any]:
    qid = str(entity.get("id") or "")
    claims = entity.get("claims") or {}
    labels = entity.get("labels") or {}
    aliases = entity.get("aliases") or {}
    label_en = labels.get("en", {}).get("value") if isinstance(labels.get("en"), Mapping) else None
    alias_en = [
        str(row.get("value"))
        for row in aliases.get("en", [])
        if isinstance(row, Mapping) and row.get("value")
    ]
    return {
        "id": qid,
        "label": label_en,
        "aliases": alias_en,
        "instanceOf": _claim_values(claims, "P31"),
        "genres": _claim_values(claims, "P136"),
        "startYear": (_claim_values(claims, "P577") or _claim_values(claims, "P580") or [None])[0],
        "country": _claim_values(claims, "P495") or _claim_values(claims, "P27"),
    }


def wikidata_entities_batch(
    session: RateLimitedSession, qids: Sequence[str]
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    unique = [qid for qid in dict.fromkeys(qid for qid in qids if qid)]
    for batch in chunk_sequence(unique, WIKI_BATCH_SIZE):
        params = {
            "action": "wbgetentities",
            "ids": "|".join(batch),
            "props": "claims|labels|aliases",
            "format": "json",
        }
        response = session.get(WIKI_API, params=params, timeout=60)
        response.raise_for_status()
        for qid, entity in (response.json().get("entities") or {}).items():
            if not entity or entity.get("missing"):
                continue
            out[qid] = parse_wikidata_entity(entity)
    return out


def wikidata_entities(
    session: RateLimitedSession | requests.Session, qid: str
) -> dict[str, Any] | None:
    if not qid:
        return None
    if isinstance(session, RateLimitedSession):
        batch = wikidata_entities_batch(session, [qid])
        return batch.get(qid)
    params = {
        "action": "wbgetentities",
        "ids": qid,
        "props": "claims|labels|aliases",
        "format": "json",
    }
    response = session.get(WIKI_API, params=params, timeout=60)
    response.raise_for_status()
    entity = response.json().get("entities", {}).get(qid, {})
    if not entity or entity.get("missing"):
        return None
    return parse_wikidata_entity(entity)


@dataclass
class WikipediaPageRef:
    title: str
    qid: str | None = None
    disambiguation: bool = False
    missing: bool = False


def batch_query_titles(
    session: RateLimitedSession, titles: Sequence[str]
) -> dict[str, WikipediaPageRef]:
    """Map each requested title (after redirects) to page metadata."""
    ordered = list(dict.fromkeys(t for t in titles if t))
    resolved: dict[str, WikipediaPageRef] = {}
    pages_by_title: dict[str, Mapping[str, Any]] = {}
    for batch in chunk_sequence(ordered, WIKI_BATCH_SIZE):
        params = {
            "action": "query",
            "titles": "|".join(batch),
            "redirects": 1,
            "prop": "pageprops|info",
            "ppprop": "wikibase_item|disambiguation",
            "format": "json",
            "formatversion": 2,
        }
        response = session.get(WIKI_API, params=params, timeout=60)
        response.raise_for_status()
        query = response.json().get("query") or {}
        payload = query if isinstance(query, Mapping) else {}
        redirects_raw = payload.get("redirects")
        redirect_rows = redirects_raw if isinstance(redirects_raw, list) else []
        direct = {
            str(row.get("from") or ""): str(row.get("to") or "")
            for row in redirect_rows
            if isinstance(row, Mapping) and row.get("from") and row.get("to")
        }

        def canonical_title(title: str) -> str:
            seen: set[str] = set()
            current = title
            while current in direct and current not in seen:
                seen.add(current)
                current = direct[current]
            return current

        pages_raw = payload.get("pages")
        for page in pages_raw if isinstance(pages_raw, list) else []:
            title = str(page.get("title") or "")
            if title:
                pages_by_title[title] = page
        for requested in batch:
            canonical = canonical_title(requested)
            page = pages_by_title.get(canonical)
            if not page or page.get("missing"):
                resolved[requested] = WikipediaPageRef(title=canonical, missing=True)
                continue
            props = page.get("pageprops") or {}
            resolved[requested] = WikipediaPageRef(
                title=str(page.get("title") or canonical),
                qid=str(props.get("wikibase_item") or "") or None,
                disambiguation="disambiguation" in props,
                missing=False,
            )
    return resolved


@dataclass
class WikipediaResolveResult:
    wikipedia: dict[str, Any] | None = None
    wikipedia_status: str | None = None
    looked_up: bool = False


@dataclass
class WikipediaRunResolver:
    """Batch exact-title Wikipedia resolution for a harvest run."""

    session: RateLimitedSession
    _title_pages: dict[str, WikipediaPageRef] = field(default_factory=dict)
    _wikidata_by_title: dict[str, dict[str, Any]] = field(default_factory=dict)
    _wikidata_by_qid: dict[str, dict[str, Any]] = field(default_factory=dict)
    _api_exhausted: bool = False

    def prepare(self, shows: Sequence[tuple[str, str]]) -> None:
        candidates: list[str] = []
        for name, kind in shows:
            candidates.extend(wikipedia_kind_title_variants(name, kind))
        unique = list(dict.fromkeys(candidates))
        try:
            for batch in chunk_sequence(unique, WIKI_BATCH_SIZE):
                self._title_pages.update(batch_query_titles(self.session, batch))
        except WikiThrottledError:
            self._api_exhausted = True
            return
        qids = [ref.qid for ref in self._title_pages.values() if ref.qid]
        try:
            self._wikidata_by_qid = wikidata_entities_batch(self.session, qids)
        except WikiThrottledError:
            self._api_exhausted = True
            return
        for ref in self._title_pages.values():
            if ref.qid and ref.qid in self._wikidata_by_qid:
                self._wikidata_by_title[ref.title] = self._wikidata_by_qid[ref.qid]

    def _page_wikidata(self, title: str) -> dict[str, Any] | None:
        return self._wikidata_by_title.get(title)

    def _pick_exact(self, show_name: str, kind: str, *, youtube_text: str, imdb_year: str | None) -> tuple[str | None, float, str, str]:
        for candidate in wikipedia_kind_title_variants(show_name, kind):
            ref = self._title_pages.get(candidate)
            if not ref or ref.missing or ref.disambiguation:
                continue
            title = ref.title
            wd = self._page_wikidata(title)
            reject = reject_wikipedia_candidate(title, kind, show_name, wikidata=wd)
            if reject:
                continue
            score, confidence = wikipedia_pick_score(
                title,
                "",
                kind,
                show_name,
                wikidata=wd,
                youtube_text=youtube_text,
                imdb_year=imdb_year,
            )
            if score >= WIKIPEDIA_MIN_ACCEPT_SCORE:
                conf_word = confidence.split(" ", 1)[0]
                return title, score, conf_word, confidence
        return None, 0.0, "low", "no exact-title match"

    def _fetch_summary(self, title: str) -> dict[str, Any]:
        summary_url = WIKI_REST + urllib.parse.quote(title.replace(" ", "_"), safe="/()")
        summary = self.session.get(summary_url, timeout=60)
        if summary.status_code == 404:
            return {
                "title": title,
                "url": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
            }
        summary.raise_for_status()
        return summary.json()

    def _search_fallback(
        self,
        show_name: str,
        kind: str,
        *,
        youtube_text: str,
        imdb_year: str | None,
        seed_wikidata: dict[str, Mapping[str, Any]],
    ) -> tuple[str | None, float, str, str, dict[str, Mapping[str, Any]]]:
        search_payloads: list[Mapping[str, Any]] = []
        try:
            for query in wikipedia_search_queries(show_name, kind):
                search_params = {
                    "action": "query",
                    "list": "search",
                    "srsearch": query,
                    "srlimit": 8,
                    "format": "json",
                }
                search = self.session.get(WIKI_API, params=search_params, timeout=60)
                search.raise_for_status()
                search_payloads.append(search.json())
        except WikiThrottledError:
            raise

        hits = merge_search_hits(search_payloads)
        wikidata_by_title = dict(seed_wikidata)
        pre_ranked: list[tuple[float, dict[str, Any]]] = []
        for hit in hits:
            title = str(hit.get("title") or "")
            snippet = str(hit.get("snippet") or "")
            score, _ = wikipedia_pick_score(title, snippet, kind, show_name, youtube_text=youtube_text)
            if score > -5:
                pre_ranked.append((score, hit))
        pre_ranked.sort(key=lambda row: row[0], reverse=True)
        top_hits = [hit for _, hit in pre_ranked[:6]]

        qids_needed: list[str] = []
        title_refs: dict[str, WikipediaPageRef] = {}
        for hit in top_hits:
            title = str(hit.get("title") or "")
            if title in wikidata_by_title or not title:
                continue
            if title not in title_refs:
                try:
                    title_refs.update(batch_query_titles(self.session, [title]))
                except WikiThrottledError:
                    raise
            ref = title_refs.get(title)
            if ref and ref.qid and ref.qid not in self._wikidata_by_qid:
                qids_needed.append(ref.qid)
        if qids_needed:
            try:
                fetched = wikidata_entities_batch(self.session, qids_needed)
            except WikiThrottledError:
                raise
            self._wikidata_by_qid.update(fetched)
        for hit in top_hits:
            title = str(hit.get("title") or "")
            ref = title_refs.get(title) or self._title_pages.get(title)
            if not title:
                continue
            if ref and ref.qid and ref.qid in self._wikidata_by_qid:
                wd = self._wikidata_by_qid[ref.qid]
                wikidata_by_title[title] = wd
                self._wikidata_by_title[title] = wd

        return pick_wikipedia_title(
            hits,
            show_name,
            kind,
            wikidata_by_title=wikidata_by_title,
            youtube_text=youtube_text,
            imdb_year=imdb_year,
        ) + (wikidata_by_title,)

    def resolve(
        self,
        show_name: str,
        kind: str,
        *,
        youtube_text: str = "",
        imdb_year: str | None = None,
    ) -> WikipediaResolveResult:
        if self._api_exhausted:
            return WikipediaResolveResult(wikipedia=None, wikipedia_status="throttled", looked_up=False)
        title, score, confidence, pick_reason = self._pick_exact(
            show_name, kind, youtube_text=youtube_text, imdb_year=imdb_year
        )
        wikidata_by_title = dict(self._wikidata_by_title)
        if not title:
            try:
                title, score, confidence, pick_reason, wikidata_by_title = self._search_fallback(
                    show_name,
                    kind,
                    youtube_text=youtube_text,
                    imdb_year=imdb_year,
                    seed_wikidata=wikidata_by_title,
                )
            except WikiThrottledError:
                return WikipediaResolveResult(wikipedia=None, wikipedia_status="throttled", looked_up=False)
        if not title:
            logging.info("Wikipedia: no match for %r (%s): %s", show_name, kind, pick_reason)
            return WikipediaResolveResult(wikipedia=None, wikipedia_status=None, looked_up=True)

        try:
            body = self._fetch_summary(title)
        except WikiThrottledError:
            return WikipediaResolveResult(wikipedia=None, wikipedia_status="throttled", looked_up=False)
        wikidata = wikidata_by_title.get(title)
        if not wikidata:
            qid = body.get("wikibase_item")
            if qid:
                if qid in self._wikidata_by_qid:
                    wikidata = self._wikidata_by_qid[qid]
                else:
                    try:
                        batch = wikidata_entities_batch(self.session, [qid])
                    except WikiThrottledError:
                        return WikipediaResolveResult(wikipedia=None, wikipedia_status="throttled", looked_up=False)
                    wikidata = batch.get(qid)
        wiki_url = body.get("content_urls", {}).get("desktop", {}).get("page") or (
            f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"
        )
        return WikipediaResolveResult(
            wikipedia={
                "title": body.get("title") or title,
                "extract": body.get("extract"),
                "description": body.get("description"),
                "url": wiki_url,
                "wikidata": wikidata,
                "confidence": confidence,
                "searchScore": score,
                "pickReason": pick_reason,
            },
            wikipedia_status=None,
            looked_up=True,
        )


def wikipedia_resolve_title(session: RateLimitedSession, title: str) -> str | None:
    params = {
        "action": "query",
        "titles": title,
        "redirects": 1,
        "format": "json",
    }
    response = session.get(WIKI_API, params=params, timeout=60)
    response.raise_for_status()
    payload = response.json()
    resolved = title
    for redirect in payload.get("query", {}).get("redirects", []):
        if str(redirect.get("to") or ""):
            resolved = str(redirect["to"])
    pages = payload.get("query", {}).get("pages", {})
    for page in pages.values():
        if int(page.get("pageid", -1)) < 0:
            return None
        missing = page.get("missing")
        if missing:
            return None
    return resolved


def wikipedia_pick_from_exact_titles(
    session: RateLimitedSession,
    show_name: str,
    kind: str,
    *,
    youtube_text: str = "",
    imdb_year: str | None = None,
) -> tuple[str | None, float, str, str, dict[str, Mapping[str, Any]]]:
    wikidata_by_title: dict[str, Mapping[str, Any]] = {}
    for candidate in wikipedia_kind_title_variants(show_name, kind):
        resolved = wikipedia_resolve_title(session, candidate)
        if not resolved:
            continue
        wd = wikipedia_page_wikidata(session, resolved)
        if wd:
            wikidata_by_title[resolved] = wd
        reject = reject_wikipedia_candidate(resolved, kind, show_name, wikidata=wd)
        if reject:
            continue
        score, confidence = wikipedia_pick_score(
            resolved,
            "",
            kind,
            show_name,
            wikidata=wd,
            youtube_text=youtube_text,
            imdb_year=imdb_year,
        )
        if score >= WIKIPEDIA_MIN_ACCEPT_SCORE:
            conf_word = confidence.split(" ", 1)[0]
            return resolved, score, conf_word, confidence, wikidata_by_title
    return None, 0.0, "low", "no exact-title match", wikidata_by_title


def wikipedia_page_wikidata(session: RateLimitedSession, title: str) -> dict[str, Any] | None:
    params = {
        "action": "query",
        "titles": title,
        "prop": "pageprops",
        "ppprop": "wikibase_item",
        "format": "json",
    }
    response = session.get(WIKI_API, params=params, timeout=60)
    response.raise_for_status()
    pages = response.json().get("query", {}).get("pages", {})
    for page in pages.values():
        qid = (page.get("pageprops") or {}).get("wikibase_item")
        if qid:
            return wikidata_entities(session, qid)
    return None


def fetch_wikipedia(
    session: RateLimitedSession,
    show_name: str,
    kind: str,
    *,
    youtube_text: str = "",
    imdb_year: str | None = None,
    max_candidates: int = 6,
) -> dict[str, Any] | None:
    """Single-show helper (tests); production runs use WikipediaRunResolver batches."""
    del max_candidates
    resolver = WikipediaRunResolver(session=session)
    resolver.prepare([(show_name, kind)])
    result = resolver.resolve(show_name, kind, youtube_text=youtube_text, imdb_year=imdb_year)
    if result.wikipedia_status == "throttled":
        raise WikiThrottledError(f"Wikipedia throttled for {show_name!r}")
    return result.wikipedia


def ensure_imdb_datasets(state_dir: Path, session: requests.Session, dry_run: bool = False) -> tuple[Path, Path]:
    imdb_dir = state_dir / "imdb"
    basics = imdb_dir / "title.basics.tsv.gz"
    ratings = imdb_dir / "title.ratings.tsv.gz"
    imdb_dir.mkdir(parents=True, exist_ok=True)
    paced = RateLimitedSession(session, pace_seconds=0.0)
    for url, path in ((IMDB_BASICS_URL, basics), (IMDB_RATINGS_URL, ratings)):
        if path.exists():
            continue
        if dry_run:
            continue
        with paced.get(url, stream=True, timeout=120) as response:
            response.raise_for_status()
            with path.open("wb") as handle:
                shutil.copyfileobj(response.raw, handle)
    return basics, ratings


def yt_dlp_descriptions(
    video_ids: Sequence[str],
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]],
    sleeper: Callable[[float], None] = time.sleep,
    pace: float = YOUTUBE_PACE_SECONDS,
) -> tuple[list[dict[str, Any]], bool]:
    """Return descriptions and whether a bot-check stopped the run."""
    out: list[dict[str, Any]] = []
    for index, video_id in enumerate(video_ids):
        if index:
            sleeper(pace)
        try:
            proc = runner(
                [
                    YT_DLP,
                    "--skip-download",
                    "--no-warnings",
                    "--dump-json",
                    f"https://www.youtube.com/watch?v={video_id}",
                ],
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            # No yt-dlp on this Mac: the show still gets its Wikipedia and IMDb data.
            out.append({"videoId": video_id, "error": "yt-dlp not found"})
            return out, False
        combined = (proc.stdout or "") + (proc.stderr or "")
        if SIGN_IN_MARKER in combined:
            return out, True
        if proc.returncode != 0:
            out.append({"videoId": video_id, "error": (proc.stderr or proc.stdout or "yt-dlp failed").strip()})
            continue
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            out.append({"videoId": video_id, "error": "invalid json"})
            continue
        out.append(
            {
                "videoId": video_id,
                "title": payload.get("title"),
                "description": payload.get("description"),
                "channel": payload.get("channel"),
                "upload_date": payload.get("upload_date"),
            }
        )
    return out, False


def meta_is_fresh(path: Path, now: datetime, max_age: timedelta = META_MAX_AGE) -> bool:
    if not path.exists():
        return False
    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return now - mtime < max_age


def build_record(
    group: ShowGroup,
    *,
    wikipedia: dict[str, Any] | None,
    imdb: dict[str, Any] | None,
    youtube: list[dict[str, Any]] | None,
    harvested_at: str,
    error: str | None = None,
    wikipedia_status: str | None = None,
) -> dict[str, Any]:
    kind = guess_kind(group.name, group.items, raw_channels=group.raw_channels)
    record: dict[str, Any] = {
        "name": group.name,
        "slug": group.slug,
        "kind": kind,
        "channels": group.raw_channels,
        "episodeCount": len(group.items),
        "tiers": sorted({str(item.get("tier") or "") for item in group.items}),
        "harvestedAt": harvested_at,
        "wikipedia": wikipedia,
        "imdb": imdb,
    }
    if wikipedia_status:
        record["wikipedia_status"] = wikipedia_status
    if youtube is not None:
        record["youtube"] = {"descriptions": youtube}
    if error:
        record["error"] = error
    return record


def read_meta_record(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def plan_harvest(
    shows: Sequence[ShowGroup],
    *,
    meta_dir: Path,
    now: datetime,
    refresh: bool,
    limit: int | None,
    resume: bool = False,
) -> list[ShowGroup]:
    planned: list[ShowGroup] = []
    for group in shows:
        path = meta_dir / f"{group.slug}.json"
        existing = read_meta_record(path)
        if resume and existing and existing.get("wikipedia_status") == "throttled":
            planned.append(group)
            if limit is not None and len(planned) >= limit:
                break
            continue
        if not refresh and meta_is_fresh(path, now):
            continue
        planned.append(group)
        if limit is not None and len(planned) >= limit:
            break
    return planned


def configure_logging(state_dir: Path) -> None:
    log_dir = state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "harvest.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(log_file, encoding="utf-8"), logging.StreamHandler(sys.stderr)],
    )


def youtube_description_text(entries: Sequence[Mapping[str, Any]] | None) -> str:
    if not entries:
        return ""
    return " ".join(str(e.get("description") or "") for e in entries)


def harvest_show(
    group: ShowGroup,
    *,
    session: RateLimitedSession,
    imdb_index: ImdbIndex | None,
    runner: Callable[..., subprocess.CompletedProcess[str]],
    sleeper: Callable[[float], None],
    youtube_enabled: bool,
    wiki_resolver: WikipediaRunResolver | None = None,
) -> tuple[dict[str, Any], bool]:
    kind = guess_kind(group.name, group.items, raw_channels=group.raw_channels)
    hints = catalogue_hints_for_group(group.items)
    imdb = imdb_index.match(group.name, kind, catalogue_hints=hints) if imdb_index else None
    imdb_year = str(imdb.get("startYear") or "") if imdb else None
    youtube: list[dict[str, Any]] | None = None
    stopped = False
    if youtube_enabled and group.youtube_video_ids():
        youtube, stopped = yt_dlp_descriptions(group.youtube_video_ids(), runner=runner, sleeper=sleeper)
    yt_text = youtube_description_text(youtube)
    wikipedia_status: str | None = None
    wikipedia: dict[str, Any] | None = None
    if wiki_resolver is not None:
        wiki_result = wiki_resolver.resolve(group.name, kind, youtube_text=yt_text, imdb_year=imdb_year)
        wikipedia = wiki_result.wikipedia
        wikipedia_status = wiki_result.wikipedia_status
    else:
        wikipedia = fetch_wikipedia(session, group.name, kind, youtube_text=yt_text, imdb_year=imdb_year)
    record = build_record(
        group,
        wikipedia=wikipedia,
        imdb=imdb,
        youtube=youtube,
        harvested_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        wikipedia_status=wikipedia_status,
    )
    return record, stopped


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Harvest show metadata for Onto the TV embeddings.")
    parser.add_argument(
        "--catalogue",
        type=Path,
        help="Path to channels/catalogue HTML containing const VIDEOS (default: tv-server userData channels.html).",
    )
    parser.add_argument("--meta-dir", type=Path, default=None, help="Output directory for per-show JSON.")
    parser.add_argument("--state-dir", type=Path, default=None, help="State directory for datasets and logs.")
    parser.add_argument("--refresh", action="store_true", help="Re-harvest even when JSON is newer than 30 days.")
    parser.add_argument("--limit", type=int, default=None, help="Harvest at most N shows this run.")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan without writing or calling out.")
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Re-harvest shows whose saved JSON has wikipedia_status throttled.",
    )
    return parser.parse_args(argv)


def default_catalogue_path() -> Path:
    return Path.home() / ".local" / "state" / "onto-tv" / "channels.html"


def main(argv: Sequence[str] | None = None) -> int:
    if requests is None:
        print("requests is required", file=sys.stderr)
        return 2
    args = parse_args(argv)
    state_dir = args.state_dir or default_state_dir()
    meta_dir = args.meta_dir or default_meta_dir(state_dir)
    catalogue_path = args.catalogue or default_catalogue_path()
    configure_logging(state_dir)
    if not catalogue_path.exists():
        logging.error("Catalogue not found: %s", catalogue_path)
        return 1
    html = catalogue_path.read_text(encoding="utf-8")
    videos = read_catalogue(html, catalogue_path, catalogue_path)
    shows = list_shows(videos)
    now = datetime.now(timezone.utc)
    planned = plan_harvest(
        shows,
        meta_dir=meta_dir,
        now=now,
        refresh=args.refresh,
        limit=args.limit,
        resume=args.resume,
    )
    if args.dry_run:
        for group in planned:
            yt = group.youtube_video_ids()
            print(
                f"{group.slug}: {group.name} ({guess_kind(group.name, group.items, raw_channels=group.raw_channels)}) "
                f"episodes={len(group.items)} youtube_ids={len(yt)}"
            )
        print(f"Would harvest {len(planned)} of {len(shows)} shows into {meta_dir}")
        return 0
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    basics, ratings = ensure_imdb_datasets(state_dir, session, dry_run=False)
    imdb_index = ImdbIndex.build(basics, ratings) if basics.exists() and ratings.exists() else None
    meta_dir.mkdir(parents=True, exist_ok=True)
    paced = RateLimitedSession(session)
    wiki_resolver = WikipediaRunResolver(session=paced)
    prepared = [(group.name, guess_kind(group.name, group.items, raw_channels=group.raw_channels)) for group in planned]
    wiki_resolver.prepare(prepared)
    harvested = 0
    for group in planned:
        out_path = meta_dir / f"{group.slug}.json"
        harvested_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        try:
            record, stopped = harvest_show(
                group,
                session=paced,
                imdb_index=imdb_index,
                runner=subprocess.run,
                sleeper=time.sleep,
                youtube_enabled=True,
                wiki_resolver=wiki_resolver,
            )
        except Exception as exc:
            logging.exception("Harvest failed for %s: %s", group.name, exc)
            record = build_record(
                group,
                wikipedia=None,
                imdb=None,
                youtube=None,
                harvested_at=harvested_at,
                error=str(exc),
            )
            stopped = False
        out_path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        logging.info("Wrote %s", out_path)
        harvested += 1
        if stopped:
            logging.warning("YouTube bot-check encountered; stopping early this run.")
            break
    logging.info("Harvested %s show(s)", harvested)
    return 0


@dataclass
class ShowGroup:
    name: str
    raw_channels: list[str] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)

    @property
    def slug(self) -> str:
        return slugify(self.name)

    def youtube_video_ids(self, limit: int = 5) -> list[str]:
        seen: list[str] = []
        for item in self.items:
            vid = youtube_id_from_src(item.get("src", ""))
            if vid and vid not in seen:
                seen.append(vid)
            if len(seen) >= limit:
                break
        return seen


def list_shows(videos: Sequence[Mapping[str, Any]]) -> list[ShowGroup]:
    groups: dict[str, ShowGroup] = {}
    for video in videos:
        channel = str(video.get("channel") or "Other")
        name = normalize_show_name(channel)
        group = groups.setdefault(name, ShowGroup(name=name))
        if channel not in group.raw_channels:
            group.raw_channels.append(channel)
        group.items.append(dict(video))
    return sorted(groups.values(), key=lambda g: g.name.lower())


if __name__ == "__main__":
    raise SystemExit(main())