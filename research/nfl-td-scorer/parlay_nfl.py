"""
The same parlay question for the NFL.

`game_picks.csv` is one row per game: the model's top pick, its probability and
whether it scored, for 2022-24. That is exactly the construction the college
backtest settled on — one leg per game — so a slip of N legs is the N games in a
week with the highest top pick, and the file can answer it directly.

The NFL's constraint is arithmetic rather than statistical: a week has thirteen
to sixteen games. One leg per game therefore caps a slip at the size of the
slate, and a twenty-leg slip cannot be built at all. That is worth stating on
the page rather than quietly returning a short slip.
"""
import os, json
import csv
from collections import defaultdict
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [5, 10, 15, 20]


def load():
    rows = []
    with open(os.path.join(HERE, "game_picks.csv")) as f:
        for r in csv.DictReader(f):
            try:
                rows.append({
                    "season": int(r["season"]),
                    "week": int(r["week"]),
                    "p": float(r["top1_p"]),
                    "hit": int(r["top1_hit"]),
                })
            except (ValueError, KeyError):
                continue
    return rows


def main():
    rows = load()
    weeks = defaultdict(list)
    for r in rows:
        weeks[(r["season"], r["week"])].append(r)
    sizes = [len(v) for v in weeks.values()]
    print(f"{len(rows)} games across {len(weeks)} weeks")
    print(f"games per week: min {min(sizes)}, median {int(np.median(sizes))}, max {max(sizes)}\n")

    print("=== one leg per game, by slip size ===")
    print(f"{'size':>4} {'floor':>6} {'weeks filled':>14} {'realised':>9} {'product':>9} {'ratio':>7} {'leg hit':>8}")
    out = []
    for size in SIZES:
        for floor in (0.0, 0.35, 0.40, 0.45):
            filled = hits = 0
            pred = 0.0
            leg_n = leg_hits = 0
            for k, games in weeks.items():
                elig = sorted([g for g in games if g["p"] >= floor], key=lambda g: -g["p"])
                if len(elig) < size:
                    continue
                legs = elig[:size]
                filled += 1
                hits += int(all(l["hit"] for l in legs))
                pred += float(np.prod([l["p"] for l in legs]))
                leg_n += size
                leg_hits += sum(l["hit"] for l in legs)
            if filled == 0:
                print(f"{size:>4} {floor:>6.2f} {'0 — cannot be built':>14}")
                out.append({"size": size, "floor": floor, "weeks": len(weeks), "filled": 0})
                continue
            realised = hits / filled
            product = pred / filled
            out.append({
                "size": size, "floor": floor, "weeks": len(weeks), "filled": filled,
                "hits": hits, "realised": realised, "product": product,
                "ratio": realised / product if product else None,
                "leg_hit_rate": leg_hits / leg_n,
            })
            print(
                f"{size:>4} {floor:>6.2f} {filled:>5}/{len(weeks):<8} "
                f"{realised*100:>8.1f}% {product*100:>8.3f}% "
                f"{realised/product if product else float('nan'):>7.2f} {leg_hits/leg_n*100:>7.1f}%"
            )
        print()

    print("=== the ceiling ===")
    for size in SIZES:
        n = sum(1 for v in weeks.values() if len(v) >= size)
        print(f"  {size:>2} legs: buildable in {n}/{len(weeks)} weeks "
              f"({'never — a week has at most %d games' % max(sizes) if n == 0 else '%.0f%%' % (100*n/len(weeks))})")

    json.dump(out, open(os.path.join(HERE, "parlay_nfl_metrics.json"), "w"), indent=1)
    print("\nwrote parlay_nfl_metrics.json")


if __name__ == "__main__":
    main()
