"""
fetch_nba_extra.py — what the box score doesn't say, for the NBA factor tests.

For every game already in data/nba_{season}.jsonl, ESPN's game summary gives:
  - the referee crew,
  - the pre-game spread and total, where ESPN kept them (pickcenter),
  - every field-goal attempt from the play-by-play: shooter, team, zone, made,
    assisted by whom, blocked by whom.

Zones, from the shot's distance (the play text's "N-foot", else the court
coordinate, which puts the rim at x=25, y=0 in feet):
  rim (< 4 ft), paint (4-9), mid (10+ and a two), corner3 (a three within
  9 ft of the baseline line), ab3 (any other three).

    python3 research/player-props/fetch_nba_extra.py 2025

Writes data/nba_extra_{season}.jsonl (gitignored). Safe to re-run.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_espn import DATA, SITE, get  # noqa: E402

FOOT = re.compile(r"(\d+)-foot")


def zone(p: dict) -> str:
    three = p.get("pointsAttempted") == 3
    c = p.get("coordinate") or {}
    x, y = c.get("x"), c.get("y")
    m = FOOT.search(p.get("text") or "")
    if m:
        dist = float(m.group(1))
    elif isinstance(x, (int, float)) and isinstance(y, (int, float)) and abs(x) < 100:
        dist = math.hypot(x - 25, y)
    else:
        dist = 0.0 if not three else 24.0
    if three:
        return "corner3" if isinstance(y, (int, float)) and 0 <= y <= 9 and abs(x) < 100 else "ab3"
    if dist < 4:
        return "rim"
    if dist < 10:
        return "paint"
    return "mid"


def extract(eid: str, d: dict) -> dict:
    gi = d.get("gameInfo") or {}
    refs = [o.get("displayName") for o in gi.get("officials") or [] if o.get("displayName")]
    odds = None
    for pc in d.get("pickcenter") or []:
        if pc.get("spread") is not None or pc.get("overUnder") is not None:
            odds = {"spread": pc.get("spread"), "total": pc.get("overUnder")}
            break
    shots = []
    for p in d.get("plays") or []:
        if not p.get("shootingPlay") or p.get("pointsAttempted") not in (2, 3):
            continue
        parts = [x.get("athlete", {}).get("id") for x in p.get("participants") or []]
        if not parts or not parts[0]:
            continue
        txt = (p.get("text") or "").lower()
        made = bool(p.get("scoringPlay"))
        ast = parts[1] if made and len(parts) > 1 and "assist" in txt else ""
        blk = parts[1] if not made and len(parts) > 1 and "block" in txt else ""
        shots.append(
            [
                parts[0],
                (p.get("team") or {}).get("id", ""),
                zone(p),
                int(made),
                ast or "",
                blk or "",
                int((p.get("period") or {}).get("number") or 0),
            ]
        )
    return {"id": eid, "refs": refs, "odds": odds, "shots": shots}


def main() -> None:
    season = int(sys.argv[1])
    src = os.path.join(DATA, f"nba_{season}.jsonl")
    ids = [json.loads(l)["id"] for l in open(src) if l.strip()]
    out = os.path.join(DATA, f"nba_extra_{season}.jsonl")
    have = set()
    if os.path.exists(out):
        have = {json.loads(l)["id"] for l in open(out) if l.strip()}
    todo = [i for i in ids if i not in have]
    print(f"{season}: {len(todo)} to fetch ({len(have)} already)")

    def one(eid: str) -> dict | None:
        d = get(f"{SITE}/basketball/nba/summary?event={eid}")
        return extract(eid, d) if d else None

    with open(out, "a") as f, ThreadPoolExecutor(8) as ex:
        for k, r in enumerate(ex.map(one, todo)):
            if r:
                f.write(json.dumps(r, separators=(",", ":")) + "\n")
            if k % 200 == 0:
                print(f"{season}: {k}/{len(todo)}", flush=True)
    print(f"{season}: done")


if __name__ == "__main__":
    main()
