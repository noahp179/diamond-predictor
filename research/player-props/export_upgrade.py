"""
export_upgrade.py — the simulator upgrade, as the Analytics page shows it.

For one league, scores the previous simulator (the base variant) and the
upgraded one on the season held out to judge it, market by market: the
calibrated error score (isotonic, cross-fitted over five blocks of game days)
and how often each game's top three picks came in (top pick for
quarterbacks). Writes it, with the plain-language list of what was added and
what was left out (upgrade_{league}.json beside this script), under "upgrade"
in src/lib/sim-props-backtest.json.

    python3 research/player-props/export_upgrade.py nba 2025 base final
    python3 research/player-props/export_upgrade.py cfb 2026 base final
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import marketlib as L  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "..", "..", "src", "lib", "sim-props-backtest.json")
STAT_NAME = {
    "pts": "Points", "reb": "Rebounds", "ast": "Assists", "3pm": "Threes", "pra": "Pts+Reb+Ast",
    "pr": "Pts+Reb", "pa": "Pts+Ast", "ra": "Reb+Ast", "dd": "Double-double", "stl": "Steals",
    "blk": "Blocks", "stk": "Steals+Blocks",
    "rec": "Receptions", "reyd": "Receiving yards", "ryd": "Rushing yards", "rry": "Rush+rec yards",
    "car": "Carries", "pyd": "Passing yards", "ptd": "TD passes", "cmp": "Completions", "td": "Touchdowns",
}


def top_hit(y: np.ndarray, p: np.ndarray, gids: list[str], k: int) -> float:
    by = defaultdict(list)
    for i, g in enumerate(gids):
        by[g].append(i)
    idx = [i for v in by.values() for i in sorted(v, key=lambda i: -p[i])[:k]]
    return float(y[idx].mean()) if idx else float("nan")


def score_rows(rows: list[dict], markets: list[dict], prob) -> dict:
    out = {}
    for m in markets:
        R = [r for r in rows if m["keep"](r)]
        if len(R) < 200:
            continue
        y = np.array([m["y"](r) for r in R])
        folds = L.date_folds([r["date"] for r in R])
        gids = [r["gid"] for r in R]
        out[m["slug"]] = {}
        for tag in ("old", "new"):
            s = np.array([prob(tag, r, m) for r in R])
            c = L.crossfit_iso(s, y, folds)
            out[m["slug"]][tag] = {
                "brier": float(np.mean((c - y) ** 2)),
                "top_hit": top_hit(y, c, gids, m["k"]),
            }
        out[m["slug"]]["n"] = len(R)
    return out


def nba(season: int, old: str, new: str):
    import nba_factor_eval as E
    from evaluate_markets import y_of

    markets = [m for m in json.load(open(os.path.join(DATA, "markets.json")))["nba"] if m["idx"] is not None]
    sims = {"old": E.load_sim(old, season), "new": E.load_sim(new, season)}
    ids = set(sims["old"]) & set(sims["new"])
    rows = E.rows_for(season, ids)
    for m in markets:
        stat, idx, line = m["stat"], m["idx"], m["line"]
        m["keep"] = lambda r: True
        m["y"] = lambda r, s=stat, ln=line: 1.0 if (y_of("nba", s, r["line"]) if r["line"] else 0.0) >= ln else 0.0
        m["k"] = 3

    def prob(tag, r, m):
        v = sims[tag][r["gid"]]["players"].get(r["pid"], {}).get(m["stat"])
        return v["over"][m["idx"]] if v else 0.0

    return markets, score_rows(rows, markets, prob), len(ids)


def cfb(season: int, old: str, new: str):
    import cfb_factor_eval as E
    from evaluate_nfl_props import STATS, load_games

    markets = [m for m in json.load(open(os.path.join(DATA, "markets.json")))["nfl"] if m["idx"] is not None]
    markets = [m for m in markets if m["stat"] in STATS]
    markets.append({"stat": "td", "idx": 0, "line": 1, "slug": "td", "label": "Anytime touchdown"})
    sims = {"old": E.load_sim(old, season), "new": E.load_sim(new, season)}
    ids = set(sims["old"]) & set(sims["new"])
    games = {g["id"]: g for g in load_games("cfb") if g["id"] in ids}
    rows = []
    for gid, g in games.items():
        for pid, sp in sims["old"][gid]["players"].items():
            if pid in g["lines"]:
                rows.append({"gid": gid, "date": g["date"][:10], "pid": pid, "y": g["lines"][pid], "priced": sp})
    for m in markets:
        st = m["stat"]
        m["keep"] = lambda r, s=st: s == "td" or s in r["priced"].get("props", {})
        m["y"] = lambda r, s=st, ln=m["line"]: 1.0 if r["y"][s] >= ln else 0.0
        m["k"] = 1 if st in ("pyd", "ptd", "cmp") else 3

    def prob(tag, r, m):
        return E.prob(sims[tag], r["gid"], r["pid"], m["stat"], m["idx"])

    return markets, score_rows(rows, markets, prob), len(games)


def main() -> None:
    league, season, old, new = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    markets, res, games = (nba if league == "nba" else cfb)(season, old, new)
    meta = json.load(open(os.path.join(HERE, f"upgrade_{league}.json")))
    rows = []
    for m in markets:
        r = res.get(m["slug"])
        if not r:
            continue
        rows.append({
            "label": m["label"], "stat": STAT_NAME.get(m["stat"], m["stat"]), "n": r["n"],
            "old": {k: round(v, 5) for k, v in r["old"].items()},
            "new": {k: round(v, 5) for k, v in r["new"].items()},
        })
        d = r["new"]["brier"] / r["old"]["brier"] - 1
        print(f"  {m['label']:>28}  {r['old']['brier']:.4f} -> {r['new']['brier']:.4f}  {100 * d:+.1f}%"
              f"  top {r['old']['top_hit']:.3f} -> {r['new']['top_hit']:.3f}")
    out = json.load(open(OUT))
    out.setdefault("upgrade", {})[league] = {**meta, "games": games, "rows": rows}
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    better = sum(r["new"]["brier"] < r["old"]["brier"] for r in rows)
    print(f"{league}: {better} of {len(rows)} markets better; wrote upgrade.{league}")


if __name__ == "__main__":
    main()
