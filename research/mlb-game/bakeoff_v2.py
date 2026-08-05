"""
MLB game-outcome bake-off, round 2 — fresh data, the shipped model as the
benchmark, and a real aggregation family.

What changed vs bakeoff_mlb.py (MLB-GAME-OUTCOME-BAKEOFF.md):
  * Data now runs 2021 -> 2026-08-04 (13,877 games). Calibrate on 2021-2025,
    test on the 2026 season the models have never seen.
  * The **shipped** rating is in the race. `src/lib/mlb-sim.ts` ships
    `sim-elo-v2` = logit-average of a Monte-Carlo lineup sim and a 538-style
    margin-of-victory Elo (K=6, home=+24, carry=0.75). The Elo half is replayed
    here exactly, constant for constant, as `SHIPPED_elo_v2`.
  * Fifteen aggregation strategies, because averaging models is the one thing
    the last bake-off barely tried (it had two hand-picked blends).

Every base model is mapped to a probability by a 1-D logistic fit on the
calibration seasons only. Aggregation weights are fit the same way, on
season-wise out-of-fold probabilities, so no test information reaches them.

Usage: python3 bakeoff_v2.py
"""

import math
import os
import warnings

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

import bakeoff_mlb as B

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

CALIB_SEASONS = [2021, 2022, 2023, 2024, 2025]
TEST_SEASON = 2026
# Headline evaluation: every season from 2023 on gets its turn as the test set,
# calibrated only on the seasons before it. One season is ~1,700 games and an
# AUC noise band of +-0.014 — wide enough that a leaderboard built on it is
# mostly luck (the 2024 board had elo_plus_pitcher 1st; on 2026 it is 26th).
# Pooling four walk-forward seasons roughly halves that band.
ROLLING_TEST_SEASONS = [2023, 2024, 2025, 2026]

# Constants copied from src/lib/mlb-sim.ts — keep in sync.
ELO_K, ELO_HOME, ELO_CARRY = 6.0, 24.0, 0.75


# --------------------------------------------------------------- shipped Elo
def shipped_elo_probs(df):
    """Replay the app's Elo exactly (mlb-sim.ts computeElo/eloWinProb).

    Emits the pre-game home win probability for every row, then updates — so
    each number is what the app would have shown that morning.
    """
    elo = {}
    out = np.empty(len(df))
    season = None
    for i, g in enumerate(df.itertuples()):
        if g.season != season:
            if season is not None:
                for t in elo:
                    elo[t] = 1500 + ELO_CARRY * (elo[t] - 1500)
            season = g.season
        rh, ra = elo.get(g.home, 1500.0), elo.get(g.away, 1500.0)
        out[i] = 1 / (1 + 10 ** (-(rh + ELO_HOME - ra) / 400))
        home_won = 1 if g.home_score > g.away_score else 0
        expected = out[i]
        margin = abs(g.home_score - g.away_score)
        elo_diff = (rh + ELO_HOME - ra) * (1 if home_won else -1)
        mov = (margin + 1) ** 0.7 / (7.5 + 0.006 * elo_diff)
        delta = ELO_K * mov * (home_won - expected)
        elo[g.home] = rh + delta
        elo[g.away] = ra - delta
    return out


# ------------------------------------------------------------------ helpers
def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def oof_platt(sig_tr, y_tr, seasons_tr, sig_te):
    """Season-wise out-of-fold calibration.

    Returns (train probabilities, test probabilities). Each train season is
    calibrated by a fit on the *other* train seasons, so stacking weights never
    see a probability that was fit on its own label.
    """
    tr_p = np.empty(len(sig_tr))
    for s in np.unique(seasons_tr):
        m = seasons_tr == s
        tr_p[m] = B.platt(sig_tr[~m], y_tr[~m], sig_tr[m])
    return tr_p, B.platt(sig_tr, y_tr, sig_te)


def bootstrap_delta(y, p_a, p_b, n=2000, seed=0):
    """95% CI on the AUC difference (a - b), paired over games."""
    rng = np.random.default_rng(seed)
    idx = np.arange(len(y))
    d = np.empty(n)
    for i in range(n):
        s = rng.choice(idx, len(idx), replace=True)
        if y[s].sum() in (0, len(s)):
            d[i] = 0.0
            continue
        d[i] = B.auc(y[s], p_a[s]) - B.auc(y[s], p_b[s])
    return float(np.mean(d)), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))


# ------------------------------------------------------------- one test season
def evaluate_season(sigs, feats, test_season):
    """Calibrate on every season before `test_season`, score that season.

    Returns (test probabilities per model, test labels). Nothing from the test
    season touches a calibration fit, a stacking weight or a model selection.
    """
    calib = [s for s in sorted(sigs.season.unique()) if s < test_season]
    tr_m = sigs.season.isin(calib).values
    te_m = (sigs.season == test_season).values
    ytr, yte = sigs.home_win.values[tr_m], sigs.home_win.values[te_m]
    seasons_tr = sigs.season.values[tr_m]
    results = []
    print(f"\n--- test {test_season}: calibrate on {calib} "
          f"({tr_m.sum():,} games) -> {te_m.sum():,} games ---", flush=True)

    # ---------- base models: every raw signal, calibrated ----------
    P_tr, P_te = {}, {}
    skip = {"gamePk", "season", "date", "home_win", "home_only_edge", "always_home"}
    for col in sigs.columns:
        if col in skip:
            continue
        s = sigs[col].values.astype(float)
        a, b = oof_platt(s[tr_m], ytr, seasons_tr, s[te_m])
        name = "SHIPPED_elo_v2" if col == "shipped_elo" else col
        P_tr[name], P_te[name] = a, b
        results.append(B.score(name, yte, b))

    # ---------- machine learning on the pooled feature vector ----------
    FEATS = [c for c in feats.columns if c not in ("gamePk", "season", "home_win")]
    ftr, fte = feats[feats.season.isin(calib)], feats[feats.season == test_season]
    Xtr, Xte, ytr2 = ftr[FEATS].values, fte[FEATS].values, ftr.home_win.values
    from sklearn.ensemble import (ExtraTreesClassifier, HistGradientBoostingClassifier,
                                  RandomForestClassifier)
    from sklearn.neural_network import MLPClassifier
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from lightgbm import LGBMClassifier
    from xgboost import XGBClassifier

    ml = {
        "ML_logistic": make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)),
        "ML_random_forest": RandomForestClassifier(n_estimators=400, min_samples_leaf=40,
                                                   n_jobs=-1, random_state=0),
        "ML_extra_trees": ExtraTreesClassifier(n_estimators=400, min_samples_leaf=40,
                                               n_jobs=-1, random_state=0),
        "ML_hist_gbm": HistGradientBoostingClassifier(random_state=0, learning_rate=0.04,
                                                      max_iter=400, max_leaf_nodes=12,
                                                      l2_regularization=2.0, early_stopping=True,
                                                      validation_fraction=0.15),
        "ML_xgboost": XGBClassifier(n_estimators=350, max_depth=3, learning_rate=0.04,
                                    subsample=0.8, colsample_bytree=0.8, reg_lambda=3.0,
                                    eval_metric="logloss", verbosity=0),
        "ML_lightgbm": LGBMClassifier(n_estimators=400, num_leaves=12, learning_rate=0.04,
                                      subsample=0.8, colsample_bytree=0.8, reg_lambda=3.0,
                                      verbose=-1),
        "ML_neural_net": make_pipeline(StandardScaler(),
                                       MLPClassifier((24,), alpha=1e-1, max_iter=1500,
                                                     early_stopping=True, random_state=0)),
    }
    from sklearn.base import clone
    season_tr_ml = ftr.season.values
    for name, est in ml.items():
        try:
            oof = np.empty(len(Xtr))
            for s in np.unique(season_tr_ml):     # season-wise OOF, same rule as above
                m = season_tr_ml == s
                oof[m] = clone(est).fit(Xtr[~m], ytr2[~m]).predict_proba(Xtr[m])[:, 1]
            est.fit(Xtr, ytr2)
            p = est.predict_proba(Xte)[:, 1]
            P_tr[name], P_te[name] = oof, p
            results.append(B.score(name, yte, p))
        except Exception as e:
            print(f"  {name} failed: {str(e)[:70]}")

    # ---------- the aggregation family ----------
    # Rank candidates by calibration-season log loss; several aggregators only
    # take the best k, and all weights come from the OOF train probabilities.
    names = [n for n in P_tr if not n.startswith("AGG_")]
    ll_tr = {n: B.score(n, ytr, P_tr[n])["logloss"] for n in names}
    ranked = sorted(names, key=lambda n: ll_tr[n])
    print("  best 4 on the calibration seasons:",
          ", ".join(f"{n} {ll_tr[n]:.4f}" for n in ranked[:4]), flush=True)

    def stack(cols):
        return np.column_stack([P_tr[c] for c in cols]), np.column_stack([P_te[c] for c in cols])

    agg = {}
    ALL = ranked
    TOP = {k: ranked[:k] for k in (3, 5, 10)}

    Atr, Ate = stack(ALL)
    agg["AGG_mean_prob_all"] = Ate.mean(axis=1)
    agg["AGG_logit_mean_all"] = sigmoid(logit(Ate).mean(axis=1))
    agg["AGG_median_all"] = np.median(Ate, axis=1)
    trim = int(0.2 * len(ALL))
    agg["AGG_trimmed_mean_all"] = np.sort(Ate, axis=1)[:, trim:len(ALL) - trim].mean(axis=1)
    agg["AGG_rank_mean_all"] = (
        pd.DataFrame(Ate).rank(axis=0, pct=True).mean(axis=1).values * 0.999 + 0.0005
    )
    for k, cols in TOP.items():
        _, te_k = stack(cols)
        agg[f"AGG_logit_mean_top{k}"] = sigmoid(logit(te_k).mean(axis=1))

    # inverse-log-loss weights, and Bayesian model averaging over the same losses
    w = np.array([1.0 / ll_tr[n] for n in ALL])
    agg["AGG_inv_logloss_weighted"] = (Ate * (w / w.sum())).sum(axis=1)
    losses = np.array([ll_tr[n] for n in ALL])
    bw = np.exp(-len(ytr) * (losses - losses.min()) / 50)  # tempered BMA
    agg["AGG_bayesian_model_avg"] = (Ate * (bw / bw.sum())).sum(axis=1)

    # one model per family — diversity by construction, not by leaderboard
    diverse = [n for n in ["elo_plus_pitcher", "ML_extra_trees", "dixon_coles",
                           "bradley_terry", "kalman_state_space", "SHIPPED_elo_v2"]
               if n in P_te]
    _, dte = stack(diverse)
    agg["AGG_diverse_families"] = sigmoid(logit(dte).mean(axis=1))

    # learned stacks on the log-odds of the top 10
    tr10, te10 = stack(TOP[10])
    meta = LogisticRegression(max_iter=3000).fit(logit(tr10), ytr)
    agg["AGG_logistic_stack_top10"] = meta.predict_proba(logit(te10))[:, 1]
    meta_r = LogisticRegression(max_iter=3000, C=0.05).fit(logit(tr10), ytr)
    agg["AGG_ridge_stack_top10"] = meta_r.predict_proba(logit(te10))[:, 1]

    # non-negative weights (constrained least squares on the logit scale)
    from scipy.optimize import nnls
    W, _ = nnls(logit(tr10), logit(np.clip(ytr.astype(float), 0.02, 0.98)))
    if W.sum() > 0:
        agg["AGG_nnls_weights_top10"] = sigmoid(logit(te10) @ (W / W.sum()))

    # the shipped recipe, generalized: shipped Elo + the best ML model
    best_ml = next((n for n in ranked if n.startswith("ML_")), None)
    if best_ml:
        agg["AGG_shipped_elo_x_bestML"] = sigmoid(
            (logit(P_te["SHIPPED_elo_v2"]) + logit(P_te[best_ml])) / 2
        )

    for name, p in agg.items():
        results.append(B.score(name, yte, p))
        P_te[name] = p

    return P_te, yte, results


# -------------------------------------------------------------------- main
def main():
    df = pd.read_csv(os.path.join(DATA, "games.csv"))
    df["home_win"] = (df.home_score > df.away_score).astype(int)
    df = df.sort_values(["date", "gamePk"]).reset_index(drop=True)
    B.LG_RUNS = float((df.home_score.sum() + df.away_score.sum()) / (2 * len(df)))
    print(f"{len(df):,} games 2021-{TEST_SEASON} | league runs/team/game {B.LG_RUNS:.3f} | "
          f"home win rate {df.home_win.mean():.4f}")

    print("walking forward (this replays every rating system once) ...", flush=True)
    sigs, feats = B.walk(df)
    sigs["shipped_elo"] = shipped_elo_probs(df)

    pooled_p, pooled_y, per_season = {}, [], []
    for ts in ROLLING_TEST_SEASONS:
        P_te, yte, res = evaluate_season(sigs, feats, ts)
        pooled_y.append(yte)
        for name, p in P_te.items():
            pooled_p.setdefault(name, []).append(p)
        for r in res:
            per_season.append({**r, "test_season": ts})

    y = np.concatenate(pooled_y)
    # Only models that ran in every season can be pooled honestly.
    P = {n: np.concatenate(v) for n, v in pooled_p.items() if len(v) == len(ROLLING_TEST_SEASONS)}

    pooled = pd.DataFrame([B.score(n, y, p) for n, p in P.items()])
    pooled = pooled.sort_values("auc", ascending=False).reset_index(drop=True)
    pooled.to_csv(os.path.join(HERE, "bakeoff_v2_pooled.csv"), index=False)
    pd.DataFrame(per_season).to_csv(os.path.join(HERE, "bakeoff_v2_per_season.csv"), index=False)

    print("\n" + "=" * 96)
    print(f"MLB GAME-OUTCOME BAKE-OFF v2 — pooled walk-forward test "
          f"{ROLLING_TEST_SEASONS[0]}-{ROLLING_TEST_SEASONS[-1]}   {len(y):,} games   "
          f"(always-home = {y.mean():.1%})")
    print("=" * 96)
    print(f"{'#':>2}  {'algorithm':30s} {'AUC':>7} {'acc':>7} {'Brier':>7} {'logloss':>8} {'ECE':>6}")
    for i, r in enumerate(pooled.itertuples(), 1):
        mark = " <<< shipped" if r.model == "SHIPPED_elo_v2" else ""
        print(f"{i:>2}  {r.model:30s} {r.auc:>7.4f} {r.acc:>7.1%} {r.brier:>7.4f} "
              f"{r.logloss:>8.4f} {r.ece:>6.3f}{mark}")

    ship = P["SHIPPED_elo_v2"]
    print("\npaired bootstrap vs SHIPPED_elo_v2 on the pooled seasons "
          "(AUC difference, 95% CI):")
    for name in pooled.model.head(8):
        if name == "SHIPPED_elo_v2":
            continue
        m, lo, hi = bootstrap_delta(y, P[name], ship)
        print(f"  {name:30s} {m:+.4f}  [{lo:+.4f}, {hi:+.4f}]  "
              f"{'SIGNIFICANT' if lo > 0 else 'not significant'}")

    # How stable is a one-season leaderboard? Rank of each model, season by season.
    ps = pd.DataFrame(per_season)
    ps["rank"] = ps.groupby("test_season").auc.rank(ascending=False)
    piv = ps.pivot_table(index="model", columns="test_season", values="rank")
    piv["mean_rank"] = piv.mean(axis=1)
    piv["swing"] = piv[ROLLING_TEST_SEASONS].max(axis=1) - piv[ROLLING_TEST_SEASONS].min(axis=1)
    print("\nrank by test season (how much a one-season board moves):")
    print(piv.sort_values("mean_rank").head(12).round(1).to_string())

    print("\nsaved -> bakeoff_v2_pooled.csv, bakeoff_v2_per_season.csv")


if __name__ == "__main__":
    main()
