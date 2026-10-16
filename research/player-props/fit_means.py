"""
fit_means.py — the boards' projections, corrected like their percentages.

    python3 research/player-props/fit_means.py

The simulator's average for a player is a little too extreme at the ends: in
the NFL backtest the receivers it projected for 100+ yards averaged 81, and
the ones it projected for 14 averaged 17. The probabilities are corrected by
each market's calibration map; this does the same for the number printed
under each player ("projects 84 receiving yards"), so it can be held up
against a sportsbook's line.

For every stat on the boards: an isotonic map from the simulator's average to
what those players actually averaged, fitted on every backtested game (NBA
and NHL: 2024-25 and 2025-26, the same player-games evaluate_markets.py
scores; NFL and college: 2025 and 2026 to date, players who appeared). Before/after on
the held-out season is printed as mean absolute error.

Writes data/cal_means.json: {league: {"mean:<stat>": {x, y, n}}}.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate_markets as EM  # noqa: E402
import evaluate_nfl_props as EN  # noqa: E402
import marketlib as L  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def fit(x: np.ndarray, y: np.ndarray, test: np.ndarray, label: str) -> dict | None:
    """The map, if it helps where the boards look: the players the simulator
    projects highest (its top tenth) on the held-out games. Elsewhere the
    simulator's own average stands."""
    iso = L.IsotonicRegression(out_of_bounds="clip").fit(x[~test], y[~test])
    xt, yt = x[test], y[test]
    top = xt >= np.quantile(xt, 0.9)
    err = lambda p, m: float(np.abs(p[m] - yt[m]).mean())  # noqa: E731
    before, after = err(xt, top), err(iso.predict(xt), top)
    bias_b, bias_a = float((xt[top] - yt[top]).mean()), float((iso.predict(xt)[top] - yt[top]).mean())
    keep = after < before
    print(
        f"  {label:>8}: n {len(x):>6}  held-out top tenth: error {before:.2f} -> {after:.2f},"
        f" bias {bias_b:+.2f} -> {bias_a:+.2f}  (all: {err(xt, np.ones_like(top)):.2f} ->"
        f" {err(iso.predict(xt), np.ones_like(top)):.2f})  {'kept' if keep else 'not used'}"
    )
    if not keep:
        return None
    full = L.IsotonicRegression(out_of_bounds="clip").fit(x, y)
    return {"x": full.X_thresholds_.tolist(), "y": full.y_thresholds_.tolist(), "n": int(len(x))}


def put(out: dict, league: str, stat: str, c: dict | None) -> None:
    if c is not None:
        out.setdefault(league, {})[f"mean:{stat}"] = c


def main() -> None:
    out: dict[str, dict] = {}
    for sport, stats in (("nba", ["pts", "reb", "ast", "3pm", "pra", "pr", "pa", "ra", "stl", "blk", "stk"]),
                         ("nhl", ["pts", "g", "a", "sog"])):
        rows, _ = EM.skater_rows(sport)
        print(sport)
        for st in stats:
            R = [r for r in rows if st in r["sim"]]
            x = np.array([r["sim"][st]["mean"] for r in R])
            y = np.array([EM.y_of(sport, st, r["line"]) for r in R])
            test = np.array([r["season"] == EM.TEST for r in R])
            put(out, sport, st, fit(x, y, test, st))
        if sport == "nhl":
            G = [r for r in EM.goalie_rows() if "sv" in r["sim"]]
            x = np.array([r["sim"]["sv"]["mean"] for r in G])
            y = np.array([r["line"]["sv"] for r in G])
            test = np.array([r["season"] == EM.TEST for r in G])
            put(out, "nhl", "sv", fit(x, y, test, "sv"))
    for league in ("nfl", "cfb"):
        print(league)
        sims, games = EN.load_sims(league), {g["id"]: g for g in EN.load_games(league)}
        per: dict[str, list] = {}
        for gid, s in sims.items():
            g = games.get(gid)
            if not g:
                continue
            for pid, sp in s["players"].items():
                ln = g["lines"].get(pid)
                if ln is None:
                    continue
                for st, v in sp.get("props", {}).items():
                    if st in EN.STATS:
                        per.setdefault(st, []).append((v["mean"], ln[st], g["season"] == 2026))
        for st, v in per.items():
            a = np.array(v, dtype=float)
            put(out, league, st, fit(a[:, 0], a[:, 1], a[:, 2] > 0, st))
    with open(os.path.join(DATA, "cal_means.json"), "w") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
