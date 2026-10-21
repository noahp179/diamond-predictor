"""
cfb_factor_eval.py — score college football simulator variants against each other.

Each variant is a run of scripts/props-backtest-football.ts cfb with some
factors switched on (FB_KNOBS), written to data/sim_{tag}_cfb_{season}*.jsonl.
Every variant is scored on the same player-games: per market, the players
the base variant priced who then appeared in the box score (a player who did
not appear is a void, as the live ledger settles him). Markets: every
yardage, catch, carry and passing line on the boards, plus anytime touchdown.

Calibrated Brier is cross-fitted over five blocks of game days. Against the
base: the average relative change over all markets, with a paired bootstrap
over games, and the markets better / worse.

    python3 research/player-props/cfb_factor_eval.py 2025 base recent50 ...
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
from evaluate_nfl_props import STATS, load_games  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "results")


def load_sim(tag: str, season: int) -> dict:
    pre = "sim" if tag == "prod" else f"sim_{tag}"
    out = {}
    for path in glob.glob(os.path.join(DATA, f"{pre}_cfb_{season}*.jsonl")):
        for line in open(path):
            g = json.loads(line)
            out[g["id"]] = g
    return out


def prob(sim: dict, gid: str, pid: str, stat: str, idx: int) -> float:
    p = sim.get(gid, {}).get("players", {}).get(pid)
    if not p:
        return 0.0
    if stat == "td":
        return float(p.get("td") or 0.0)
    v = p.get("props", {}).get(stat)
    return v["over"][idx] if v else 0.0


def main() -> None:
    season = int(sys.argv[1])
    tags = sys.argv[2:]
    markets = [m for m in json.load(open(os.path.join(DATA, "markets.json")))["nfl"] if m["idx"] is not None]
    markets = [m for m in markets if m["stat"] in STATS]
    markets.append({"stat": "td", "idx": 0, "line": 1, "slug": "td", "label": "Anytime touchdown"})
    sims = {t: load_sim(t, season) for t in tags}
    ids = set.intersection(*(set(v) for v in sims.values()))
    games = {g["id"]: g for g in load_games("cfb") if g["id"] in ids}
    base = sims[tags[0]]
    rows = []
    for gid, g in games.items():
        for pid, sp in base[gid]["players"].items():
            ln = g["lines"].get(pid)
            if ln is not None:
                rows.append({"gid": gid, "date": g["date"][:10], "pid": pid, "y": ln, "priced": sp})
    print(f"cfb {season}: {len(games)} games, {len(rows)} player-games")
    scored = {}
    for t in tags:
        res = {"n": 0, "markets": {}, "per_game": defaultdict(lambda: defaultdict(float)), "mae": {}}
        for m in markets:
            st, idx = m["stat"], m["idx"]
            R = [r for r in rows if (st == "td" or st in r["priced"].get("props", {}))]
            if len(R) < 200:
                continue
            y = np.array([1.0 if r["y"][st] >= m["line"] else 0.0 for r in R])
            s = np.array([prob(sims[t], r["gid"], r["pid"], st, idx) for r in R])
            c = L.crossfit_iso(s, y, L.date_folds([r["date"] for r in R]))
            e = (c - y) ** 2
            res["markets"][m["slug"]] = {"label": m["label"], "brier_cal": float(e.mean()),
                                         "brier_raw": float(np.mean((L.clip(s) - y) ** 2)), "n": len(R)}
            for r, v in zip(R, e):
                res["per_game"][r["gid"]][m["slug"]] += v
        for st in ("rec", "reyd", "ryd", "car", "pyd"):
            R = [r for r in rows if st in r["priced"].get("props", {})]
            a = np.array([r["y"][st] for r in R])
            p = np.array([((sims[t].get(r["gid"], {}).get("players", {}).get(r["pid"]) or {}).get("props", {})
                           .get(st) or {"mean": 0.0})["mean"] for r in R])
            res["mae"][st] = float(np.mean(np.abs(a - p)))
        res["n"] = len(rows)
        scored[t] = res
    b = scored[tags[0]]
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "cfb_factor_screen.jsonl"), "a") as f:
        for t in tags:
            v = scored[t]
            mae = " ".join(f"{k} {x:.2f}" for k, x in v["mae"].items())
            line = {"tag": t, "base": tags[0], "season": season, "games": len(games), "mae": v["mae"],
                    "brier_cal": {s: m["brier_cal"] for s, m in v["markets"].items()}}
            if t == tags[0]:
                print(f"  {t:>16}  (base)                         MAE {mae}")
            else:
                c = compare_fb(b, v)
                line["vs_base"] = c
                print(f"  {t:>16}  {100 * c['rel_brier']:+.2f}% [{100 * c['ci'][0]:+.2f}, {100 * c['ci'][1]:+.2f}]"
                      f"  better {c['better']:>2} worse {c['worse']:>2}  MAE {mae}")
            f.write(json.dumps(line) + "\n")


def compare_fb(base: dict, var: dict, n_boot: int = 1000, seed: int = 7) -> dict:
    slugs = list(base["markets"])
    tot = {s: base["markets"][s]["brier_cal"] * base["markets"][s]["n"] for s in slugs}
    games = sorted(base["per_game"])
    d = np.array([
        sum((var["per_game"][g].get(s, 0.0) - base["per_game"][g].get(s, 0.0)) / tot[s] for s in slugs)
        for g in games
    ]) / len(slugs)
    rng = np.random.default_rng(seed)
    boots = [d[rng.integers(0, len(d), len(d))].sum() for _ in range(n_boot)]
    rel = {s: var["markets"][s]["brier_cal"] / base["markets"][s]["brier_cal"] - 1 for s in slugs}
    return {"rel_brier": float(d.sum()),
            "ci": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
            "better": sum(v < -0.0005 for v in rel.values()), "worse": sum(v > 0.0005 for v in rel.values()),
            "by_market": rel}


if __name__ == "__main__":
    main()
