"""
fetch_espn.py — every NBA or NHL game of a season, as compact player lines.

For the player-props research (NBA points, NHL points and goals): one JSON
line per game with the final score, the pre-game DraftKings line ESPN kept in
`pickcenter`, and every player's box-score line, including the players who
were listed but did not play (they matter: a board that names a scratched
player has made a call that cannot come in).

    python3 research/player-props/fetch_espn.py nba 2025     # 2025-26
    python3 research/player-props/fetch_espn.py nhl 2024     # 2024-25

Writes research/player-props/data/{sport}_{season}.jsonl (gitignored). Safe to
re-run: games already in the file are skipped.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
SITE = "https://site.api.espn.com/apis/site/v2/sports"
PATH = {"nba": "basketball/nba", "nhl": "hockey/nhl"}

# Regular season through the end of the playoffs. Preseason (season type 1)
# is dropped when the games are read, so a generous window is harmless.
WINDOW = {
    ("nba", 2024): ("2024-10-22", "2025-06-25"),
    ("nba", 2025): ("2025-10-21", "2026-06-25"),
    ("nba", 2026): ("2026-10-20", None),
    ("nhl", 2024): ("2024-10-04", "2025-06-25"),
    ("nhl", 2025): ("2025-10-07", "2026-06-25"),
    ("nhl", 2026): ("2026-10-06", None),
}


def get(url: str, tries: int = 5) -> dict | None:
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                return json.load(r)
        except Exception:  # noqa: BLE001 — network: retry, then give up on this one
            time.sleep(1.5 * (i + 1))
    return None


def num(x: str | None) -> float:
    try:
        return float(x) if x not in (None, "", "--") else 0.0
    except ValueError:
        return 0.0


def secs(clock: str | None) -> float:
    """'20:24' -> 1224.0 seconds; NBA minutes come as a plain number."""
    if not clock or clock == "--":
        return 0.0
    if ":" in clock:
        m, s = clock.split(":")
        return int(m) * 60 + int(s)
    return num(clock) * 60


def made_att(x: str | None) -> tuple[float, float]:
    if not x or "-" not in x:
        return 0.0, 0.0
    a, b = x.split("-", 1)
    return num(a), num(b)


def nba_line(labels: list[str], stats: list[str]) -> dict:
    s = dict(zip(labels, stats))
    fgm, fga = made_att(s.get("FG"))
    tpm, tpa = made_att(s.get("3PT"))
    ftm, fta = made_att(s.get("FT"))
    return {
        "min": num(s.get("MIN")),
        "pts": num(s.get("PTS")),
        "fgm": fgm, "fga": fga, "tpm": tpm, "tpa": tpa, "ftm": ftm, "fta": fta,
        "reb": num(s.get("REB")), "ast": num(s.get("AST")), "tov": num(s.get("TO")),
        "stl": num(s.get("STL")), "blk": num(s.get("BLK")), "pf": num(s.get("PF")),
    }


def nhl_line(labels: list[str], stats: list[str]) -> dict:
    s = dict(zip(labels, stats))
    if "SA" in s or "SV" in s:  # goalie
        return {
            "toi": secs(s.get("TOI")),
            "sa": num(s.get("SA")), "sv": num(s.get("SV")), "ga": num(s.get("GA")),
        }
    return {
        "toi": secs(s.get("TOI")), "pptoi": secs(s.get("PPTOI")),
        "g": num(s.get("G")), "a": num(s.get("A")), "sog": num(s.get("SOG")),
        "shots": num(s.get("S")), "pim": num(s.get("PIM")),
    }


def compact(sport: str, eid: str, d: dict) -> dict | None:
    head = d.get("header", {})
    comp = (head.get("competitions") or [{}])[0]
    if not comp.get("status", {}).get("type", {}).get("completed"):
        return None
    stype = head.get("season", {}).get("type")
    teams = {c["homeAway"]: c for c in comp.get("competitors", [])}
    if "home" not in teams or "away" not in teams:
        return None
    pc = next((p for p in d.get("pickcenter", []) if p.get("spread") is not None), None) or (
        (d.get("pickcenter") or [None])[0]
    )
    game = {
        "id": eid,
        "date": comp.get("date"),
        "stype": stype,
        "home": {"id": teams["home"]["team"]["id"], "abbr": teams["home"]["team"].get("abbreviation")},
        "away": {"id": teams["away"]["team"]["id"], "abbr": teams["away"]["team"].get("abbreviation")},
        "hs": num(teams["home"].get("score")),
        "as": num(teams["away"].get("score")),
        "spread": pc.get("spread") if pc else None,  # home spread, negative = home favoured
        "total": pc.get("overUnder") if pc else None,
        "home_ml": (pc or {}).get("homeTeamOdds", {}).get("moneyLine"),
        "away_ml": (pc or {}).get("awayTeamOdds", {}).get("moneyLine"),
        "players": [],
    }
    for t in d.get("boxscore", {}).get("players", []):
        tid = t["team"]["id"]
        for g in t.get("statistics", []):
            labels = g.get("labels") or g.get("names") or []
            group = g.get("name") or ""
            for a in g.get("athletes", []):
                ath = a.get("athlete", {})
                stats = a.get("stats") or []
                row = {
                    "pid": ath.get("id"),
                    "name": ath.get("displayName"),
                    "team": tid,
                    "pos": (ath.get("position") or {}).get("abbreviation"),
                    "starter": bool(a.get("starter")),
                    "dnp": bool(a.get("didNotPlay")) or not stats,
                }
                if sport == "nhl":
                    row["grp"] = group  # forwards / defenses / goalies
                if a.get("reason"):
                    row["reason"] = a["reason"]
                if stats:
                    row.update(nba_line(labels, stats) if sport == "nba" else nhl_line(labels, stats))
                game["players"].append(row)
    return game


def main() -> None:
    sport, season = sys.argv[1], int(sys.argv[2])
    start, end = WINDOW[(sport, season)]
    end = end or (date.today() - timedelta(days=1)).isoformat()
    os.makedirs(DATA, exist_ok=True)
    out = os.path.join(DATA, f"{sport}_{season}.jsonl")
    have = set()
    if os.path.exists(out):
        with open(out) as f:
            have = {json.loads(l)["id"] for l in f if l.strip()}

    days = []
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    while d0 <= d1:
        days.append(d0.strftime("%Y%m%d"))
        d0 += timedelta(days=1)

    def board(day: str) -> list[str]:
        sb = get(f"{SITE}/{PATH[sport]}/scoreboard?dates={day}&limit=100") or {}
        return [
            e["id"]
            for e in sb.get("events", [])
            if e.get("season", {}).get("type") in (2, 3)
            and e.get("status", {}).get("type", {}).get("completed")
        ]

    with ThreadPoolExecutor(8) as ex:
        ids = [i for day in ex.map(board, days) for i in day]
    ids = [i for i in dict.fromkeys(ids) if i not in have]
    print(f"{sport} {season}: {len(have)} cached, {len(ids)} to fetch", flush=True)

    def one(eid: str) -> dict | None:
        d = get(f"{SITE}/{PATH[sport]}/summary?event={eid}")
        return compact(sport, eid, d) if d else None

    done = 0
    with open(out, "a") as f, ThreadPoolExecutor(8) as ex:
        for g in ex.map(one, ids):
            if g:
                f.write(json.dumps(g, separators=(",", ":")) + "\n")
                done += 1
                if done % 200 == 0:
                    print(f"  {done}/{len(ids)}", flush=True)
    print(f"{sport} {season}: wrote {done}", flush=True)


if __name__ == "__main__":
    main()
