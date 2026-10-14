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
(the first-scorer markets) are left out, and the site shows the raw number.
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
    return {"td:0": fit(np.array(x), np.array(y))}


def main() -> None:
    curves = {
        "nba": basketball_hockey("nba", [(f"pts:{i}", "pts", i, t) for i, t in enumerate([10, 15, 20, 25, 30])]),
        "nhl": basketball_hockey(
            "nhl", [("pts:0", "pts", 0, 1), ("pts:1", "pts", 1, 2), ("g:0", "g", 0, 1), ("a:0", "a", 0, 1)]
        ),
    }
    for league in ("nfl", "cfb"):
        if os.path.exists(os.path.join(FT, f"{league}_model_preds.csv")):
            curves[league] = football(league)
    out = {
        "version": "sim-props-cal-v1",
        "note": "Isotonic maps, simulator share -> observed rate, fitted on every backtested season. Keys are market:lineIndex.",
        "curves": curves,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", OUT, {k: list(v) for k, v in curves.items()})


if __name__ == "__main__":
    main()
