"""
fetch_positions.py — every player's position for a football season.

Box scores do not carry positions, and the simulator's football builder needs
them (who is a quarterback, a back, a tight end, a receiver, a defender).
ESPN's season-wide player feed (statistics/byathlete), which the live site
reads for last season's numbers, lists each player's position.

    python3 research/player-props/fetch_positions.py nfl 2025
    python3 research/player-props/fetch_positions.py cfb 2024

Writes research/player-props/data/positions_{league}_{season}.json: {id: "WR"}.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PATH = {"nfl": "football/nfl", "cfb": "football/college-football"}
WEB = "https://site.web.api.espn.com/apis/common/v3/sports"


def get(url: str) -> dict:
    for i in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception:  # noqa: BLE001
            time.sleep(2 * (i + 1))
    return {}


def main() -> None:
    league, season = sys.argv[1], int(sys.argv[2])
    url = (
        f"{WEB}/{PATH[league]}/statistics/byathlete?region=us&lang=en&contentorigin=espn"
        f"&isqualified=false&season={season}&seasontype=2&limit=1000"
    )
    first = get(f"{url}&page=1")
    pages = first.get("pagination", {}).get("pages", 1)
    out: dict[str, str] = {}

    def read(d: dict) -> None:
        for a in d.get("athletes", []):
            ath = a.get("athlete", {})
            pos = (ath.get("position") or {}).get("abbreviation")
            if ath.get("id") and pos:
                out[str(ath["id"])] = pos

    read(first)
    with ThreadPoolExecutor(6) as ex:
        for d in ex.map(lambda p: get(f"{url}&page={p}"), range(2, pages + 1)):
            read(d)
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, f"positions_{league}_{season}.json"), "w") as f:
        json.dump(out, f)
    print(f"{league} {season}: {len(out)} positions from {pages} pages")


if __name__ == "__main__":
    main()
