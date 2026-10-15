"""
evaluate_markets.py — every NBA and NHL market on the boards: the simulator
against a season average and a fitted model, on the held-out season.

    python3 research/player-props/evaluate_markets.py nba
    python3 research/player-props/evaluate_markets.py nhl

The same discipline as evaluate.py (which settled the points boards): train
on 2024-25, test on 2025-26, every method fed from asof.py so none sees the
game it predicts, every method scored on the same player-games — every player
listed for the game except those the injury report had out (a coach's
decision counts, as a miss: it could not be known in the morning). Goalie
saves are scored on the goalie who started, the one the simulator was told
would.

Methods
-------
  sim      the simulator's share of plays that reached the line (1,000 plays
           a game, scripts/props-backtest.ts).
  sim_cal  the same through an isotonic map learned on the 2024-25
           simulations: what the boards show.
  avg      the season average (last season carried in for the first ten
           games) through a negative binomial whose spread is fitted on
           2024-25; for combined stats the components' averages add.
  fit      gradient-boosted trees on every as-of average, minutes, rest,
           home and the two teams' scoring, isotonic-calibrated.
  blend    half sim_cal, half fit.

The market list is the boards' own (data/markets.json, from dump_markets.ts).
Writes results/{sport}_markets_backtest.json and data/cal_{sport}_markets.json
(the live calibration knots, fitted on both seasons).
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asof  # noqa: E402
import marketlib as L  # noqa: E402
from evaluate import eligible, fit_trees, load_sim  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "results")
TEST, TRAIN = 2025, 2024

# a market's stat as a sum of box-score columns (asof names)
PARTS = {
    "nba": {
        "pts": ["pts"], "reb": ["reb"], "ast": ["ast"], "3pm": ["tpm"], "stl": ["stl"], "blk": ["blk"],
        "pra": ["pts", "reb", "ast"], "pr": ["pts", "reb"], "pa": ["pts", "ast"], "ra": ["reb", "ast"],
        "stk": ["stl", "blk"],
    },
    "nhl": {"pts": ["pts"], "g": ["g"], "a": ["a"], "sog": ["shots"]},
}
CONTEXT = ["gp", "prev_gp", "start_rate", "rest", "home", "last_min",
           "opp_pa", "opp_ew_pa", "team_pf", "team_ew_pf", "lg_avg"]


def y_of(sport: str, stat: str, line: dict) -> float:
    if stat == "dd":
        return float(sum(line.get(k, 0.0) >= 10 for k in ("pts", "reb", "ast", "stl", "blk")))
    return float(sum(line.get(k, 0.0) for k in PARTS[sport][stat]))


def mu_of(sport: str, stat: str, r: dict) -> float:
    """Season average, last season carried in for the first ten games."""
    if stat == "dd":
        return 0.0
    tot = 0.0
    for k in PARTS[sport][stat]:
        gp, pgp = r.get("gp") or 0, r.get("prev_gp") or 0
        cur, prev = r.get(f"cur_{k}"), r.get(f"prev_{k}")
        w = min(pgp, 10.0) if prev is not None else 0.0
        den = gp + w
        tot += ((cur or 0) * gp + (prev or 0) * w) / den if den > 0 else 0.0
    return tot


def skater_rows(sport: str) -> tuple[list[dict], list[str]]:
    seasons = [s for s in (2023, 2024, 2025) if os.path.exists(os.path.join(DATA, f"{sport}_{s}.jsonl"))]
    sims = {s: load_sim(sport, s) for s in (TRAIN, TEST)}
    feats = [f"{w}_{k}" for k in asof.STATS[sport] + (["pts"] if sport == "nhl" else []) for w in ("cur", "prev", "ew")]
    feats += CONTEXT + (["is_d"] if sport == "nhl" else [])
    rows = []
    for g, snap in asof.walk(sport, seasons):
        if g["season"] not in (TRAIN, TEST):
            continue
        sim = sims[g["season"]].get(g["id"])
        if sim is None:
            continue
        for p in g["players"]:
            pid = p.get("pid")
            if not pid or not eligible(sport, p) or pid not in snap:
                continue
            f = dict(snap[pid])
            f["start_rate"] = f["starts"] / f["gp"] if f.get("gp") else None
            f["is_d"] = 1.0 if p.get("grp") == "defenses" else 0.0
            f["home"] = 1.0 if f.get("home") else 0.0
            rows.append({
                "season": g["season"], "gid": g["id"], "date": g["date"][:10], "pid": pid,
                "line": asof.outcome(sport, p) or {},
                "sim": sim["players"].get(pid) or {},
                "f": f,
            })
    return rows, feats


def goalie_rows() -> list[dict]:
    """Starting goalies, with their season-to-date saves a game."""
    games = asof.load("nhl", [2023, 2024, 2025])
    sims = {s: load_sim("nhl", s) for s in (TRAIN, TEST)}
    tot: dict[str, dict] = defaultdict(lambda: {"season": None, "gp": 0, "sv": 0.0, "pgp": 0, "psv": 0.0})
    rows = []
    for g in games:
        starters = {}
        for p in g["players"]:
            if p.get("grp") == "goalies" and p.get("toi", 0) > 0:
                if p["team"] not in starters or p["toi"] > starters[p["team"]]["toi"]:
                    starters[p["team"]] = p
        sim = sims.get(g["season"], {}).get(g["id"])
        for p in starters.values():
            t = tot[p["pid"]]
            if t["season"] != g["season"]:
                t["pgp"], t["psv"] = (t["gp"], t["sv"]) if t["season"] == g["season"] - 1 else (0, 0.0)
                t["season"], t["gp"], t["sv"] = g["season"], 0, 0.0
            if sim is not None and g["season"] in (TRAIN, TEST):
                w = min(t["pgp"], 10)
                den = t["gp"] + w
                mu = (t["sv"] + (t["psv"] / t["pgp"] * w if t["pgp"] else 0.0)) / den if den else 0.0
                rows.append({
                    "season": g["season"], "gid": g["id"], "date": g["date"][:10], "pid": p["pid"],
                    "line": {"sv": float(p.get("sv", 0.0))}, "sim": sim["players"].get(p["pid"]) or {},
                    "mu": mu,
                })
            if g.get("stype") == 2:
                t["gp"] += 1
                t["sv"] += float(p.get("sv", 0.0))
    return rows


def simp(r: dict, stat: str, idx: int) -> float:
    v = r["sim"].get(stat)
    return v["over"][idx] if v else 0.0


def main() -> None:
    sport = sys.argv[1]
    markets = [m for m in json.load(open(os.path.join(DATA, "markets.json")))[sport] if m["idx"] is not None]
    rows, feats = skater_rows(sport)
    goalies = goalie_rows() if sport == "nhl" else []
    print(f"{sport}: {len(rows)} skater player-games, {len(goalies)} goalie starts; {len(markets)} markets")
    res = {"league": sport, "train": TRAIN, "test": TEST, "markets": {}}
    cal = {}
    X = np.array([[np.nan if r["f"].get(c) is None else float(r["f"][c]) for c in feats] for r in rows]) if rows else None
    season = np.array([r["season"] for r in rows])
    for m in markets:
        stat, idx, line = m["stat"], m["idx"], m["line"]
        R = goalies if stat == "sv" else rows
        if not R:
            continue
        seas = np.array([r["season"] for r in R])
        tr, te = seas == TRAIN, seas == TEST
        y = np.array([1.0 if y_of_any(sport, stat, r["line"]) >= line else 0.0 for r in R])
        yv = np.array([y_of_any(sport, stat, r["line"]) for r in R])
        s = np.array([simp(r, stat, idx) for r in R])
        gids = [r["gid"] for i, r in enumerate(R) if te[i]]
        P = {"sim": s[te], "sim_cal": L.iso().fit(s[tr], y[tr]).predict(s[te])}
        mu = np.array([r["mu"] if stat == "sv" else mu_of(sport, stat, r["f"]) for r in R])
        if stat != "dd":
            phi = L.fit_phi(mu[tr], yv[tr])
            P["avg"] = np.where(mu[te] > 0, L.nb_tail(mu[te], line, phi), 0.0)
        if stat != "sv":
            P["fit"], _, _ = fit_trees(X[season == TRAIN], y[tr], X[season == TEST])
            P["blend"] = 0.5 * P["sim_cal"] + 0.5 * P["fit"]
        out = {"label": m["label"], "key": m["key"], "slug": m["slug"], "line": line, "board": m["board"],
               "top_unit": "top1" if stat == "sv" else "top3",
               "methods": {k: L.metrics(y[te], p, gids) for k, p in P.items()}}
        out["chosen"] = L.choose(out["methods"])
        for other in ("fit", "avg", "blend"):
            if other in P:
                out[f"boot_simcal_vs_{other}"] = L.paired_boot(y[te], P["sim_cal"], P[other], gids)
        res["markets"][m["slug"]] = out
        if out["chosen"] == "sim_cal":
            knots = L.iso().fit(s, y)  # live map: both seasons
            cal[m["key"]] = {"x": knots.X_thresholds_.tolist(), "y": knots.y_thresholds_.tolist(), "n": len(y)}
        mt = out["methods"]
        msg = f"  {m['label']:>34}  base {y[te].mean():.3f}"
        for k in ("sim", "sim_cal", "avg", "fit", "blend"):
            if k in mt:
                msg += f"  {k} {mt[k]['brier']:.4f}/{mt[k]['auc']:.3f}"
        c = out["chosen"]
        th, ts = ("top1_hit", "top1_said") if stat == "sv" else ("top_hit", "top_said")
        msg += f"  [{c}] {out['top_unit']} {mt[c][th]:.3f} (said {mt[c][ts]:.3f})"
        print(msg, flush=True)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{sport}_markets_backtest.json"), "w") as f:
        json.dump(res, f, indent=1)
    with open(os.path.join(DATA, f"cal_{sport}_markets.json"), "w") as f:
        json.dump(cal, f)


def y_of_any(sport: str, stat: str, line: dict) -> float:
    if stat == "sv":
        return float(line.get("sv", 0.0))
    return y_of(sport, stat, line)


if __name__ == "__main__":
    main()
