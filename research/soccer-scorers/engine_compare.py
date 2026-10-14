"""
Compare the site's actual soccer engine (engine_check.ts, runBatch) with the
closed forms the backtest uses, on the 200 sampled 2025-26 fixtures
(data/engine_fixtures.json), for both share definitions (site / on-pitch) and
both markets (anytime / first goal), at 1,000 and 100,000 simulated matches
per fixture.

Closed forms, evaluated with exactly the shares the engine was given:
  anytime, DC      sum_g P_DC(G = g) [1 - (1 - s)^g]   (what the backtest uses)
  anytime, Poisson 1 - exp(-lam_team * s)
  first            lam_t / (lam_t + lam_o) * (1 - exp(-(lam_t + lam_o))) * s

Scored on the backtest's candidates inside those fixtures (domestic: gated
starters; Champions League: starters). Adds results under "engine_check" in
results/backtest.json (top level, and a copy under "first_goal").

Usage (after engine_check.ts has written data/engine_out/*):
    python3 engine_compare.py
"""

import glob
import json
import os

import numpy as np
import pandas as pd

from evaluate import LEAGUES, metrics
from features import goal_dist

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RES = os.path.join(HERE, "results")


def load_runs():
    runs = {}
    for fp in glob.glob(os.path.join(DATA, "engine_out", "*.json")):
        variant, n, _ = os.path.basename(fp)[:-5].split("_")
        runs.setdefault((variant, int(n)), {}).update(json.load(open(fp)))
    return runs


def main():
    fx = json.load(open(os.path.join(DATA, "engine_fixtures.json")))
    runs = load_runs()
    C = pd.read_csv(os.path.join(DATA, "candidates.csv.gz"), keep_default_na=False, na_values=[""],
                    dtype={"matchId": str, "player_id": str, "team_id": str, "opp_id": str})
    lab = pd.read_csv(os.path.join(DATA, "first_goal_labels.csv"), dtype={"matchId": str, "first_id": str},
                      keep_default_na=False)
    C = C[C.matchId.isin({f["matchId"] for f in fx}) & (C.mins > 0)].merge(lab, on="matchId", how="left")
    gate = (C.gate_team == 1) & (C.gate_player == 1) & C.model_p.notna()
    C = C[(C.league == "ucl") | (C.league.isin(LEAGUES) & gate)].copy()
    C["y_any"] = C.y
    C["y_first"] = (C.player_id == C.first_id).astype(int)

    share = {}
    for f in fx:
        for side in ("home", "away"):
            for v in ("site", "on"):
                for p in f[side][v]:
                    share[(f["matchId"], p["id"], v)] = p["share"]
    out = dict(fixtures=len(fx), candidates=int(len(C)), runs=sorted(f"{v}@{n}" for v, n in runs), anytime={},
               first_goal={}, goals={})
    for v in ("site", "on"):
        s = np.array([share[(m, p, v)] for m, p in zip(C.matchId, C.player_id)])
        lt, lo = C.lam_team.values, C.lam_opp.values
        cols = {}
        any_dc = []
        for r, sv in zip(C.itertuples(), s):
            gh, ga = goal_dist(*(r.lam_team, r.lam_opp) if r.is_home else (r.lam_opp, r.lam_team), r.rho)
            dist = gh if r.is_home else ga
            g = np.arange(len(dist))
            any_dc.append(float(np.sum(dist * (1 - (1 - sv) ** g))))
        cols["anytime_closed_dc"] = np.array(any_dc)
        cols["anytime_closed_poisson"] = 1 - np.exp(-lt * s)
        cols["first_closed"] = lt / (lt + lo) * (1 - np.exp(-(lt + lo))) * s
        for n in (1000, 100000):
            run = runs.get((v, n))
            if not run:
                continue
            cols[f"anytime_engine_{n}"] = np.array([run[m]["anytime"][p] for m, p in zip(C.matchId, C.player_id)])
            cols[f"first_engine_{n}"] = np.array([run[m]["first"][p] for m, p in zip(C.matchId, C.player_id)])
        D = C.assign(**cols)
        for market, ycol, keys in (("anytime", "y_any", [k for k in cols if k.startswith("anytime")]),
                                   ("first_goal", "y_first", [k for k in cols if k.startswith("first")])):
            E = D.assign(y=D[ycol])
            res = {}
            ref = keys[0]
            for k in keys:
                mt = metrics(E, k)
                res[k] = {q: mt[q] for q in ("n", "base", "mean_pred", "brier", "logloss", "auc", "ece",
                                              "top1_n", "top1_hit", "top1_pred")}
                res[k]["mean_abs_diff_vs_" + ref] = float(np.mean(np.abs(E[k] - E[ref])))
                res[k]["max_abs_diff_vs_" + ref] = float(np.max(np.abs(E[k] - E[ref])))
                res[k]["same_top1_as_" + ref] = float(
                    (E.loc[E.groupby("matchId")[k].idxmax(), "player_id"].values ==
                     E.loc[E.groupby("matchId")[ref].idxmax(), "player_id"].values).mean())
            out[market][v] = res
        # goals: engine mean vs model expectation
        for n in (1000, 100000):
            run = runs.get((v, n))
            if run:
                eh = np.mean([run[f["matchId"]]["homeGoals"] + run[f["matchId"]]["awayGoals"] for f in fx])
                out["goals"][f"{v}@{n}"] = float(eh)
    out["goals"]["model_expected"] = float(np.mean([f["home"]["rate"] + f["away"]["rate"] for f in fx]))
    bt_path = os.path.join(RES, "backtest.json")
    bt = json.load(open(bt_path))
    bt["engine_check"] = out
    bt.setdefault("first_goal", {})["engine_check"] = out
    json.dump(bt, open(bt_path, "w"), indent=1)

    for market in ("anytime", "first_goal"):
        for v in ("site", "on"):
            print(f"\n{market} / shares={v}")
            print(f"  {'method':26s} {'mean p':>7s} {'base':>6s} {'Brier':>8s} {'logloss':>8s} {'AUC':>7s} "
                  f"{'top1 hit/said':>14s} {'mean|d|':>8s} {'max|d|':>7s} {'same top1':>9s}")
            for k, r in out[market][v].items():
                ref = [q for q in r if q.startswith("mean_abs_diff")][0]
                mx = [q for q in r if q.startswith("max_abs_diff")][0]
                st = [q for q in r if q.startswith("same_top1")][0]
                print(f"  {k:26s} {r['mean_pred']:7.4f} {r['base']:6.4f} {r['brier']:8.5f} {r['logloss']:8.5f} "
                      f"{r['auc']:7.4f} {r['top1_hit']:.3f}/{r['top1_pred']:.3f} {r[ref]:8.5f} {r[mx]:7.4f} "
                      f"{r[st]:9.3f}")
    print("\nmean total goals per match:", out["goals"])


if __name__ == "__main__":
    main()
