"""
Appendix: is the live site's way of computing the shipped model's features
costing accuracy, and does the hybrid still help on top of the research-style
features?

The shipped goal1 coefficients were fitted on research/soccer/props_soccer.py
features: player totals accumulated over every season since 2021-22, the
position and formation place of THIS match's lineup slot. The live site
(soccer-props.server.ts) folds this season only (last season too for the first
~2 matchdays) and uses the last-seen slot (often "SUB"). validate_model.py
scored the shipped coefficients on the research features; this script fits the
same hybrid stack on them (2024-25) and compares on 2025-26 rows where both
feature sets exist. Adds "appendix.research_style_hybrid" to results/backtest.json.

Usage: python3 research_hybrid.py   (after evaluate.py)
"""

import json
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from evaluate import LEAGUES, bootstrap, logit, metrics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RES = os.path.join(HERE, "results")


def main():
    C = pd.read_csv(os.path.join(DATA, "candidates.csv.gz"), keep_default_na=False, na_values=[""],
                    dtype={"matchId": str, "player_id": str, "team_id": str, "opp_id": str})
    C = C[C.league.isin(LEAGUES) & (C.mins > 0) & (C.gate_team == 1) & (C.gate_player == 1) & C.model_p.notna()]
    rs = pd.read_csv(os.path.join(DATA, "research_style_preds.csv.gz"), dtype={"matchId": str, "player_id": str})
    D = C.merge(rs[["matchId", "player_id", "model_p_research"]], on=["matchId", "player_id"], how="inner")
    D["sim"] = D.sim_on
    tp = pd.read_csv(os.path.join(RES, "test_predictions.csv.gz"), dtype={"matchId": str, "player_id": str})
    D = D.merge(tp[["matchId", "player_id", "hybrid", "gbm"]], on=["matchId", "player_id"], how="left")

    def X(df, col):
        return np.column_stack([logit(df[col]), logit(df.sim), np.log(df.lam_team), df.m_start])

    tr = D[D.season == 2024]
    hr = LogisticRegression(C=1e6, max_iter=5000).fit(X(tr, "model_p_research"), tr.y)
    T = D[D.season == 2025].copy()
    T["model"] = T.model_p
    T["model_research"] = T.model_p_research
    T["hybrid_research"] = hr.predict_proba(X(T, "model_p_research"))[:, 1]
    methods = ["model", "model_research", "sim", "hybrid", "hybrid_research", "gbm"]
    res = dict(n=int(len(T)), pooled={m: {k: v for k, v in metrics(T, m).items() if k != "calibration"}
                                      for m in methods},
               per_league={lg: {m: {k: v for k, v in metrics(T[T.league == lg], m).items() if k != "calibration"}
                                for m in methods} for lg in LEAGUES},
               hybrid_research_coef=dict(features=["logit_model_research", "logit_sim", "log_lam_team", "m_start"],
                                         coef=[float(c) for c in hr.coef_[0]], intercept=float(hr.intercept_[0])))
    best = min(methods, key=lambda m: res["pooled"][m]["logloss"])
    res["bootstrap"] = bootstrap(T, methods, best)
    res["bootstrap_model_research_vs_model"] = bootstrap(T, ["model", "model_research"], "model_research")
    bt = json.load(open(os.path.join(RES, "backtest.json")))
    bt["appendix"]["research_style_hybrid"] = res
    json.dump(bt, open(os.path.join(RES, "backtest.json"), "w"), indent=1)
    print(f"2025-26 rows with both feature sets: {len(T)}")
    for lg, blk in [("pooled", res["pooled"])] + list(res["per_league"].items()):
        print(lg, " ".join(f"{m}={blk[m]['logloss']:.5f}/{blk[m]['auc']:.4f}" for m in methods))
    for m, v in res["bootstrap"]["vs"].items():
        print(f"  {best} vs {m}: dLL {v['logloss']['diff']:+.5f} [{v['logloss']['lo']:+.5f}, {v['logloss']['hi']:+.5f}]"
              f"  dBrier {v['brier']['diff']:+.5f} [{v['brier']['lo']:+.5f}, {v['brier']['hi']:+.5f}]")
    v = res["bootstrap_model_research_vs_model"]["vs"]["model"]
    print(f"  model_research vs model(live): dLL {v['logloss']['diff']:+.5f} [{v['logloss']['lo']:+.5f}, "
          f"{v['logloss']['hi']:+.5f}]")


if __name__ == "__main__":
    main()
