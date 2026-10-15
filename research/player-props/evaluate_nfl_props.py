"""
evaluate_nfl_props.py — NFL yardage, catch and passing props: the simulator
against the site's logistic prop models and a season-average baseline.

    python3 research/player-props/evaluate_nfl_props.py

Games: every game of the 2025 season and 2026 to date that
scripts/props-backtest-football.ts simulated (1,000 plays each, from what was
known that morning). Outcomes come from the same ESPN summaries
(research/football-td/data/raw/nfl).

Who is scored, per market: every player the simulator priced for that stat
(it prices a stat only for players it expects some of — research note in
src/lib/sim/props.ts minMean) who then appeared in the box score. A player
who did not appear is a void, as the live ledger settles him.

Methods
-------
  sim      the simulator's share of plays that reached the line.
  sim_cal  the same through an isotonic map fitted on the OTHER date folds
           (five contiguous blocks of game days), so it is never scored on
           the games it was fitted to. The live map is fitted on all of them.
  avg      the player's per-game average (this season, with up to four games
           of last season carried in) through a negative binomial whose
           spread is fitted on the other folds.
  model    the site's shipped logistic prop model (nfl-props-model.json),
           reproduced by research/nfl-props/dump_shipped_preds.py, for the
           14 lines it prices — scored head-to-head on the rows both methods
           price (its own eligibility rules, and the simulator's).

Writes research/player-props/results/nfl_props_backtest.json and
data/cal_nfl_props.json (the live calibration knots).
"""

from __future__ import annotations

import csv
import glob
import gzip
import json
import os
from collections import defaultdict

import numpy as np

import marketlib as L

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RAW = os.path.join(HERE, "..", "football-td", "data", "raw", "nfl")
LOGIT = os.path.join(HERE, "..", "nfl-props", "data", "logistic_preds.csv")
OUT = os.path.join(HERE, "results")

STATS = ["rec", "reyd", "ryd", "rry", "car", "pyd", "ptd", "cmp"]
CARRY = 4  # games of last season carried into this season's average

# the logistic models' markets, in the boards' ledger codes
LOGIT_MAP = {
    "rec3": "rec3", "rec5": "rec5", "rec7": "rec7",
    "recy40": "reyd40", "recy60": "reyd60", "recy80": "reyd80",
    "rushy40": "ryd40", "rushy60": "ryd60", "rushy80": "ryd80",
    "scrim60": "rry60", "scrim90": "rry90",
    "passy225": "pyd225", "passy275": "pyd275", "passtd2": "ptd2",
}


def num(v) -> float:
    try:
        return float(str(v).split("-")[0].split("/")[0])
    except ValueError:
        return 0.0


def read_game(path: str) -> dict | None:
    d = json.load(gzip.open(path))
    h = d.get("header", {})
    comp = (h.get("competitions") or [{}])[0]
    if not comp.get("status", {}).get("type", {}).get("completed"):
        return None
    lines: dict[str, dict] = {}
    for t in d.get("boxscore", {}).get("players", []):
        for st in t.get("statistics", []):
            if st.get("name") not in ("passing", "rushing", "receiving"):
                continue
            keys = st.get("keys", [])
            for a in st.get("athletes", []):
                pid = a.get("athlete", {}).get("id")
                if not pid or not a.get("stats"):
                    continue
                v = lambda k: num(a["stats"][keys.index(k)]) if k in keys else 0.0  # noqa: E731
                r = lines.setdefault(pid, {k: 0.0 for k in STATS + ["td"]})
                if st["name"] == "passing":
                    r["cmp"] += v("completions/passingAttempts")
                    r["pyd"] += v("passingYards")
                    r["ptd"] += v("passingTouchdowns")
                elif st["name"] == "rushing":
                    r["car"] += v("rushingAttempts")
                    r["ryd"] += v("rushingYards")
                    r["td"] += v("rushingTouchdowns")
                else:
                    r["rec"] += v("receptions")
                    r["reyd"] += v("receivingYards")
                    r["td"] += v("receivingTouchdowns")
    for r in lines.values():
        r["rry"] = r["ryd"] + r["reyd"]
    season = h.get("season", {})
    return {
        "id": str(h.get("id") or os.path.basename(path).split(".")[0]),
        "date": comp.get("date", ""),
        "season": int(season.get("year", 0)),
        "stype": int(season.get("type", 2)),
        "lines": lines,
    }


def load_games() -> list[dict]:
    games = [g for g in (read_game(p) for p in glob.glob(os.path.join(RAW, "*.json.gz"))) if g]
    games.sort(key=lambda g: (g["date"], g["id"]))
    return games


def load_sims() -> dict:
    out = {}
    for s in (2025, 2026):
        p = os.path.join(DATA, f"sim_nfl_{s}.jsonl")
        if os.path.exists(p):
            for line in open(p):
                g = json.loads(line)
                out[g["id"]] = g
    return out


def load_logit() -> dict:
    out = {}
    if not os.path.exists(LOGIT):
        return out
    with open(LOGIT) as f:
        for r in csv.DictReader(f):
            if r["eligible"] != "1" or r["y"] == "":
                continue
            slug = LOGIT_MAP.get(r["market"])
            if slug:
                out[(r["event_id"], r["player_id"], slug)] = float(r["p"])
    return out


def main() -> None:
    markets = [m for m in json.load(open(os.path.join(DATA, "markets.json")))["nfl"] if m["idx"] is not None]
    markets = [m for m in markets if m["stat"] in STATS]
    sims = load_sims()
    logit = load_logit()
    games = load_games()
    print(f"nfl: {len(games)} finished games read, {len(sims)} simulated, {len(logit)} logistic predictions")

    # walk: as-of season averages
    cur: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    prev: dict[str, dict] = {}
    season_of: dict[str, int] = {}
    rows = []
    for g in games:
        if g["id"] in sims:
            sim = sims[g["id"]]
            for pid, sp in sim["players"].items():
                ln = g["lines"].get(pid)
                if ln is None:
                    continue  # did not appear: void
                last = season_of.get(pid)
                if last == g["season"]:
                    c, pv = cur[pid], prev.get(pid, {})
                elif last == g["season"] - 1:
                    c, pv = {}, cur[pid]
                else:
                    c, pv = {}, {}
                gp, pgp = c.get("gp", 0.0), pv.get("gp", 0.0)
                w = min(pgp, CARRY)
                mu = {}
                for s in STATS:
                    den = gp + w
                    mu[s] = ((c.get(s, 0.0)) + (pv.get(s, 0.0) / pgp * w if pgp else 0.0)) / den if den else 0.0
                rows.append({
                    "gid": g["id"], "date": g["date"][:10], "season": g["season"], "pid": pid,
                    "y": ln, "props": sp.get("props", {}), "mu": mu,
                })
        # fold in after predicting (regular season only, as the simulator's season does)
        if g["stype"] != 2:
            continue
        for pid, ln in g["lines"].items():
            if season_of.get(pid) != g["season"]:
                prev[pid] = dict(cur[pid]) if season_of.get(pid) == g["season"] - 1 else {}
                cur[pid] = defaultdict(float)
                season_of[pid] = g["season"]
            cur[pid]["gp"] += 1
            for s in STATS:
                cur[pid][s] += ln[s]

    print(f"  player-games with a simulation and an appearance: {len(rows)}")
    res = {"league": "nfl", "seasons": "2025 + 2026 to date", "markets": {}, "head_to_head": {}}
    cal_out = {}
    for m in markets:
        stat, idx, slug = m["stat"], m["idx"], m["slug"]
        R = [r for r in rows if stat in r["props"]]
        if len(R) < 200:
            continue
        y = np.array([1.0 if r["y"][stat] >= m["line"] else 0.0 for r in R])
        s = np.array([r["props"][stat]["over"][idx] for r in R])
        gids = [r["gid"] for r in R]
        dates = [r["date"] for r in R]
        folds = L.date_folds(dates)
        mu = np.array([r["mu"][stat] for r in R])
        yv = np.array([r["y"][stat] for r in R])
        avg = np.zeros(len(R))
        for f in np.unique(folds):
            tr, te = folds != f, folds == f
            phi = L.fit_phi(mu[tr], yv[tr])
            avg[te] = np.where(mu[te] > 0, L.nb_tail(mu[te], m["line"], phi), 0.0)
        P = {"sim": s, "sim_cal": L.crossfit_iso(s, y, folds), "avg": avg}
        qb = stat in ("pyd", "ptd", "cmp")
        out = {"label": m["label"], "key": m["key"], "slug": slug, "line": m["line"], "board": m["board"],
               # two quarterbacks a game: the top pick, not the top three
               "top_unit": "top1" if qb else "top3", "methods": {}}
        for k, p in P.items():
            out["methods"][k] = L.metrics(y, p, gids)
        out["chosen"] = L.choose(out["methods"])
        out["boot_simcal_vs_avg"] = L.paired_boot(y, P["sim_cal"], P["avg"], gids)
        res["markets"][slug] = out
        if out["chosen"] == "sim_cal":
            knots = L.iso().fit(s, y)
            cal_out[m["key"]] = {"x": knots.X_thresholds_.tolist(), "y": knots.y_thresholds_.tolist(), "n": len(y)}

        # head to head with the logistic model where it prices the line
        if slug in LOGIT_MAP.values():
            keep = [i for i, r in enumerate(R) if (r["gid"], r["pid"], slug) in logit]
            if len(keep) >= 200:
                k = np.array(keep)
                lp = np.array([logit[(R[i]["gid"], R[i]["pid"], slug)] for i in keep])
                hg = [gids[i] for i in keep]
                hh = {"n": len(keep), "methods": {
                    "model": L.metrics(y[k], lp, hg),
                    "sim": L.metrics(y[k], s[k], hg),
                    "sim_cal": L.metrics(y[k], P["sim_cal"][k], hg),
                    "avg": L.metrics(y[k], avg[k], hg),
                }}
                hh["chosen"] = out["chosen"]
                hh["boot_chosen_vs_model"] = L.paired_boot(y[k], P[out["chosen"]][k], lp, hg)
                res["head_to_head"][slug] = hh
        mt = out["methods"]
        line = f"  {m['label']:>28}  n {len(R):>5}  base {y.mean():.3f}"
        for k in ("sim", "sim_cal", "avg"):
            line += f"  {k} {mt[k]['brier']:.4f}/{mt[k]['auc']:.3f}"
        c = out["chosen"]
        th, ts = ("top1_hit", "top1_said") if qb else ("top_hit", "top_said")
        line += f"  [{c}] top{'1' if qb else '3'} {mt[c][th]:.3f} (said {mt[c][ts]:.3f})"
        if slug in res["head_to_head"]:
            h = res["head_to_head"][slug]
            b = h["boot_chosen_vs_model"]
            line += (f"  | vs model on {h['n']}: model {h['methods']['model']['brier']:.4f}/{h['methods']['model']['auc']:.3f}"
                     f" {c} {h['methods'][c]['brier']:.4f}/{h['methods'][c]['auc']:.3f}"
                     f" diff {b['diff']:+.4f} [{b['lo']:+.4f},{b['hi']:+.4f}]"
                     f" top{'1' if qb else '3'} model {h['methods']['model'][th]:.3f} {c} {h['methods'][c][th]:.3f}")
        print(line)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "nfl_props_backtest.json"), "w") as f:
        json.dump(res, f, indent=1)
    with open(os.path.join(DATA, "cal_nfl_props.json"), "w") as f:
        json.dump(cal_out, f)


if __name__ == "__main__":
    main()
