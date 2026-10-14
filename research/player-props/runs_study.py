"""
runs_study.py — does playing each game 100,000 times instead of 1,000 change
the picks or their accuracy?

    SAMPLE_EVERY=20 OUT_TAG=_100k npx tsx scripts/props-backtest.ts nba 2025 0 4 100000   (x4 shards)
    SAMPLE_EVERY=20 OUT_TAG=_10k  npx tsx scripts/props-backtest.ts nba 2025 0 4 10000
    python3 research/player-props/runs_study.py nba

Every game in the sample has been simulated three times — 1,000, 10,000 and
100,000 plays, the same inputs each time. For every player-line this reports
how far the 1,000- and 10,000-play percentages sit from the 100,000-play one
(the Monte Carlo noise), the accuracy of each against what happened, and
whether the board's top picks change.
"""

from __future__ import annotations

import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asof  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "results")

LINES = {"nba": [("pts", i, t) for i, t in enumerate([10, 15, 20, 25, 30])], "nhl": [("pts", 0, 1), ("pts", 1, 2), ("g", 0, 1)]}


def load(pattern: str) -> dict:
    out = {}
    for p in glob.glob(os.path.join(DATA, pattern)):
        with open(p) as f:
            for line in f:
                g = json.loads(line)
                out[g["id"]] = g
    return out


def main() -> None:
    sport = sys.argv[1]
    s1 = load(f"sim_{sport}_2025.*.jsonl")
    s1 = s1 or load(f"sim1k/sim_{sport}_2025.*.jsonl")
    s10 = load(f"sim_10k_{sport}_2025.*.jsonl")
    s100 = load(f"sim_100k_{sport}_2025.*.jsonl")
    games = sorted(set(s100) & set(s10) & set(s1))
    outcomes = {}
    for g in asof.load(sport, [2025]):
        if g["id"] in games:
            for p in g["players"]:
                ln = asof.outcome(sport, p)
                outcomes[(g["id"], p["pid"])] = ln or {}
    res = {"sport": sport, "games": len(games), "lines": []}
    print(f"{sport}: {len(games)} games simulated at 1k, 10k and 100k")
    for stat, idx, thr in LINES[sport]:
        rows = []
        for gid in games:
            for pid, v100 in s100[gid]["players"].items():
                def pr(src):
                    sp = src[gid]["players"].get(pid) or {}
                    return (sp.get(stat) or {}).get("over", [0.0] * 8)[idx] if sp.get(stat) else 0.0
                y = outcomes.get((gid, pid))
                if y is None:
                    continue
                rows.append((gid, pr(s1), pr(s10), pr(s100), 1.0 if y.get(stat, 0) >= thr else 0.0))
        a = np.array([r[1:] for r in rows])
        p1, p10, p100, yy = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
        live = p100 > 0.01

        def brier(p):
            return float(np.mean((p - yy) ** 2))

        def top_overlap(pa, pb, k=3):
            same = tot = 0
            for gid in games:
                ii = [i for i, r in enumerate(rows) if r[0] == gid]
                ta = set(sorted(ii, key=lambda i: -pa[i])[:k])
                tb = set(sorted(ii, key=lambda i: -pb[i])[:k])
                same += len(ta & tb)
                tot += k
            return same / tot

        r = {
            "line": f"{thr}+ {stat}",
            "rows": len(rows),
            "mean_abs_diff_1k": float(np.mean(np.abs(p1 - p100)[live])),
            "p95_abs_diff_1k": float(np.percentile(np.abs(p1 - p100)[live], 95)),
            "mean_abs_diff_10k": float(np.mean(np.abs(p10 - p100)[live])),
            "p95_abs_diff_10k": float(np.percentile(np.abs(p10 - p100)[live], 95)),
            "brier_1k": brier(p1),
            "brier_10k": brier(p10),
            "brier_100k": brier(p100),
            "top3_same_1k": top_overlap(p1, p100),
            "top3_same_10k": top_overlap(p10, p100),
        }
        res["lines"].append(r)
        print(
            f"  {r['line']:>8}: |1k-100k| mean {100*r['mean_abs_diff_1k']:.2f} pts (95% {100*r['p95_abs_diff_1k']:.2f})"
            f"  |10k-100k| mean {100*r['mean_abs_diff_10k']:.2f} pts (95% {100*r['p95_abs_diff_10k']:.2f})"
            f"  brier 1k {r['brier_1k']:.5f} 10k {r['brier_10k']:.5f} 100k {r['brier_100k']:.5f}"
            f"  top-3 same as 100k: 1k {r['top3_same_1k']:.0%} 10k {r['top3_same_10k']:.0%}"
        )
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{sport}_runs_study.json"), "w") as f:
        json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
