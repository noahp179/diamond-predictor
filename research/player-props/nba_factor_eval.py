"""
nba_factor_eval.py — score NBA simulator variants against each other.

Each variant is a run of scripts/props-backtest.ts with some factors switched
on (NBA_KNOBS), written to data/sim_{tag}_nba_{season}*.jsonl. Every variant is
scored on the same player-games (every player listed for the game except
those the injury report had out), on every market the boards publish:

  - Brier, raw and calibrated (isotonic, cross-fitted over five blocks of
    game days, so no game is scored by a map that saw it);
  - the error of the projected minutes, points, rebounds, assists and threes
    (mean absolute error, a coach's decision counting as zero).

Against a base variant it reports the average relative change in calibrated
Brier over all markets, with a paired bootstrap over games, and how many
markets got better or worse.

    python3 research/player-props/nba_factor_eval.py 2024 base recent50 ...

The first tag is the base. Appends one line per variant to
results/nba_factor_screen.jsonl.
"""

from __future__ import annotations

import glob
import json
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import marketlib as L  # noqa: E402
from evaluate import eligible  # noqa: E402
from evaluate_markets import y_of  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "results")
MEANS = {"min": ["min"], "pts": ["pts"], "reb": ["reb"], "ast": ["ast"], "3pm": ["tpm"]}


def load_sim(tag: str, season: int) -> dict:
    pre = "sim" if tag == "prod" else f"sim_{tag}"
    out = {}
    for path in glob.glob(os.path.join(DATA, f"{pre}_nba_{season}*.jsonl")):
        for line in open(path):
            g = json.loads(line)
            out[g["id"]] = g
    return out


def rows_for(season: int, ids: set[str]) -> list[dict]:
    rows = []
    for line in open(os.path.join(DATA, f"nba_{season}.jsonl")):
        g = json.loads(line)
        if g["id"] not in ids:
            continue
        for p in g["players"]:
            if not p.get("pid") or not eligible("nba", p):
                continue
            played = not p.get("dnp") and (p.get("min") or 0) > 0
            line_ = {k: float(p.get(k) or 0) for k in ("pts", "reb", "ast", "tpm", "stl", "blk", "min")} if played else {}
            rows.append({"gid": g["id"], "date": g["date"][:10], "pid": p["pid"], "line": line_})
    return rows


def score(tag: str, season: int, markets: list[dict], rows: list[dict], sims: dict) -> dict:
    folds = L.date_folds([r["date"] for r in rows])
    gids = np.array([r["gid"] for r in rows])
    res = {"tag": tag, "season": season, "n": len(rows), "markets": {}, "mae": {}, "per_game": {}}
    per_game = defaultdict(lambda: defaultdict(float))
    for m in markets:
        stat, idx, line = m["stat"], m["idx"], m["line"]
        y = np.array([1.0 if (y_of("nba", stat, r["line"]) if r["line"] else 0.0) >= line else 0.0 for r in rows])
        s = np.array([
            (sims[r["gid"]]["players"].get(r["pid"], {}).get(stat) or {"over": [0.0] * (idx + 1)})["over"][idx]
            for r in rows
        ])
        c = L.crossfit_iso(s, y, folds)
        b_raw = float(np.mean((L.clip(s) - y) ** 2))
        e = (c - y) ** 2
        res["markets"][m["slug"]] = {"label": m["label"], "brier_raw": b_raw, "brier_cal": float(e.mean()),
                                     "base_rate": float(y.mean())}
        for g, v in zip(gids, e):
            per_game[g][m["slug"]] += v
    for k, cols in MEANS.items():
        a = np.array([sum(r["line"].get(c, 0.0) for c in cols) if r["line"] else 0.0 for r in rows])
        p = np.array([(sims[r["gid"]]["players"].get(r["pid"], {}).get(k) or {"mean": 0.0})["mean"] for r in rows])
        res["mae"][k] = float(np.mean(np.abs(a - p)))
    res["per_game"] = {g: dict(v) for g, v in per_game.items()}
    return res


def compare(base: dict, var: dict, n_boot: int = 1000, seed: int = 7) -> dict:
    slugs = list(base["markets"])
    # Each market's error, as a share of the base's (so every market counts
    # the same), summed per game.
    tot = {s: base["markets"][s]["brier_cal"] * base["n"] for s in slugs}
    games = sorted(base["per_game"])
    d = np.array([
        sum((var["per_game"][g].get(s, 0.0) - base["per_game"][g].get(s, 0.0)) / tot[s] for s in slugs)
        for g in games
    ]) / len(slugs)
    rng = np.random.default_rng(seed)
    boots = [d[rng.integers(0, len(d), len(d))].sum() for _ in range(n_boot)]
    rel = {s: var["markets"][s]["brier_cal"] / base["markets"][s]["brier_cal"] - 1 for s in slugs}
    return {
        "rel_brier": float(d.sum()),
        "ci": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
        "better": sum(v < -0.0005 for v in rel.values()),
        "worse": sum(v > 0.0005 for v in rel.values()),
        "by_market": rel,
    }


def main() -> None:
    season = int(sys.argv[1])
    tags = sys.argv[2:]
    markets = [m for m in json.load(open(os.path.join(DATA, "markets.json")))["nba"] if m["idx"] is not None]
    sims = {t: load_sim(t, season) for t in tags}
    ids = set.intersection(*(set(v) for v in sims.values()))
    rows = rows_for(season, ids)
    print(f"{season}: {len(ids)} games, {len(rows)} player-games, {len(markets)} markets")
    scored = {t: score(t, season, markets, rows, sims[t]) for t in tags}
    base = scored[tags[0]]
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "nba_factor_screen.jsonl"), "a") as f:
        for t in tags:
            v = scored[t]
            line = {"tag": t, "base": tags[0], "season": season, "games": len(ids), "n": v["n"], "mae": v["mae"],
                    "brier_cal": {s: m["brier_cal"] for s, m in v["markets"].items()},
                    "brier_raw": {s: m["brier_raw"] for s, m in v["markets"].items()}}
            if t != tags[0]:
                line["vs_base"] = compare(base, v)
            f.write(json.dumps(line) + "\n")
            mae = " ".join(f"{k} {x:.3f}" for k, x in v["mae"].items())
            if t == tags[0]:
                print(f"  {t:>16}  (base)                         MAE {mae}")
            else:
                c = line["vs_base"]
                print(f"  {t:>16}  {100 * c['rel_brier']:+.2f}% [{100 * c['ci'][0]:+.2f}, {100 * c['ci'][1]:+.2f}]"
                      f"  better {c['better']:>2} worse {c['worse']:>2}  MAE {mae}")


if __name__ == "__main__":
    main()
