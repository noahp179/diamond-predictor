"""
season_to_date.py — this season so far, as the boards would have called it.

    python3 research/player-props/season_to_date.py

The simulation boards only start writing picks down from 15 October 2026. For
the games of this season already played — the NFL's and college's 2026
weeks, the NHL's 2026-27 opening fortnight — this replays what each board would have said the
morning of each game and grades it:

  - the simulator's numbers come from scripts/props-backtest*.ts: each game
    played 1,000 times from what was known that morning (box scores of the
    games before it, last season, the injury report as the box score has it);
  - each market's number is the board's: raw or calibrated as the board shows
    it, through a calibration map fitted ONLY on earlier seasons (NHL: the
    live maps, fitted on 2024-25 and 2025-26; NFL and college: refitted here
    on 2025 alone, because their live maps also saw 2026);
  - the picks are the ledger's: each game's three likeliest players in every
    market (two goalies for saves), and a player who did not play is a void.

It is a replay, not a record — nothing here was written down before a game —
and the Analytics pages say so. Writes src/lib/sim-props-season.json.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from collections import defaultdict
from datetime import date

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asof  # noqa: E402
import evaluate_nfl_props as EN  # noqa: E402
import marketlib as L  # noqa: E402
from evaluate import eligible, load_sim  # noqa: E402
from evaluate_markets import y_of  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
SRC = os.path.join(HERE, "..", "..", "src", "lib")
FT = os.path.join(HERE, "..", "football-td", "data")
PICKS = 3


def curve_fn(c: dict | None):
    """The site's calibrate(): linear between knots, flat beyond the ends."""
    if not c:
        return lambda p: p
    x, y = np.array(c["x"]), np.array(c["y"])
    return lambda p: float(np.interp(p, x, y))


def band_rows(ps: list[float], ys: list[float]) -> list[dict]:
    if not ps:
        return []
    return L.bands(np.array(ys, dtype=float), np.array(ps, dtype=float))


def summarise(cands: dict[str, list[tuple[float, float | None]]]) -> dict:
    """cands: game -> [(prob, outcome or None for a void)]. The top three a
    game are the picks; every candidate who played is the board."""
    pp, py, voids = [], [], 0
    ap, ay = [], []
    for rows in cands.values():
        for p, y in rows:
            if y is not None:
                ap.append(p)
                ay.append(y)
        for p, y in sorted(rows, key=lambda r: -r[0])[:PICKS]:
            if y is None:
                voids += 1
            else:
                pp.append(p)
                py.append(y)
    return {
        "picks": {"n": len(py), "hits": int(sum(py)), "said": float(sum(pp)), "voids": voids},
        "pick_bands": band_rows(pp, py),
        "all": {"n": len(ay), "hits": int(sum(ay)), "said": float(sum(ap))},
        "all_bands": band_rows(ap, ay),
    }


def markets_for(league: str) -> list[dict]:
    return json.load(open(os.path.join(DATA, "markets.json")))[league]


def nhl(bt: dict, cal: dict) -> dict:
    games = asof.load("nhl", [2026])
    sims = load_sim("nhl", 2026)
    firsts = json.load(open(os.path.join(DATA, "nhl_first_2026.json")))
    out = {"season": "2026-27", "markets": {}}
    played = [g for g in games if g["id"] in sims]
    out["games"] = len(played)
    out["from"], out["to"] = (min(g["date"] for g in played)[:10], max(g["date"] for g in played)[:10]) if played else (None, None)
    for m in markets_for("nhl"):
        key, stat, idx, line = m["key"], m["stat"], m["idx"], m["line"]
        chosen = (bt.get(key) or {}).get("chosen", "sim")
        f = curve_fn(cal.get(key) if chosen == "sim_cal" else None)
        cands: dict[str, list] = defaultdict(list)
        for g in played:
            sim = sims[g["id"]]["players"]
            for p in g["players"]:
                pid = p.get("pid")
                sp = sim.get(pid) if pid else None
                if not sp:
                    continue
                if stat == "first":
                    if p.get("grp") == "goalies" or not eligible("nhl", p):
                        continue
                    ln = asof.outcome("nhl", p)
                    cands[g["id"]].append((sp.get("first", 0.0), None if ln is None else float(firsts.get(g["id"]) == pid)))
                    continue
                v = sp.get(stat)
                if not v:
                    continue
                if stat == "sv":
                    if p.get("grp") != "goalies":
                        continue
                    y = float(p.get("sv", 0.0)) >= line if p.get("toi", 0) > 0 else None
                else:
                    if p.get("grp") == "goalies" or not eligible("nhl", p):
                        continue
                    ln = asof.outcome("nhl", p)
                    y = None if ln is None else y_of("nhl", stat, ln) >= line
                cands[g["id"]].append((f(v["over"][idx]), None if y is None else float(y)))
        out["markets"][key] = {"label": m["label"], "slug": m["slug"], **summarise(cands)}
    return out


def football(league: str, bt: dict) -> dict:
    """NFL and college: the same boards, at the same lines. College prices
    only the players the simulator gave some chance, as its board does
    (its maps are fitted on those players — export_calibration.py)."""
    sims = EN.load_sims(league)
    games = {g["id"]: g for g in EN.load_games(league)}
    priced_only = league == "cfb"
    first = {}
    with open(os.path.join(FT, f"{league}_first_td.csv")) as fh:
        for r in csv.DictReader(fh):
            first[str(r["event_id"])] = str(r.get("first_td_player_id") or "")
    played = [gid for gid, s in sims.items() if gid in games and games[gid]["season"] == 2026]
    train = [gid for gid, s in sims.items() if gid in games and games[gid]["season"] == 2025]
    out = {"season": "2026", "games": len(played), "markets": {}}
    ds = sorted(games[g]["date"] for g in played)
    out["from"], out["to"] = (ds[0][:10], ds[-1][:10]) if ds else (None, None)

    def value(sp: dict, stat: str, idx: int):
        if stat == "td":
            return sp.get("td")
        v = (sp.get("props") or {}).get(stat)
        return v["over"][idx] if v else None

    def outcome(ln: dict | None, stat: str, line: float):
        if ln is None:
            return None
        return float(ln[stat] >= line)

    # college plays the NFL's boards (markets.json is dumped from the NFL's)
    for m in markets_for("nfl"):
        key, stat, idx, line = m["key"], m["stat"], m["idx"], m["line"]
        chosen = (bt.get(key) or {}).get("chosen", "sim")
        if stat == "first" and chosen == "sim_cal":
            # college: the first-scorer map from 2025 alone
            xs, ys = [], []
            for gid in train:
                for pid, sp in sims[gid]["players"].items():
                    if sp.get("first", 0) > 0 and pid in games[gid]["lines"]:
                        xs.append(sp["first"])
                        ys.append(float(first.get(gid) == pid))
            iso = L.iso().fit(np.array(xs), np.array(ys))
            f = lambda p, iso=iso: float(iso.predict([p])[0])  # noqa: E731
        elif stat == "first":
            f = lambda p: p  # noqa: E731
        elif chosen == "sim_cal":
            # the map from 2025 alone
            xs, ys = [], []
            for gid in train:
                for pid, sp in sims[gid]["players"].items():
                    v = value(sp, stat, idx)
                    ln = games[gid]["lines"].get(pid)
                    if v is None or ln is None or (priced_only and v <= 0):
                        continue
                    xs.append(v)
                    ys.append(float(ln[stat] >= line))
            iso = L.iso().fit(np.array(xs), np.array(ys))
            f = lambda p, iso=iso: float(iso.predict([p])[0])  # noqa: E731
        else:
            f = lambda p: p  # noqa: E731
        cands: dict[str, list] = defaultdict(list)
        for gid in played:
            g = games[gid]
            for pid, sp in sims[gid]["players"].items():
                ln = g["lines"].get(pid)
                if stat == "first":
                    if not sp.get("first"):
                        continue
                    y = None if ln is None else float(first.get(gid) == pid)
                    cands[gid].append((f(sp["first"]), y))
                    continue
                v = value(sp, stat, idx)
                if v is None or (stat == "td" and not sp.get("played")):
                    continue
                if priced_only and v <= 0:
                    continue
                cands[gid].append((f(v), outcome(ln, stat, line)))
        out["markets"][key] = {"label": m["label"], "slug": m["slug"], **summarise(cands)}
    return out


def main() -> None:
    bt = json.load(open(os.path.join(SRC, "sim-props-backtest.json")))
    cal = json.load(open(os.path.join(SRC, "sim-props-calibration.json")))["curves"]
    res = {
        "generated": date.today().isoformat(),
        "nhl": nhl(bt["nhl"], cal.get("nhl", {})),
        "nfl": football("nfl", bt["nfl"]),
        "cfb": football("cfb", bt["cfb"]),
        "nba": {"season": "2026-27", "games": 0, "markets": {},
                "note": "The NBA regular season starts on 20 October; there is nothing of this season to replay yet."},
    }

    def rnd(x):
        if isinstance(x, float):
            return round(x, 4)
        if isinstance(x, dict):
            return {k: rnd(v) for k, v in x.items()}
        if isinstance(x, list):
            return [rnd(v) for v in x]
        return x

    with open(os.path.join(SRC, "sim-props-season.json"), "w") as fh:
        json.dump(rnd(res), fh, separators=(",", ":"))
    for lg in ("nhl", "nfl", "cfb"):
        r = res[lg]
        print(f"{lg} {r['season']}: {r['games']} games {r['from']} -> {r['to']}")
        tot = {"n": 0, "hits": 0, "said": 0.0}
        for k, m in r["markets"].items():
            p = m["picks"]
            for a in tot:
                tot[a] += p[a]
            if p["n"]:
                print(f"   {m['label']:>34}: picks {p['n']:>4}  came in {p['hits'] / p['n']:.1%}  said {p['said'] / p['n']:.1%}  voids {p['voids']}")
        print(f"   {'ALL':>34}: picks {tot['n']:>4}  came in {tot['hits'] / max(1, tot['n']):.1%}  said {tot['said'] / max(1, tot['n']):.1%}")


if __name__ == "__main__":
    main()
