"""
fetch_first_goal.py — who scored each NHL game's first goal.

The compact box scores (fetch_espn.py) carry each player's goals but not their
order. The first-goalscorer market needs the order, so this reads each game's
play-by-play for its first goal (shootout attempts are not goals).

    python3 research/player-props/fetch_first_goal.py 2025

Writes research/player-props/data/nhl_first_{season}.json: {game id: player id or null}.
"""

from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_espn import DATA, SITE, get  # noqa: E402


def first_goal(eid: str) -> tuple[str, str | None]:
    d = get(f"{SITE}/hockey/nhl/summary?event={eid}") or {}
    plays = [p for p in d.get("plays", []) if p.get("scoringPlay")]
    for p in plays:
        if (p.get("period") or {}).get("number", 0) >= 5 and "shootout" in (p.get("text") or "").lower():
            continue
        for part in p.get("participants", []):
            if part.get("type") == "scorer":
                return eid, (part.get("athlete") or {}).get("id")
        return eid, None
    return eid, None


def main() -> None:
    season = int(sys.argv[1])
    with open(os.path.join(DATA, f"nhl_{season}.jsonl")) as f:
        ids = [json.loads(l)["id"] for l in f if l.strip()]
    out = {}
    with ThreadPoolExecutor(8) as ex:
        for eid, pid in ex.map(first_goal, ids):
            out[eid] = pid
    with open(os.path.join(DATA, f"nhl_first_{season}.json"), "w") as f:
        json.dump(out, f)
    print(f"nhl {season}: {sum(1 for v in out.values() if v)} of {len(out)} games with a first goal")


if __name__ == "__main__":
    main()
