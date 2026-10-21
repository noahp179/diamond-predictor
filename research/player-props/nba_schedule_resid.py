"""
nba_schedule_resid.py — how many points the schedule, the arena and the crew
are worth beyond what the simulator already knows.

Reads a variant whose output carries each game's inputs (ctx), and regresses
each team's actual points minus the simulator's average on: rest days beyond
one, a fourth game in six nights, miles since the last game, time zones moved
east, visiting at altitude; and the game's total assists minus the
simulator's on the arena's crediting figure. Back-to-backs are already in
the engine and are left out.

    python3 research/player-props/nba_schedule_resid.py 2024 basectx
"""

from __future__ import annotations

import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def main() -> None:
    season, tag = int(sys.argv[1]), sys.argv[2]
    box = {}
    for line in open(os.path.join(DATA, f"nba_{season}.jsonl")):
        g = json.loads(line)
        box[g["id"]] = g
    X, y, A, Ay = [], [], [], []
    for path in glob.glob(os.path.join(DATA, f"sim_{tag}_nba_{season}*.jsonl")):
        for line in open(path):
            s = json.loads(line)
            g = box.get(s["id"])
            c = s.get("ctx")
            if not g or not c or g["stype"] != 2:
                continue
            for side, pts in (("home", g["hs"]), ("away", g["as"])):
                x = c.get(side) or {}
                rest = x.get("rest")
                if rest is None:
                    continue
                X.append([
                    1.0,
                    1.0 if side == "home" else 0.0,
                    min(3, rest) - 1 if rest > 1 else 0.0,
                    1.0 if x.get("g4in6") else 0.0,
                    (x.get("miles") or 0) / 1000,
                    max(0, x.get("tzEast") or 0),
                    max(0, -(x.get("tzEast") or 0)),
                    1.0 if side == "away" and c.get("alt") else 0.0,
                ])
                y.append(pts - s[side])
            sc = c.get("scorer")
            if sc:
                act = sum(p.get("ast") or 0 for p in g["players"])
                sim = sum((v.get("ast") or {}).get("mean", 0) for v in s["players"].values())
                A.append([1.0, np.log(sc["ast"])])
                Ay.append(np.log(max(1, act) / max(1, sim)))
    X, y = np.array(X), np.array(y)
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    res = y - X @ beta
    se = np.sqrt(np.diag(np.linalg.inv(X.T @ X)) * res.var())
    names = ["const", "home", "rest days > 1", "4th in 6", "per 1000 mi", "tz east", "tz west", "altitude (visitor)"]
    print(f"{season} {tag}: {len(y)} team-games; points vs the simulator")
    for nme, b, e in zip(names, beta, se):
        print(f"  {nme:>20}  {b:+.2f} pts  (se {e:.2f})")
    if A:
        A, Ay = np.array(A), np.array(Ay)
        b, *_ = np.linalg.lstsq(A, Ay, rcond=None)
        r = Ay - A @ b
        e = np.sqrt(np.diag(np.linalg.inv(A.T @ A)) * r.var())
        print(f"  assists: log(actual/sim) on log(arena factor): slope {b[1]:+.2f} (se {e[1]:.2f}), n {len(Ay)}")


if __name__ == "__main__":
    main()
