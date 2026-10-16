"""
export_calibration.py — the calibration maps the live boards apply.

    python3 research/player-props/export_calibration.py

For each league and market the backtest chose "simulator, calibrated", fit an
isotonic map from the simulator's raw share to how often it actually came
in, on every simulated season (the live season is newer than all of them),
and write the knots to src/lib/sim-props-calibration.json. The site applies
it with linear interpolation between knots (calibrate() in
sim-props.server.ts) — the same thing sklearn's IsotonicRegression.predict
does, so the numbers match the backtest's.

Markets where the raw simulator was already the better-calibrated choice
(the first-scorer markets, except college's) are left out, and the site
shows the raw number. Leagues and keys this script does not fit (MLB's maps
and playoff adjustment, from evaluate_mlb.py) are kept as they are.
"""

from __future__ import annotations

import csv
import glob
import json
import os
import sys

import numpy as np
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asof  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
FT = os.path.join(HERE, "..", "football-td", "data")
OUT = os.path.join(HERE, "..", "..", "src", "lib", "sim-props-calibration.json")

COACH = ("coach", "decision")


def eligible(sport: str, p: dict) -> bool:
    if sport == "nhl" and p.get("grp") == "goalies":
        return False
    if not p.get("dnp"):
        return True
    reason = str(p.get("reason") or "").lower()
    return (not reason) or any(c in reason for c in COACH)


def load_sims(pattern: str) -> dict:
    out = {}
    for path in glob.glob(os.path.join(DATA, pattern)):
        with open(path) as f:
            for line in f:
                g = json.loads(line)
                out[str(g["id"])] = g
    return out


def fit(x, y, knots=40) -> dict:
    iso = IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4)
    iso.fit(x, y)
    xs, ys = iso.X_thresholds_, iso.y_thresholds_
    # thin to at most `knots` points, keeping the ends
    if len(xs) > knots:
        keep = np.unique(np.round(np.linspace(0, len(xs) - 1, knots)).astype(int))
        xs, ys = xs[keep], ys[keep]
    return {"x": [round(float(v), 5) for v in xs], "y": [round(float(v), 5) for v in ys], "n": int(len(x))}


def basketball_hockey(sport: str, markets: list[tuple[str, str, int, int]]) -> dict:
    sims = {}
    for s in (2024, 2025):
        sims.update(load_sims(f"sim_{sport}_{s}.*.jsonl"))
    xs = {m[0]: [] for m in markets}
    ys = {m[0]: [] for m in markets}
    for s in (2024, 2025):
        for g in asof.load(sport, [s]):
            sim = sims.get(g["id"])
            if not sim:
                continue
            for p in g["players"]:
                if not p.get("pid") or not eligible(sport, p):
                    continue
                line = asof.outcome(sport, p) or {}
                sp = sim["players"].get(p["pid"]) or {}
                for key, stat, idx, thr in markets:
                    v = sp.get(stat)
                    xs[key].append(v["over"][idx] if v else 0.0)
                    ys[key].append(1.0 if line.get(stat, 0.0) >= thr else 0.0)
    return {k: fit(np.array(xs[k]), np.array(ys[k])) for k in xs}


def football(league: str) -> dict:
    sims = load_sims(f"sim_{league}_*.jsonl")
    x, y = [], []
    with open(os.path.join(FT, f"{league}_model_preds.csv")) as f:
        for r in csv.DictReader(f):
            if r.get("candidate") != "1" or str(r.get("in_box", "1")) != "1":
                continue
            g = sims.get(str(r["event_id"]))
            sp = g["players"].get(str(r["player_id"])) if g else None
            if sp is None:
                continue
            x.append(float(sp.get("td", 0.0)))
            y.append(1.0 if r["scored"] == "1" else 0.0)
    xa, ya = np.array(x), np.array(y)
    if league == "cfb":
        # Fitted on the players the simulator gave some chance: the board
        # prices no one else (probOf), and with the rest in, the bottom knot
        # sat at 0% -> 7.7% — a floor under every player it barely priced
        # (the candidates it never gave a touchdown scored 7.7% of the time).
        xa, ya = xa[xa > 0], ya[xa > 0]
    out = {"td:0": fit(xa, ya)}
    if league == "cfb":
        # College's first-scorer share is over-sure where NFL's is not: on
        # 2025-26 its top pick a game said 17.7% and came in 14.4%; through
        # this map (cross-fitted in evaluate_football.py) 14.2% and 15.1%.
        import evaluate_football as EF

        ftd = EF.first_td(league)
        fx, fy = [], []
        with open(os.path.join(FT, f"{league}_model_preds.csv")) as f:
            for r in csv.DictReader(f):
                eid = str(r["event_id"])
                if r.get("candidate") != "1" or str(r.get("in_box", "1")) != "1" or eid not in ftd:
                    continue
                g = sims.get(eid)
                sp = g["players"].get(str(r["player_id"])) if g else None
                if sp is None:
                    continue
                fx.append(float(sp.get("first", 0.0)))
                fy.append(1.0 if ftd[eid] == str(r["player_id"]) else 0.0)
        fxa, fya = np.array(fx), np.array(fy)
        out["first"] = fit(fxa[fxa > 0], fya[fxa > 0])
    return out


def main() -> None:
    curves = {
        "nba": basketball_hockey("nba", [(f"pts:{i}", "pts", i, t) for i, t in enumerate([10, 15, 20, 25, 30])]),
        "nhl": basketball_hockey(
            "nhl", [("pts:0", "pts", 0, 1), ("pts:1", "pts", 1, 2), ("g:0", "g", 0, 1)]
        ),
    }
    for league in ("nfl", "cfb"):
        if os.path.exists(os.path.join(FT, f"{league}_model_preds.csv")):
            curves[league] = football(league)
    # Every other market on the boards: the maps evaluate_markets.py and
    # evaluate_nfl_props.py fitted on all their games, for the markets where
    # the calibrated simulator beat the raw one (the rest show it raw).
    extra = []
    for league, name in (
        ("nba", "cal_nba_markets.json"),
        ("nhl", "cal_nhl_markets.json"),
        ("nfl", "cal_nfl_props.json"),
        ("cfb", "cal_cfb_props.json"),
    ):
        path = os.path.join(DATA, name)
        if os.path.exists(path):
            extra.append((league, json.load(open(path))))
    # and the projections' maps (fit_means.py): "mean:<stat>"
    path = os.path.join(DATA, "cal_means.json")
    if os.path.exists(path):
        extra += list(json.load(open(path)).items())
    for league, maps in extra:
        for key, c in maps.items():
            if key in curves.get(league, {}):
                continue  # the points / goals / touchdown maps above stay as published
            x, y = np.array(c["x"]), np.array(c["y"])
            if len(x) > 40:
                keep = np.unique(np.round(np.linspace(0, len(x) - 1, 40)).astype(int))
                x, y = x[keep], y[keep]
            curves.setdefault(league, {})[key] = {
                "x": [round(float(v), 5) for v in x],
                "y": [round(float(v), 5) for v in y],
                "n": int(c.get("n", 0)),
            }
    # what other scripts merged in (MLB: evaluate_mlb.py) stays
    old = json.load(open(OUT)) if os.path.exists(OUT) else {}
    for league, maps in old.get("curves", {}).items():
        curves.setdefault(league, maps)
    out = {
        **old,
        "version": "sim-props-cal-v2",
        "note": "Isotonic maps, simulator share -> observed rate, fitted on every backtested season. Keys are market:lineIndex.",
        "curves": curves,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", OUT, {k: list(v) for k, v in curves.items()})


if __name__ == "__main__":
    main()
