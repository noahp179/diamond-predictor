"""
Score the methods on identical held-out matches and identical candidates.

Population (domestic): every player who STARTED the match, played > 0 minutes,
and passes the live board's own gates (>= 3 match-day squads this season form,
start rate >= 0.5, latest team = this team, both teams >= 3 games) -- so the
shipped model has a price for every candidate and nobody is priced by one method
and not another. Counts of starters dropped by the gates are reported.

Splits: fit anything on 2024-25 (and earlier); test on 2025-26 (all of it) and,
separately, 2026-27 to date.

Methods
  model    shipped goal1 logistic, live-site features (features.py)
  sim      closed-form simulator P = sum_g P(G=g) [1 - (1 - s*m)^g]. Four
           variants are computed; the one with the best 2024-25 log loss is
           the "sim" of the main table (chosen BEFORE looking at 2025-26):
             sim_site    the site's shares, m = 1 (exactly the live engine)
             sim_site_m  the site's shares x m_start (the formula taken literally)
             sim_on      per-on-pitch share x m_start
             sim_xi      the site's shares rescaled over the announced XI
  hybrid   logistic stack of logit(model), logit(sim), log team xG, m_start,
           fitted on 2024-25
  gbm      our own HistGradientBoosting on the as-of features (model features
           + sim inputs), trained on 2022-23..2024-25 (iterations picked on
           2024-25 with 2022-24 training), tested on 2025-26
  Champions League (no props model exists): the sim variants, a sim stack
  (logit(sim), log xG, m_start, fitted on 2024-25 UCL) and gbm_lite (the GBM
  without the domestic model's features, trained on domestic + UCL <= 2024-25).

Metrics per league and pooled: n, base rate, Brier, Brier skill vs the base
rate, log loss, AUC, ECE (10 equal-count bins) with the calibration table, the
per-match top-1 pick's hit rate vs its mean prediction, and the per-matchday
(league, calendar date) top-5 hit rate vs mean prediction. Paired bootstrap
(2,000 resamples of matchdays) for the Brier and log-loss differences between
the best method and each other.

Writes results/backtest.json, results/tables.md and results/test_predictions.csv.gz
(first-goal results are added by first_goal.py).

Usage: python3 evaluate.py
"""

import json
import os

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RES = os.path.join(HERE, "results")
LEAGUES = ["epl", "laliga", "bundesliga", "seriea", "ligue1"]
SIM_VARIANTS = ["sim_site", "sim_site_m", "sim_on", "sim_xi"]
RNG = np.random.default_rng(20261014)
B = 2000
EPS = 1e-6


def logit(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def ll_vec(y, p):
    p = np.clip(p, EPS, 1 - EPS)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


# ------------------------------------------------------------------ metrics

def calib_table(y, p, bins=10):
    order = np.argsort(p, kind="stable")
    parts = np.array_split(order, bins)
    rows = [dict(n=int(len(ix)), p_lo=float(p[ix].min()), p_hi=float(p[ix].max()),
                 mean_p=float(p[ix].mean()), hit=float(y[ix].mean())) for ix in parts if len(ix)]
    ece = sum(r["n"] * abs(r["mean_p"] - r["hit"]) for r in rows) / len(y)
    return rows, float(ece)


def board(df, pcol):
    t1 = df.loc[df.groupby("matchId")[pcol].idxmax()]
    t5 = (df.sort_values(pcol, ascending=False, kind="stable")
          .groupby(["league", "date"], sort=False).head(5))
    return dict(top1_n=int(len(t1)), top1_hit=float(t1.y.mean()), top1_pred=float(t1[pcol].mean()),
                top5_n=int(len(t5)), top5_days=int(t5.groupby(["league", "date"]).ngroups),
                top5_hit=float(t5.y.mean()), top5_pred=float(t5[pcol].mean()))


def metrics(df, pcol):
    y = df.y.values.astype(float)
    p = np.clip(df[pcol].values.astype(float), EPS, 1 - EPS)
    base = y.mean()
    brier = float(np.mean((p - y) ** 2))
    brier_ref = float(base * (1 - base))
    cal, ece = calib_table(y, p)
    out = dict(n=int(len(y)), matches=int(df.matchId.nunique()), base=float(base), mean_pred=float(p.mean()),
               brier=brier, brier_skill=float(1 - brier / brier_ref), logloss=float(ll_vec(y, p).mean()),
               logloss_ref=float(ll_vec(y, np.full_like(p, base)).mean()),
               auc=float(roc_auc_score(y, p)), ece=ece, calibration=cal)
    out.update(board(df, pcol))
    return out


def bootstrap(df, methods, best):
    """Paired bootstrap over matchdays (league, date): CI of (method - best)."""
    keys = df.league + "|" + df.date
    codes, uniq = pd.factorize(keys)
    K = len(uniq)
    n = np.bincount(codes, minlength=K).astype(float)
    y = df.y.values.astype(float)
    sums = {}
    for m in methods:
        p = np.clip(df[m].values.astype(float), EPS, 1 - EPS)
        sums[m] = (np.bincount(codes, (p - y) ** 2, K), np.bincount(codes, ll_vec(y, p), K))
    idx = RNG.integers(0, K, size=(B, K))
    cnt = np.zeros((B, K))
    np.add.at(cnt, (np.repeat(np.arange(B), K), idx.ravel()), 1)
    N = cnt @ n
    out = {}
    for m in methods:
        if m == best:
            continue
        rec = {}
        for j, name in enumerate(("brier", "logloss")):
            d_full = (sums[m][j].sum() - sums[best][j].sum()) / n.sum()
            d = (cnt @ (sums[m][j] - sums[best][j])) / N
            rec[name] = dict(diff=float(d_full), lo=float(np.percentile(d, 2.5)), hi=float(np.percentile(d, 97.5)),
                             p_best_better=float((d > 0).mean()))
        out[m] = rec
    return dict(best=best, matchdays=int(K), resamples=B, vs=out)


# ---------------------------------------------------------------- models

GBM_EXTRA = ["s_site", "s_on", "s_xi", "m_start", "lam_team", "lam_opp", "p_team_scores", "pen_share",
             "g90_rate", "sh90_rate", "sot90_rate", "starts_n", "is_home", "formation_place",
             "pos_F", "pos_M", "pos_D", "pos_G", "team_goals_w", "raw_goals_w"]
GBM_LITE = ["s_site", "s_on", "s_xi", "m_start", "lam_team", "lam_opp", "p_team_scores", "pen_share",
            "g90_rate", "sh90_rate", "sot90_rate", "starts_n", "is_home", "formation_place",
            "pos_F", "pos_M", "pos_D", "pos_G", "is_ucl"]


def gbm(max_iter):
    return HistGradientBoostingClassifier(learning_rate=0.04, max_iter=max_iter, max_leaf_nodes=15,
                                          min_samples_leaf=200, l2_regularization=1.0, random_state=0)


def fit_gbm(train, valid, cols):
    """Pick the number of trees on `valid` (log loss), then refit on train+valid."""
    est = gbm(400).fit(train[cols].values, train.y.values)
    best_ll, best_it = 9, 50
    for it, p in enumerate(est.staged_predict_proba(valid[cols].values), 1):
        if it % 10 == 0:
            ll = ll_vec(valid.y.values, p[:, 1]).mean()
            if ll < best_ll:
                best_ll, best_it = ll, it
    both = pd.concat([train, valid])
    return gbm(best_it).fit(both[cols].values, both.y.values), best_it, float(best_ll)


def stack_design(df, sim_col, with_model=True):
    cols = []
    if with_model:
        cols.append(logit(df.model_p))
    cols += [logit(df[sim_col]), np.log(df.lam_team.values), df.m_start.values]
    return np.column_stack(cols)


def main():
    os.makedirs(RES, exist_ok=True)
    C = pd.read_csv(os.path.join(DATA, "candidates.csv.gz"), keep_default_na=False, na_values=[""],
                    dtype={"matchId": str, "player_id": str, "team_id": str, "opp_id": str})
    for L in ("F", "M", "D", "G"):
        C[f"pos_{L}"] = (C.pos_letter == L).astype(float)
    C["is_ucl"] = (C.comp == "uefa.champions").astype(float)
    C["gate_live"] = ((C.gate_team == 1) & (C.gate_player == 1)).astype(int)
    starters = C[(C.mins > 0)]
    dom_all = starters[starters.league.isin(LEAGUES)]
    dom = dom_all[(dom_all.gate_live == 1) & dom_all.model_p.notna() & dom_all.sim_site.notna()].copy()
    ucl = starters[(starters.league == "ucl") & starters.sim_site.notna()].copy()

    counts = {}
    for S in (2024, 2025, 2026):
        a = dom_all[dom_all.season == S]
        b = dom[dom.season == S]
        counts[str(S)] = dict(starters=int(len(a)), candidates=int(len(b)), dropped_by_gates=int(len(a) - len(b)),
                              matches=int(b.matchId.nunique()),
                              per_league={lg: int((b.league == lg).sum()) for lg in LEAGUES})
    counts["ucl"] = {str(S): int((ucl.season == S).sum()) for S in (2024, 2025, 2026)}
    print(json.dumps(counts, indent=1))

    # ---------------- 1. choose the sim variant on 2024-25 (never on the test season)
    tr = dom[dom.season == 2024]
    sel = {v: dict(logloss=float(ll_vec(tr.y.values, np.clip(tr[v].values, EPS, 1 - EPS)).mean()),
                   brier=float(np.mean((tr[v].values - tr.y.values) ** 2)),
                   auc=float(roc_auc_score(tr.y, tr[v])), mean_pred=float(tr[v].mean()), base=float(tr.y.mean()))
           for v in SIM_VARIANTS}
    sim_choice = min(sel, key=lambda v: sel[v]["logloss"])
    print("sim variant selection on 2024-25:", {k: round(v["logloss"], 5) for k, v in sel.items()}, "->", sim_choice)
    for D in (dom, ucl):
        D["sim"] = D[sim_choice]
    tr = dom[dom.season == 2024]

    # ---------------- 2. hybrid: stack on 2024-25
    Xtr = stack_design(tr, "sim")
    hyb = LogisticRegression(C=1e6, max_iter=5000).fit(Xtr, tr.y.values)
    hyb_names = ["logit_model", "logit_sim", "log_lam_team", "m_start"]
    # league-intercept variant, compared by 5-fold CV over 2024-25 matchdays
    from sklearn.model_selection import GroupKFold
    groups = pd.factorize(tr.league + tr.date)[0]
    Lt = pd.get_dummies(tr.league).reindex(columns=LEAGUES, fill_value=0).values.astype(float)
    cv = {"pooled": [], "league_intercepts": []}
    for a, b in GroupKFold(5).split(Xtr, tr.y.values, groups):
        for name, X in (("pooled", Xtr), ("league_intercepts", np.column_stack([Xtr, Lt[:, 1:]]))):
            mdl = LogisticRegression(C=1e6, max_iter=5000).fit(X[a], tr.y.values[a])
            cv[name].append(ll_vec(tr.y.values[b], mdl.predict_proba(X[b])[:, 1]).mean())
    cv = {k: float(np.mean(v)) for k, v in cv.items()}
    print("hybrid CV log loss on 2024-25:", cv)
    if cv["league_intercepts"] < cv["pooled"] - 1e-5:
        hyb = LogisticRegression(C=1e6, max_iter=5000).fit(np.column_stack([Xtr, Lt[:, 1:]]), tr.y.values)
        hyb_names += [f"league_{lg}" for lg in LEAGUES[1:]]
        hyb_league = True
    else:
        hyb_league = False

    def hyb_pred(D):
        X = stack_design(D, "sim")
        if hyb_league:
            Ld = pd.get_dummies(D.league).reindex(columns=LEAGUES, fill_value=0).values.astype(float)
            X = np.column_stack([X, Ld[:, 1:]])
        return hyb.predict_proba(X)[:, 1]

    dom["hybrid"] = hyb_pred(dom)

    # ---------------- 3. own GBM (train 2022-24, trees picked on 2024 with 2022-23 training)
    fcols = [c for c in dom.columns if c.startswith("f_")] + GBM_EXTRA
    est, n_iter, vll = fit_gbm(dom[dom.season.isin([2022, 2023])], dom[dom.season == 2024], fcols)
    dom["gbm"] = est.predict_proba(dom[fcols].values)[:, 1]
    print(f"gbm: {n_iter} trees (2024-25 log loss {vll:.5f} when trained on 2022-24)")
    # gbm_lite: no domestic-model features; trained on domestic + UCL <= 2024-25
    lite_pool = pd.concat([dom, ucl])
    est_l, n_iter_l, vll_l = fit_gbm(lite_pool[lite_pool.season.isin([2022, 2023])],
                                     lite_pool[lite_pool.season == 2024], GBM_LITE)
    dom["gbm_lite"] = est_l.predict_proba(dom[GBM_LITE].values)[:, 1]
    ucl["gbm_lite"] = est_l.predict_proba(ucl[GBM_LITE].values)[:, 1]
    print(f"gbm_lite: {n_iter_l} trees")

    # ---------------- 4. UCL sim stack (fit on 2024-25 UCL)
    utr = ucl[ucl.season == 2024]
    ust = LogisticRegression(C=1e6, max_iter=5000).fit(stack_design(utr, "sim", False), utr.y.values)
    ucl["sim_stack"] = ust.predict_proba(stack_design(ucl, "sim", False))[:, 1]

    # ---------------- 5. research-style model on its own rows (a check, not in the main table)
    rs = pd.read_csv(os.path.join(DATA, "research_style_preds.csv.gz"), dtype={"matchId": str, "player_id": str})
    rs["matchId"] = rs.matchId.astype(str)
    dom = dom.merge(rs[["matchId", "player_id", "model_p_research"]], on=["matchId", "player_id"], how="left")

    # ---------------- evaluate
    main_methods = ["model", "sim", "hybrid", "gbm"]
    dom["model"] = dom.model_p
    extra = SIM_VARIANTS + ["gbm_lite"]
    results = dict(test={}, appendix={})
    tables = []

    def evaluate(D, methods, label):
        res = dict(pooled={m: metrics(D, m) for m in methods},
                   per_league={lg: {m: metrics(D[D.league == lg], m) for m in methods}
                               for lg in sorted(D.league.unique(), key=lambda x: (LEAGUES + ["ucl"]).index(x))})
        best = min(methods, key=lambda m: res["pooled"][m]["logloss"])
        res["bootstrap"] = dict(pooled=bootstrap(D, methods, best),
                                per_league={lg: bootstrap(D[D.league == lg], methods, best)
                                            for lg in res["per_league"]})
        res["best_by_logloss"] = best
        res["best_by_logloss_per_league"] = {lg: min(methods, key=lambda m: v[m]["logloss"])
                                             for lg, v in res["per_league"].items()}
        print(f"\n=== {label} ===")
        print(table(res, methods))
        tables.append(f"### {label}\n\n" + table(res, methods) + "\n\n" + boot_table(res, methods) + "\n")
        return res

    for S in (2025, 2026):
        D = dom[dom.season == S]
        results["test"][str(S)] = evaluate(D, main_methods, f"Domestic {S}-{(S + 1) % 100:02d}: main methods")
        # the brief's three methods only (our GBM left out), so model vs sim vs hybrid has its own CIs
        core = ["model", "sim", "hybrid"]
        r = results["test"][str(S)]
        cbest = min(core, key=lambda m: r["pooled"][m]["logloss"])
        r["bootstrap_core"] = dict(pooled=bootstrap(D, core, cbest),
                                   per_league={lg: bootstrap(D[D.league == lg], core,
                                                             min(core, key=lambda m: r["per_league"][lg][m]["logloss"]))
                                               for lg in r["per_league"]})
        tables.append(f"#### {S}-{(S + 1) % 100:02d}: model vs sim vs hybrid only (each league's best of the three "
                      "as the reference)\n\n" + boot_table(dict(bootstrap=r["bootstrap_core"]), core) + "\n")
        print(tables[-1])
        results["appendix"][f"variants_{S}"] = evaluate(D, main_methods + extra,
                                                        f"Domestic {S}-{(S + 1) % 100:02d}: all variants")
        U = ucl[ucl.season == S]
        results["test"][f"ucl_{S}"] = evaluate(U, SIM_VARIANTS + ["sim_stack", "gbm_lite"],
                                               f"Champions League {S}-{(S + 1) % 100:02d}")
    # research-style model check on its own population
    R = dom[(dom.season == 2025) & dom.model_p_research.notna()].copy()
    R["model_research"] = R.model_p_research
    results["appendix"]["research_style_2025"] = dict(
        pooled={m: metrics(R, m) for m in ("model", "model_research", "sim", "hybrid", "gbm")},
        note="rows where research/soccer/props_soccer.py build() also produces a row")
    print("\nresearch-style vs live-style model on shared rows (2025-26):")
    for m in ("model", "model_research"):
        v = results["appendix"]["research_style_2025"]["pooled"][m]
        print(f"  {m:15s} n={v['n']} ll={v['logloss']:.5f} auc={v['auc']:.4f} ece={v['ece']:.4f}")

    # also: hybrid / sim / model on 2024-25 (the training season of the stack: in-sample for it)
    results["appendix"]["season_2024_in_sample_for_hybrid"] = {
        m: {k: v for k, v in metrics(tr.assign(hybrid=hyb_pred(tr), model=tr.model_p), m).items()
            if k != "calibration"} for m in ("model", "sim", "hybrid")}

    # ---------------- shipping constants
    fc = json.load(open(os.path.join(DATA, "feature_constants.json")))
    results["meta"] = dict(
        generated=pd.Timestamp.now("UTC").isoformat(),
        population=("starters with > 0 minutes who pass the live board's gates: >= 3 match-day squads "
                    "in the live season form, start rate >= 0.5, latest team = this team, both teams >= 3 games"),
        outcome="1+ non-own goal in regulation time (incl. stoppage; extra time excluded)",
        counts=counts, sim_choice=sim_choice, sim_selection_2024=sel,
        hybrid_cv_2024=cv, hybrid_league_intercepts=hyb_league,
        gbm=dict(trees=n_iter, valid_logloss_2024=vll, features=fcols),
        gbm_lite=dict(trees=n_iter_l, valid_logloss_2024=vll_l, features=GBM_LITE),
    )
    results["ship"] = dict(
        hybrid=dict(features=hyb_names, coef=[float(c) for c in hyb.coef_[0]], intercept=float(hyb.intercept_[0]),
                    fitted_on="2024-25 domestic candidates", n=int(len(tr)),
                    formula="p = sigmoid(intercept + sum(coef_i * x_i)); x = [logit(model goal1 p), "
                            "logit(sim p), ln(team expected goals), m_start]"),
        sim=dict(variant=sim_choice, own_goal_share=0.028, shrink_k=6.0, half_life_days=180, window_days=400,
                 site_position_prior=dict(F=0.10, M=0.035, D=0.012, G=0.0, unknown=0.02),
                 on_pitch_position_prior=fc["prior_on"], m_start_prior=fc["m_bar"], m_start_prior_all=fc["m_bar_all"],
                 m_start_shrink_starts=2.0, xi_target=fc["xi_target"],
                 minute_weights="src/lib/ucl-sim.json buckets (45' and 90' carry stoppage time)",
                 team_goals=("cross-league Elo (research/ucl tuned_params.json) -> per-league Poisson GLM on "
                             "gap/400, 5 previous seasons, + Dixon-Coles rho"),
                 goal_fits={k: v for k, v in fc["goal_fits"].items() if k.endswith(":2025") or k.endswith(":2026")}),
        ucl_sim_stack=dict(features=["logit_sim", "log_lam_team", "m_start"], coef=[float(c) for c in ust.coef_[0]],
                           intercept=float(ust.intercept_[0]), fitted_on="2024-25 Champions League starters"),
    )
    with open(os.path.join(RES, "backtest.json"), "w") as f:
        json.dump(results, f, indent=1)
    with open(os.path.join(RES, "tables.md"), "w") as f:
        f.write("\n".join(tables))
    keep = ["matchId", "league", "season", "date", "team_id", "player_id", "name", "pos_letter", "y",
            "model", "sim", "hybrid", "gbm", "gbm_lite"] + SIM_VARIANTS + ["lam_team", "s_site", "s_on", "m_start"]
    pd.concat([dom[dom.season >= 2025][keep],
               ucl[ucl.season >= 2025].assign(model=np.nan, hybrid=np.nan, gbm=np.nan)[keep]]).to_csv(
        os.path.join(RES, "test_predictions.csv.gz"), index=False, compression="gzip")



def table(res, methods):
    lines = ["| league | method | n | base | Brier | BSS | log loss | AUC | ECE | top-1/match hit vs said "
             "| top-5/day hit vs said |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for lg, block in [("pooled", res["pooled"])] + list(res["per_league"].items()):
        for m in methods:
            v = block[m]
            lines.append(f"| {lg} | {m} | {v['n']} | {v['base']:.4f} | {v['brier']:.5f} | {v['brier_skill']:+.4f} | "
                         f"{v['logloss']:.5f} | {v['auc']:.4f} | {v['ece']:.4f} | "
                         f"{v['top1_hit']:.3f} vs {v['top1_pred']:.3f} (n={v['top1_n']}) | "
                         f"{v['top5_hit']:.3f} vs {v['top5_pred']:.3f} (n={v['top5_n']}) |")
    return "\n".join(lines)


def boot_table(res, methods):
    lines = ["| league | best (log loss) | other | dBrier (other - best) [95% CI] | dLogLoss (other - best) [95% CI] |",
             "|---|---|---|---|---|"]
    for lg, b in [("pooled", res["bootstrap"]["pooled"])] + list(res["bootstrap"]["per_league"].items()):
        for m, v in b["vs"].items():
            lines.append(f"| {lg} | {b['best']} | {m} | {v['brier']['diff']:+.5f} [{v['brier']['lo']:+.5f}, "
                         f"{v['brier']['hi']:+.5f}] | {v['logloss']['diff']:+.5f} [{v['logloss']['lo']:+.5f}, "
                         f"{v['logloss']['hi']:+.5f}] |")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
