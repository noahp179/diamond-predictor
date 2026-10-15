"""
postseason_shift.py — the playoff correction for the MLB prop boards.

    npx tsx scripts/backtest-mlb-postseason.ts        (FORM=all DATES=post, and the others)
    python3 research/mlb-props/postseason_shift.py

The prop models were fitted on the regular season. Replayed on every playoff
game of 2024, 2025 and 2026 so far (scripts/backtest-mlb-postseason.ts), the
hitter markets and the 2+ bases board hold up — within a point or two of what
they said, better than the base rate in every market — but two groups run hot:

  - starter strikeouts: playoff starters are pulled earlier, so 5+/6+/7+ K
    come in 7-11 points below the price;
  - team runs over 3.5/4.5/5.5: October runs are scarcer.

Each group gets one shift on the log-odds scale, the same for its three lines,
chosen so the average price equals the average outcome. It is checked the
honest way first — fitted on 2024-25, scored on 2026 — and a group ships a
shift only if that check calls for one and it helps 2026; the shift shipped is
then refitted on all three postseasons. The hitters and the 2+ bases board
don't earn one: on 2024-25 they need none, and their 2026 drift is one cold
October.

Writes src/lib/mlb-postseason.json.
"""

from __future__ import annotations

import json
import math
import os
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "src", "lib")
POST = os.path.join(HERE, "data", "postseason")  # rows from the backtest harness


def logit(p: float) -> float:
    p = min(1 - 1e-6, max(1e-6, p))
    return math.log(p / (1 - p))


def sig(z: float) -> float:
    return 1 / (1 + math.exp(-z))


def fit_shift(rows: list[dict]) -> float:
    """The log-odds shift that makes the mean price equal the hit rate."""
    y = sum(r["hit"] for r in rows) / len(rows)
    lo, hi = -3.0, 3.0
    for _ in range(80):
        mid = (lo + hi) / 2
        m = sum(sig(logit(r["prob"]) + mid) for r in rows) / len(rows)
        lo, hi = (mid, hi) if m < y else (lo, mid)
    return (lo + hi) / 2


def score(rows: list[dict], d: float = 0.0) -> dict:
    ps = [sig(logit(r["prob"]) + d) for r in rows]
    n = len(rows)
    return {
        "n": n,
        "said": sum(ps) / n,
        "hit": sum(r["hit"] for r in rows) / n,
        "brier": sum((p - r["hit"]) ** 2 for p, r in zip(ps, rows)) / n,
        "logloss": -sum(math.log(p if r["hit"] else 1 - p) for p, r in zip(ps, rows)) / n,
    }


GROUPS = {
    "strikeouts": lambda r: r["board"] == "props" and r["market"] in ("k5", "k6", "k7"),
    "teamRuns": lambda r: r["board"] == "stacks",
    "hitters": lambda r: r["board"] == "props" and r["market"] not in ("k5", "k6", "k7", "outs16"),
    "twoBases": lambda r: r["board"] == "tb2",
}
# Below this a shift moves a 40% price by under 1.5 points: not worth carrying.
NEGLIGIBLE = 0.06


def main() -> None:
    rows = json.load(open(os.path.join(POST, "post-all.json")))["rows"]
    out: dict = {
        "generated": date.today().isoformat(),
        "note": "Log-odds shift applied to playoff games only; fitted on the 2024-2026 postseasons. "
        "See research/mlb-props/postseason_shift.py.",
        "shift": {},
        "validation": {},
    }
    for name, f in GROUPS.items():
        g = [r for r in rows if f(r)]
        train = [r for r in g if r["date"][:4] in ("2024", "2025")]
        test = [r for r in g if r["date"][:4] == "2026"]
        d_val = fit_shift(train)
        d_all = fit_shift(g)
        out["validation"][name] = {
            "shiftFit2024_25": d_val,
            "test2026Raw": score(test),
            "test2026Adjusted": score(test, d_val),
            "allRaw": score(g),
        }
        # Ships only what the held-out check supports: 2024-25 alone must call
        # for a real shift, and that shift must improve 2026, which it never
        # saw. A group that drifts only because one October ran cold gets none.
        earned = (
            abs(d_val) >= NEGLIGIBLE
            and score(test, d_val)["brier"] < score(test)["brier"]
        )
        out["shift"][name] = round(d_all, 4) if earned else 0.0
        v = out["validation"][name]
        print(
            f"{name:11} shift(all) {d_all:+.3f} -> ships {out['shift'][name]:+.3f} | "
            f"fit 2024-25 {d_val:+.3f}, 2026: came in {v['test2026Raw']['hit']:.1%} "
            f"said {v['test2026Raw']['said']:.1%} -> {v['test2026Adjusted']['said']:.1%}, "
            f"brier {v['test2026Raw']['brier']:.4f} -> {v['test2026Adjusted']['brier']:.4f}"
        )

    def rnd(x):
        if isinstance(x, float):
            return round(x, 4)
        if isinstance(x, dict):
            return {k: rnd(v) for k, v in x.items()}
        return x

    with open(os.path.join(SRC, "mlb-postseason.json"), "w") as fh:
        json.dump(rnd(out), fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main()
