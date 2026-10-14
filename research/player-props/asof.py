"""
asof.py — what was known about every player the morning of every game.

Every method in this research (the simulator, the closed-form baselines, the
fitted model) is fed from here, so they all see exactly the same information
and none of them sees the game it is predicting. Games are walked in kickoff
order; a player's numbers are read BEFORE his line from that game is folded
in.

For each player the walk keeps, across seasons:
  - season-to-date totals of every box-score stat (this season and last),
  - exponentially weighted per-game means (half-life HALF games, carried
    across the season boundary),
  - his last few games, rest days, starts and games played,
and for each team: points/goals scored and allowed, and games played.

`walk(sport, seasons)` yields (game, snapshot) pairs, where snapshot maps
player id -> a dict of as-of features, for every player listed in that game's
box score (including those who did not play, so the caller can decide how to
treat a scratch).
"""

from __future__ import annotations

import json
import math
import os
from collections import defaultdict, deque
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

HALF = 10.0  # games; the EWMA half-life
DECAY = 0.5 ** (1 / HALF)

STATS = {
    "nba": ["min", "pts", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "reb", "ast", "tov", "stl", "blk", "pf"],
    "nhl": ["toi", "pptoi", "g", "a", "sog", "shots", "pim"],
}
KEY = {"nba": "pts", "nhl": "pts"}  # NHL points are derived: g + a


def load(sport: str, seasons: list[int]) -> list[dict]:
    games = []
    for s in seasons:
        path = os.path.join(DATA, f"{sport}_{s}.jsonl")
        with open(path) as f:
            for line in f:
                g = json.loads(line)
                g["season"] = s
                games.append(g)
    games.sort(key=lambda g: (g["date"], g["id"]))
    return games


def played(sport: str, p: dict) -> bool:
    if p.get("dnp"):
        return False
    if sport == "nba":
        return p.get("min", 0) > 0
    return p.get("toi", 0) > 0 and p.get("grp") != "goalies"


def line_of(sport: str, p: dict) -> dict:
    out = {k: float(p.get(k, 0.0)) for k in STATS[sport]}
    if sport == "nhl":
        out["toi"] /= 60.0  # minutes
        out["pptoi"] /= 60.0
        out["pts"] = out["g"] + out["a"]
    return out


def implied(g: dict) -> tuple[float | None, float | None]:
    """Home and away implied team scores from the posted spread and total."""
    sp, tot = g.get("spread"), g.get("total")
    if sp is None or tot is None:
        return None, None
    try:
        sp, tot = float(sp), float(tot)
    except (TypeError, ValueError):
        return None, None
    return (tot - sp) / 2.0, (tot + sp) / 2.0


class Player:
    __slots__ = ("cur", "prev", "season", "ew", "ew_w", "last", "starts", "gp", "last_date", "team", "pos", "listed")

    def __init__(self) -> None:
        self.cur: dict = defaultdict(float)  # this season's totals
        self.prev: dict = defaultdict(float)  # last season's totals
        self.season = None
        self.ew: dict = defaultdict(float)
        self.ew_w = 0.0
        self.last: deque = deque(maxlen=10)
        self.starts = 0
        self.gp = 0
        self.last_date = None
        self.team = None
        self.pos = None
        self.listed = 0  # games listed on a box score this season (played or not)


class Team:
    __slots__ = ("gp", "pf", "pa", "season", "ew_pf", "ew_pa", "ew_w")

    def __init__(self) -> None:
        self.gp = 0
        self.pf = 0.0
        self.pa = 0.0
        self.season = None
        self.ew_pf = 0.0
        self.ew_pa = 0.0
        self.ew_w = 0.0


def walk(sport: str, seasons: list[int]):
    players: dict[str, Player] = defaultdict(Player)
    teams: dict[str, Team] = defaultdict(Team)
    league = {"pf": 0.0, "gp": 0, "season": None}
    for g in load(sport, seasons):
        season = g["season"]
        if league["season"] != season:
            league = {"pf": 0.0, "gp": 0, "season": season}
        when = datetime.fromisoformat(g["date"].replace("Z", "+00:00"))
        h_imp, a_imp = implied(g)
        snap = {}
        tsnap = {}
        for side in ("home", "away"):
            tid = g[side]["id"]
            t = teams[tid]
            if t.season != season:
                t.season, t.gp, t.pf, t.pa = season, 0, 0.0, 0.0
            tsnap[tid] = {
                "gp": t.gp,
                "pf": t.pf / t.gp if t.gp else None,
                "pa": t.pa / t.gp if t.gp else None,
                "ew_pf": t.ew_pf / t.ew_w if t.ew_w else None,
                "ew_pa": t.ew_pa / t.ew_w if t.ew_w else None,
            }
        lg_avg = league["pf"] / league["gp"] if league["gp"] else None
        for p in g["players"]:
            pid = p["pid"]
            if not pid:
                continue
            pl = players[pid]
            if pl.season != season:
                if pl.season is not None:
                    pl.prev = pl.cur if pl.cur.get("gp", 0) else pl.prev
                pl.cur = defaultdict(float)
                pl.season = season
                pl.starts = 0
                pl.gp = 0
                pl.listed = 0
            home = p["team"] == g["home"]["id"]
            opp = g["away"]["id"] if home else g["home"]["id"]
            gp, pgp = pl.cur.get("gp", 0.0), pl.prev.get("gp", 0.0)
            feat = {
                "pid": pid,
                "name": p.get("name"),
                "team": p["team"],
                "opp": opp,
                "home": home,
                "pos": p.get("pos"),
                "grp": p.get("grp"),
                "gp": gp,
                "prev_gp": pgp,
                "starts": pl.starts,
                "listed": pl.listed,
                "rest": (when - pl.last_date).total_seconds() / 86400 if pl.last_date else None,
                "same_team": pl.team == p["team"] if pl.team else None,
                "team_implied": h_imp if home else a_imp,
                "opp_implied": a_imp if home else h_imp,
                "team_gp": tsnap[p["team"]]["gp"],
                "team_pf": tsnap[p["team"]]["pf"],
                "opp_pa": tsnap[opp]["pa"],
                "opp_ew_pa": tsnap[opp]["ew_pa"],
                "team_ew_pf": tsnap[p["team"]]["ew_pf"],
                "lg_avg": lg_avg,
            }
            stats = STATS[sport] + (["pts"] if sport == "nhl" else [])
            for k in stats:
                feat[f"cur_{k}"] = pl.cur.get(k, 0.0) / gp if gp else None
                feat[f"prev_{k}"] = pl.prev.get(k, 0.0) / pgp if pgp else None
                feat[f"ew_{k}"] = pl.ew.get(k, 0.0) / pl.ew_w if pl.ew_w else None
            key = KEY[sport]
            last = [x[key] for x in pl.last]
            feat["last5"] = sum(last[-5:]) / len(last[-5:]) if last else None
            feat["last_min"] = pl.last[-1]["min" if sport == "nba" else "toi"] if pl.last else None
            vals = [x[key] for x in pl.last]
            feat["sd_last10"] = (
                math.sqrt(sum((v - sum(vals) / len(vals)) ** 2 for v in vals) / (len(vals) - 1))
                if len(vals) >= 3
                else None
            )
            snap[pid] = feat

        yield g, snap

        # Fold the game in, AFTER the snapshot was handed out.
        for side, other in (("home", "away"), ("away", "home")):
            t = teams[g[side]["id"]]
            pf = g["hs"] if side == "home" else g["as"]
            pa = g["as"] if side == "home" else g["hs"]
            t.gp += 1
            t.pf += pf
            t.pa += pa
            t.ew_pf = t.ew_pf * DECAY + pf
            t.ew_pa = t.ew_pa * DECAY + pa
            t.ew_w = t.ew_w * DECAY + 1
            league["pf"] += pf
            league["gp"] += 1
        for p in g["players"]:
            pid = p["pid"]
            if not pid:
                continue
            pl = players[pid]
            pl.listed += 1
            pl.team = p["team"]
            pl.pos = p.get("pos")
            if not played(sport, p):
                continue
            ln = line_of(sport, p)
            pl.cur["gp"] += 1
            for k, v in ln.items():
                pl.cur[k] += v
                pl.ew[k] = pl.ew[k] * DECAY + v
            pl.ew_w = pl.ew_w * DECAY + 1
            pl.last.append(ln)
            pl.gp += 1
            pl.starts += 1 if p.get("starter") else 0
            pl.last_date = when


def outcome(sport: str, p: dict) -> dict | None:
    """The player's actual line, or None if he did not play."""
    if not played(sport, p):
        return None
    return line_of(sport, p)
