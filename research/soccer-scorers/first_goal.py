"""
First goalscorer: who scores the match's first goal (regulation time incl.
stoppage; extra time excluded). An own goal as the first goal means no player
wins; 0-0 means nobody does. Same held-out matches and candidates as the
anytime backtest (evaluate.py): domestic starters who pass the live board's
gates, and Champions League starters.

Methods
  sim         the simulator's way, closed form:
                P(team scores first) = lam_t / (lam_t + lam_o) * (1 - exp(-(lam_t + lam_o)))
                P(player first)      = P(team scores first) * s
              with s the share of his team's goals that are his (own goals are
              the remaining 2.8%, so they are already removed). Two share
              definitions, as in the anytime backtest:
                sim_site_first  the site's shares (exactly the live engine)
                sim_first       per-on-pitch share x m_start (the anytime
                                backtest's chosen sim variant, sim_on)
  model_first the shipped domestic props model has no first-goal market, so
              its ANYTIME probability is converted: logistic regression on
              logit(model anytime p), logit(team xG share), ln(total xG),
              fitted on 2024-25
  hybrid_first logistic on logit(model anytime p), logit(sim_first),
              ln(team xG), ln(opponent xG), m_start, fitted on 2024-25
  ucl: sim variants + a sim stack (logit(sim_first), ln xG share, m_start)
       fitted on 2024-25 Champions League starters

Metrics: log loss, Brier (+ skill), AUC, ECE, calibration table, and the
per-match top-1 pick's hit rate vs its mean prediction; paired bootstrap over
matchdays for the differences to the best method.

Also writes data/engine_fixtures.json: a random sample of 2025-26 fixtures with
each side's expected goals and its starters' shares, for engine_check.ts.

Results go under the "first_goal" key of results/backtest.json (evaluate.py
must have run first) and into results/tables_first_goal.md.

Usage: python3 first_goal.py [--engine-sample 200]
"""

import argparse
import glob
import json
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from evaluate import EPS, LEAGUES, bootstrap, ll_vec, logit, metrics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RES = os.path.join(HERE, "results")
OWN_GOAL_SHARE = 0.028


def first_goal_labels():
    """matchId -> (first scorer id or '' , is_own_goal, minute, n regulation goals)."""
    out = []
    for fp in glob.glob(os.path.join(DATA, "raw", "*", "*.json")):
        d = json.load(open(fp))
        if not d.get("completed"):
            continue
        first = None
        n = 0
        for e in d["events"]:   # keyEvents are chronological
            if not e.get("scoring") or e.get("shootout") or (e.get("period") or 0) > 2:
                continue
            n += 1
            if first is None:
                first = e
        mid = os.path.basename(fp)[:-5]
        if first is None:
            out.append(dict(matchId=mid, first_id="", first_og=0, first_clock="", first_team="", reg_goals=0))
        else:
            og = int("own" in first["type"])
            out.append(dict(matchId=mid, first_id=(first["who"] or [""])[0] if not og else "", first_og=og,
                            first_clock=first.get("clock") or "", first_team=first.get("team") or "",
                            reg_goals=n))
    return pd.DataFrame(out)


def p_team_first(lt, lo):
    tot = lt + lo
    return lt / tot * (1 - np.exp(-tot))


def table(res, methods):
    lines = ["| league | method | n | base | Brier | BSS | log loss | AUC | ECE | top-1/match hit vs said |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for lg, block in [("pooled", res["pooled"])] + list(res["per_league"].items()):
        for m in methods:
            v = block[m]
            lines.append(f"| {lg} | {m} | {v['n']} | {v['base']:.4f} | {v['brier']:.5f} | {v['brier_skill']:+.4f} | "
                         f"{v['logloss']:.5f} | {v['auc']:.4f} | {v['ece']:.4f} | "
                         f"{v['top1_hit']:.3f} vs {v['top1_pred']:.3f} (n={v['top1_n']}) |")
    return "\n".join(lines)


def boot_table(res):
    lines = ["| league | best (log loss) | other | dBrier [95% CI] | dLogLoss [95% CI] |", "|---|---|---|---|---|"]
    for lg, b in [("pooled", res["bootstrap"]["pooled"])] + list(res["bootstrap"]["per_league"].items()):
        for m, v in b["vs"].items():
            lines.append(f"| {lg} | {b['best']} | {m} | {v['brier']['diff']:+.6f} [{v['brier']['lo']:+.6f}, "
                         f"{v['brier']['hi']:+.6f}] | {v['logloss']['diff']:+.5f} [{v['logloss']['lo']:+.5f}, "
                         f"{v['logloss']['hi']:+.5f}] |")
    return "\n".join(lines)


def evaluate(D, methods, label, tables):
    res = dict(pooled={m: metrics(D, m) for m in methods},
               per_league={lg: {m: metrics(D[D.league == lg], m) for m in methods}
                           for lg in sorted(D.league.unique(), key=lambda x: (LEAGUES + ["ucl"]).index(x))})
    best = min(methods, key=lambda m: res["pooled"][m]["logloss"])
    res["bootstrap"] = dict(pooled=bootstrap(D, methods, best),
                            per_league={lg: bootstrap(D[D.league == lg], methods, best) for lg in res["per_league"]})
    res["best_by_logloss"] = best
    res["best_by_logloss_per_league"] = {lg: min(methods, key=lambda m: v[m]["logloss"])
                                         for lg, v in res["per_league"].items()}
    for blk in [res["pooled"]] + list(res["per_league"].values()):   # top-5/day is not a first-goal board
        for v in blk.values():
            for k in ("top5_n", "top5_days", "top5_hit", "top5_pred"):
                v.pop(k, None)
    print(f"\n=== {label} ===\n" + table(res, methods))
    tables.append(f"### {label}\n\n" + table(res, methods) + "\n\n" + boot_table(res) + "\n")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-sample", type=int, default=200)
    args = ap.parse_args()

    lab = first_goal_labels()
    lab.to_csv(os.path.join(DATA, "first_goal_labels.csv"), index=False)
    C = pd.read_csv(os.path.join(DATA, "candidates.csv.gz"), keep_default_na=False, na_values=[""],
                    dtype={"matchId": str, "player_id": str, "team_id": str, "opp_id": str})
    C = C[C.mins > 0].merge(lab, on="matchId", how="left")
    assert C.first_id.notna().all()
    C["y_any"] = C.y
    C["y"] = (C.player_id == C.first_id.astype(str)).astype(int)
    # sanity: a first scorer must have scored in regulation
    bad = C[(C.y == 1) & (C.goals90 == 0)]
    print(f"first-goal labels: {len(lab)} matches; own-goal first {lab.first_og.mean():.3%}; "
          f"0-0 {(lab.reg_goals == 0).mean():.3%}; candidate first-scorers without a regulation goal: {len(bad)}")

    # ---- closed-form sim
    ptf = p_team_first(C.lam_team.values, C.lam_opp.values)
    C["p_team_first"] = ptf
    C["xg_share"] = C.lam_team / (C.lam_team + C.lam_opp)
    C["sim_site_first"] = ptf * C.s_site
    C["sim_first"] = ptf * np.minimum(C.s_on * C.m_start, 0.999)

    C["gate_live"] = ((C.gate_team == 1) & (C.gate_player == 1)).astype(int)
    dom = C[C.league.isin(LEAGUES) & (C.gate_live == 1) & C.model_p.notna() & C.sim_site.notna()].copy()
    ucl = C[(C.league == "ucl") & C.sim_site.notna()].copy()

    # ---- fitted converters / stacks (2024-25 only)
    def X_model(D):
        return np.column_stack([logit(D.model_p), logit(D.xg_share), np.log(D.lam_team + D.lam_opp)])

    def X_hyb(D):
        return np.column_stack([logit(D.model_p), logit(D.sim_first), np.log(D.lam_team), np.log(D.lam_opp),
                                D.m_start.values])

    def X_ucl(D):
        return np.column_stack([logit(D.sim_first), logit(D.xg_share), D.m_start.values])

    tr = dom[dom.season == 2024]
    mf = LogisticRegression(C=1e6, max_iter=5000).fit(X_model(tr), tr.y.values)
    hf = LogisticRegression(C=1e6, max_iter=5000).fit(X_hyb(tr), tr.y.values)
    dom["model_first"] = mf.predict_proba(X_model(dom))[:, 1]
    dom["hybrid_first"] = hf.predict_proba(X_hyb(dom))[:, 1]
    utr = ucl[ucl.season == 2024]
    us = LogisticRegression(C=1e6, max_iter=5000).fit(X_ucl(utr), utr.y.values)
    ucl["sim_stack_first"] = us.predict_proba(X_ucl(ucl))[:, 1]

    tables = []
    out = dict(
        definition=("first goal of the match in regulation time (incl. stoppage, extra time excluded); "
                    "own goal first or 0-0 -> no player wins"),
        population="same candidates as the anytime backtest",
        label_stats=dict(matches=int(len(lab)), own_goal_first=float(lab.first_og.mean()),
                         goalless=float((lab.reg_goals == 0).mean())),
        fitted=dict(
            model_first=dict(features=["logit_model_anytime_p", "logit_team_xg_share", "ln_total_xg"],
                             coef=[float(c) for c in mf.coef_[0]], intercept=float(mf.intercept_[0]),
                             fitted_on="2024-25 domestic candidates"),
            hybrid_first=dict(features=["logit_model_anytime_p", "logit_sim_first", "ln_lam_team", "ln_lam_opp",
                                        "m_start"], coef=[float(c) for c in hf.coef_[0]],
                              intercept=float(hf.intercept_[0]), fitted_on="2024-25 domestic candidates"),
            ucl_sim_stack_first=dict(features=["logit_sim_first", "logit_team_xg_share", "m_start"],
                                     coef=[float(c) for c in us.coef_[0]], intercept=float(us.intercept_[0]),
                                     fitted_on="2024-25 Champions League starters")),
        test={},
    )
    methods = ["model_first", "sim_first", "sim_site_first", "hybrid_first"]
    for S in (2025, 2026):
        out["test"][str(S)] = evaluate(dom[dom.season == S], methods,
                                       f"First goal, domestic {S}-{(S + 1) % 100:02d}", tables)
        out["test"][f"ucl_{S}"] = evaluate(ucl[ucl.season == S], ["sim_first", "sim_site_first", "sim_stack_first"],
                                           f"First goal, Champions League {S}-{(S + 1) % 100:02d}", tables)

    bt_path = os.path.join(RES, "backtest.json")
    bt = json.load(open(bt_path))
    if "first_goal" in bt and "engine_check" in bt["first_goal"]:
        out["engine_check"] = bt["first_goal"]["engine_check"]
    bt["first_goal"] = out
    json.dump(bt, open(bt_path, "w"), indent=1)
    with open(os.path.join(RES, "tables_first_goal.md"), "w") as f:
        f.write("\n".join(tables))

    # ---- fixtures for the engine check: a random sample of 2025-26 fixtures
    T = pd.concat([dom[dom.season == 2025], ucl[ucl.season == 2025]])
    allst = C[C.matchId.isin(set(T.matchId))]   # every starter of those fixtures (for the shares)
    rng = np.random.default_rng(7)
    mids = rng.choice(np.array(sorted(set(T.matchId))), size=min(args.engine_sample, T.matchId.nunique()),
                      replace=False)
    fx = []
    for mid in mids:
        g = allst[allst.matchId == mid]
        sides = {}
        for tid, gg in g.groupby("team_id"):
            home = int(gg.is_home.iloc[0])
            site = [dict(id=r.player_id, share=float(r.s_site)) for r in gg.itertuples()]
            on = np.minimum(gg.s_on.values * gg.m_start.values, 0.999)
            scale = min(1.0, (1 - OWN_GOAL_SHARE) / on.sum())
            sides["home" if home else "away"] = dict(
                team=tid, rate=float(gg.lam_team.iloc[0]),
                site=site, on=[dict(id=r.player_id, share=float(v * scale)) for r, v in zip(gg.itertuples(), on)],
                on_scaled=bool(scale < 1.0))
        if len(sides) == 2:
            fx.append(dict(matchId=str(mid), league=g.league.iloc[0], **sides))
    json.dump(fx, open(os.path.join(DATA, "engine_fixtures.json"), "w"))
    print(f"\nengine fixtures written: {len(fx)} "
          f"({sum(f['home']['on_scaled'] or f['away']['on_scaled'] for f in fx)} with on-pitch shares scaled to 0.972)")


if __name__ == "__main__":
    main()
