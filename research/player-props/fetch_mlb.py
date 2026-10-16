"""
fetch_mlb.py — every MLB game of a season, as compact player lines.

For the MLB player-props backtest (scripts/props-backtest-mlb.ts): one JSON
line per final game, regular season and postseason, from MLB's free Stats API
(statsapi.mlb.com) — the schedule, then one box score per game. Each line has
the final score, the park, each team's totals, and every player on the day's
active roster: the ones who played with their full batting and pitching lines,
the ones who sat (the box score's bench and bullpen) with just who they are.

    python3 research/player-props/fetch_mlb.py 2025
    python3 research/player-props/fetch_mlb.py 2026 --out /some/dir

Writes {out}/mlb_{season}.jsonl (default research/player-props/data,
gitignored) and keeps {out}/mlb_people.json — every player's bats / throws /
primary position, which box scores do not carry. Safe to re-run: games
already in the file are kept and not fetched again.

Ids are MLB's (game pk, team, person). Team abbreviations are written the way
ESPN spells them (ARI, CHW), because the simulator's park table is keyed by
ESPN's. A player line, keys left out when the player did not bat / pitch:

    pid name team pos (game position) ppos (primary) bats throws
    role   "lineup" (started at the plate), "sub" (came off the bench),
           "sp" / "rp" (pitched: started / in relief), "bench" / "pen" (sat)
    bo     batting-order code: 100..900 started in that slot, 401 = first
           substitute in the 4th slot; absent for anyone who did not bat
    batting   pa ab r h d2 d3 hr rbi bb ibb hbp so sb cs sf sh gidp tb
    pitching  p_ord (1 = started) p_gs p_bf p_outs p_h p_r p_er p_bb p_ibb
              p_hbp p_so p_hr p_np p_w p_l p_sv p_hld p_bs

How these become ESPN's season-stat keys (what the live builder reads) is in
scripts/props-backtest-mlb.ts, Totals.fold.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
API = "https://statsapi.mlb.com/api/v1"

# MLB's abbreviation -> ESPN's, where they differ.
ESPN_ABBR = {"AZ": "ARI", "CWS": "CHW"}
# Regular season, then the postseason: wild card, division series, LCS, World Series.
POST = "F,D,L,W"


def get(url: str, tries: int = 5) -> dict | None:
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception:  # noqa: BLE001 — network: retry, then give up on this one
            time.sleep(1.5 * (i + 1))
    return None


def schedule(season: int, yesterday: str) -> list[dict]:
    """Every final game of the season, one entry per game pk. A suspended game
    is listed on the day it started and again on the day it was finished;
    `start` is the first, `day` the last. A postponed game is listed on its
    original date as postponed and never counts as started there."""
    spans = [
        ("R", f"{season}-03-01", f"{season}-10-10", 2),
        (POST, f"{season}-09-20", f"{season}-11-20", 3),
    ]
    games: dict[int, dict] = {}
    for gtype, a, b, stype in spans:
        b = min(b, yesterday)
        if a > b:
            continue
        j = get(f"{API}/schedule?sportId=1&gameType={gtype}&startDate={a}&endDate={b}") or {}
        for d in j.get("dates", []):
            for g in d.get("games", []):
                if g.get("status", {}).get("codedGameState") != "F":
                    continue
                pk = g["gamePk"]
                cur = games.get(pk)
                day = g["officialDate"]
                if cur is None:
                    games[pk] = {
                        "pk": pk,
                        "start": day,
                        "day": day,
                        "date": g["gameDate"],
                        "gtype": g["gameType"],
                        "stype": stype,
                        "dh": g.get("doubleHeader", "N"),
                        "gn": g.get("gameNumber", 1),
                        "venue": {"id": (g.get("venue") or {}).get("id"), "name": (g.get("venue") or {}).get("name")},
                    }
                else:
                    cur["start"] = min(cur["start"], day)
                    if day >= cur["day"]:
                        cur["day"] = day
                        cur["date"] = g["gameDate"]
    return sorted(games.values(), key=lambda g: (g["date"], g["pk"]))


def ip_outs(ip: str | None) -> int:
    """'6.2' innings -> 20 outs."""
    if not ip:
        return 0
    whole, _, frac = str(ip).partition(".")
    return int(whole or 0) * 3 + int(frac or 0)


BAT = [
    ("pa", "plateAppearances"), ("ab", "atBats"), ("r", "runs"), ("h", "hits"),
    ("d2", "doubles"), ("d3", "triples"), ("hr", "homeRuns"), ("rbi", "rbi"),
    ("bb", "baseOnBalls"), ("ibb", "intentionalWalks"), ("hbp", "hitByPitch"),
    ("so", "strikeOuts"), ("sb", "stolenBases"), ("cs", "caughtStealing"),
    ("sf", "sacFlies"), ("sh", "sacBunts"), ("gidp", "groundIntoDoublePlay"),
    ("tb", "totalBases"),
]
PIT = [
    ("p_gs", "gamesStarted"), ("p_bf", "battersFaced"), ("p_outs", "outs"),
    ("p_h", "hits"), ("p_r", "runs"), ("p_er", "earnedRuns"), ("p_bb", "baseOnBalls"),
    ("p_ibb", "intentionalWalks"), ("p_hbp", "hitByPitch"), ("p_so", "strikeOuts"),
    ("p_hr", "homeRuns"), ("p_np", "numberOfPitches"), ("p_w", "wins"),
    ("p_l", "losses"), ("p_sv", "saves"), ("p_hld", "holds"), ("p_bs", "blownSaves"),
]


def n(x) -> int:
    try:
        return int(x)
    except (TypeError, ValueError):
        return 0


def team_line(ts: dict) -> dict:
    """A team's box-score totals: batting, pitching (outs, not innings) and errors."""
    b, p, f = ts.get("batting", {}), ts.get("pitching", {}), ts.get("fielding", {})
    return {
        "ab": n(b.get("atBats")), "r": n(b.get("runs")), "h": n(b.get("hits")),
        "d2": n(b.get("doubles")), "d3": n(b.get("triples")), "hr": n(b.get("homeRuns")),
        "rbi": n(b.get("rbi")), "tb": n(b.get("totalBases")), "bb": n(b.get("baseOnBalls")),
        "so": n(b.get("strikeOuts")), "sb": n(b.get("stolenBases")),
        "p_outs": ip_outs(p.get("inningsPitched")), "p_h": n(p.get("hits")),
        "p_r": n(p.get("runs")), "p_er": n(p.get("earnedRuns")), "p_hr": n(p.get("homeRuns")),
        "p_bb": n(p.get("baseOnBalls")), "p_so": n(p.get("strikeOuts")),
        "e": n(f.get("errors")),
    }


def compact(meta: dict, box: dict) -> dict | None:
    sides = box.get("teams") or {}
    if "home" not in sides or "away" not in sides:
        return None
    game = {
        "id": str(meta["pk"]),
        "date": meta["date"],
        "day": meta["day"],
        "start": meta["start"],
        "stype": meta["stype"],
        "gtype": meta["gtype"],
        "dh": meta["dh"],
        "gn": meta["gn"],
        "venue": meta["venue"],
        "teams": {},
        "players": [],
    }
    for side in ("home", "away"):
        t = sides[side]
        tid = str(t["team"]["id"])
        abbr = t["team"].get("abbreviation", tid)
        game[side] = {"id": tid, "abbr": ESPN_ABBR.get(abbr, abbr)}
        game["teams"][tid] = team_line(t.get("teamStats", {}))
        pitched = [str(x) for x in t.get("pitchers", [])]
        order = {pid: i + 1 for i, pid in enumerate(pitched)}
        for key, p in (t.get("players") or {}).items():
            pid = str(p["person"]["id"])
            st = p.get("stats") or {}
            bat, pit = st.get("batting") or {}, st.get("pitching") or {}
            bo = n(p.get("battingOrder")) or None
            row = {
                "pid": pid,
                "name": p["person"].get("fullName"),
                "team": tid,
                "pos": (p.get("position") or {}).get("abbreviation"),
            }
            if bo:
                row["bo"] = bo
            if pit:
                row["role"] = "sp" if n(pit.get("gamesStarted")) or order.get(pid) == 1 else "rp"
            elif bo and bo % 100 == 0:
                row["role"] = "lineup"
            elif bat:
                row["role"] = "sub"
            else:
                row["role"] = "pen" if row["pos"] == "P" else "bench"
            # A pitcher who also batted is "sp"/"rp"; his batting order says
            # whether he started at the plate.
            if bat:
                for k, src in BAT:
                    row[k] = n(bat.get(src))
            if pit:
                row["p_ord"] = order.get(pid, 0)
                for k, src in PIT:
                    row[k] = n(pit.get(src))
            game["players"].append(row)
    hs = game["teams"][game["home"]["id"]]["r"]
    as_ = game["teams"][game["away"]["id"]]["r"]
    game["hs"], game["as"] = hs, as_
    return game


def people(ids: set[str], path: str) -> dict[str, list]:
    """bats / throws / primary position by MLB person id, cached across seasons."""
    have: dict[str, list] = {}
    if os.path.exists(path):
        with open(path) as f:
            have = json.load(f)
    need = sorted(i for i in ids if i not in have)
    chunks = [need[i : i + 150] for i in range(0, len(need), 150)]

    def one(chunk: list[str]) -> list[dict]:
        j = get(f"{API}/people?personIds={','.join(chunk)}") or {}
        return j.get("people", [])

    with ThreadPoolExecutor(6) as ex:
        for found in ex.map(one, chunks):
            for p in found:
                have[str(p["id"])] = [
                    (p.get("batSide") or {}).get("code", ""),
                    (p.get("pitchHand") or {}).get("code", ""),
                    (p.get("primaryPosition") or {}).get("abbreviation", ""),
                ]
    with open(path, "w") as f:
        json.dump(have, f, separators=(",", ":"))
    return have


def neutral_flags(games: list[dict]) -> None:
    """A neutral site (Tokyo, Seoul, London, Mexico City, Rickwood,
    Williamsport, Bristol, a one-off relocation) is a park where the home club
    played fewer than three regular-season home games that season. ESPN, which
    the live site reads, flags exactly these games neutralSite (checked against
    its scoreboard for 2023-26); a club's home for a season or for a series
    (the A's in Sacramento and Las Vegas, the Rays in Tampa) is its home."""
    by: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for g in games:
        if g["stype"] == 2:
            by[g["home"]["id"]][g["venue"]["id"]] += 1
    for g in games:
        g["neutral"] = by[g["home"]["id"]][g["venue"]["id"]] < 3


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("season", type=int)
    ap.add_argument("--out", default=DATA)
    ap.add_argument("--threads", type=int, default=12)
    a = ap.parse_args()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    os.makedirs(a.out, exist_ok=True)
    out = os.path.join(a.out, f"mlb_{a.season}.jsonl")

    have: dict[str, dict] = {}
    if os.path.exists(out):
        with open(out) as f:
            for line in f:
                if line.strip():
                    g = json.loads(line)
                    have[g["id"]] = g

    sched = schedule(a.season, yesterday)
    todo = [m for m in sched if str(m["pk"]) not in have]
    print(f"mlb {a.season}: {len(sched)} final games, {len(have)} cached, {len(todo)} to fetch", flush=True)

    def one(m: dict) -> dict | None:
        box = get(f"{API}/game/{m['pk']}/boxscore")
        return compact(m, box) if box else None

    done = 0
    with ThreadPoolExecutor(a.threads) as ex:
        for g in ex.map(one, todo):
            if g:
                have[g["id"]] = g
                done += 1
                if done % 250 == 0:
                    print(f"  {done}/{len(todo)}", flush=True)
    missing = len(todo) - done

    games = sorted(have.values(), key=lambda g: (g["date"], int(g["id"])))
    ppl = people({p["pid"] for g in games for p in g["players"]}, os.path.join(a.out, "mlb_people.json"))
    for g in games:
        for p in g["players"]:
            bats, throws, ppos = ppl.get(p["pid"], ["", "", ""])
            p["bats"], p["throws"], p["ppos"] = bats, throws, ppos
    neutral_flags(games)

    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        for g in games:
            f.write(json.dumps(g, separators=(",", ":")) + "\n")
    os.replace(tmp, out)
    print(f"mlb {a.season}: wrote {len(games)} games ({done} new, {missing} failed)", flush=True)


if __name__ == "__main__":
    main()
