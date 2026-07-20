"""
Model bake-off for the anytime-TD-scorer problem.

Every algorithm is judged on the SAME held-out games (2023-2024) over the SAME
candidate set per game (the active, has-history players), with the SAME metrics.
That is what makes the ranking fair - the models differ only in how they score a
player, not in what they are asked or graded on.

Families
  heuristic    : base rate, volume, weighted volume, historical rate, hot hand
  statistical  : league Poisson, player-rate Poisson, incumbent allocation Poisson
  ML (trained) : logistic, gradient boosting, hist-GBM, random forest, extra
                 trees, gaussian NB, kNN, MLP  (trained on 2021-2022)
  ensemble     : mean of calibrated incumbent + logistic + hist-GBM

Fairness of probabilities
  * ML models are calibrated OUT-OF-FOLD on the training seasons (isotonic via
    cross-validation) so their test probabilities are honest, not in-sample.
  * Heuristic/statistical scores are mapped to probabilities with an isotonic
    fit on the training seasons (the models themselves are not fit to labels).
  * AUC and the pick metrics use the raw score ordering, so calibration cannot
    flatter them.
"""
import os, json, warnings
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import (GradientBoostingClassifier, RandomForestClassifier,
                              ExtraTreesClassifier, HistGradientBoostingClassifier)
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import cross_val_predict

import backtest as bt

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(0)

LG_RUSH, LG_REC = 0.0347, 0.0469     # league TD rates (2021 priors)

# Raw features an ML model can learn from. The last three are the incumbent
# model's own outputs - including them lets ML "stack" on top of the incumbent.
RAW_FEATURES = [
    "proj_carries", "proj_targets", "proj_rush_yds", "proj_rec_yds", "proj_touches",
    "carry_share", "target_share", "rush_td_rate", "rec_td_rate", "anytime_rate",
    "ewma_scored", "games_hist", "team_off_rush", "team_off_rec", "opp_def_rush",
    "opp_def_rec", "team_exp_rush_td", "team_exp_rec_td", "is_home",
]
FEATURES = RAW_FEATURES + ["poisson_lam_rush", "poisson_lam_rec", "poisson_p"]


# ----------------------------- metrics helpers ----------------------------- #
def pick_metrics(df, score_col):
    """Rank each game's candidates by score; did top-1 / top-2 actually score?"""
    t1 = t2 = n = 0
    for _, g in df.groupby("game_id"):
        gg = g.sort_values(score_col, ascending=False)
        scorers = set(gg.loc[gg.scored == 1, "player_id"])
        if not len(gg):
            continue
        n += 1
        t1 += int(gg.iloc[0].player_id in scorers)
        t2 += int(any(pid in scorers for pid in gg.iloc[:2].player_id))
    return t1 / n, t2 / n


# ------------------------------ score builders ----------------------------- #
def heuristic_scores(train, test):
    """dict name -> (train_score, test_score) for non-trained models."""
    def touches(d): return d.proj_carries + d.proj_targets
    out = {}
    out["base_rate (no skill)"] = (rng.random(len(train)), rng.random(len(test)))
    out["volume (touches)"] = (touches(train).values, touches(test).values)
    out["weighted volume"] = ((1.6*train.proj_carries + train.proj_targets).values,
                              (1.6*test.proj_carries + test.proj_targets).values)
    out["historical TD rate"] = (train.anytime_rate.values, test.anytime_rate.values)
    out["hot hand (recent)"] = (train.ewma_scored.values, test.ewma_scored.values)
    # league-rate Poisson lambda (pure volume with fixed TD weights)
    lam = lambda d: d.proj_carries*LG_RUSH + d.proj_targets*LG_REC
    out["league Poisson"] = (lam(train).values, lam(test).values)
    # player-rate Poisson (usage x player's own shrunk rate, no team scaling)
    plam = lambda d: d.proj_carries*d.rush_td_rate + d.proj_targets*d.rec_td_rate
    out["player-rate Poisson"] = (plam(train).values, plam(test).values)
    # incumbent allocation Poisson (the model we already built)
    out["Poisson allocation (incumbent)"] = (train.poisson_p.values, test.poisson_p.values)
    return out


def ml_models():
    """name -> (estimator, feature_columns). Most stack on the incumbent (FEATURES);
    one logistic uses RAW_FEATURES only, to test whether ML wins without it."""
    return {
        "logistic regression": (make_pipeline(StandardScaler(),
                                LogisticRegression(max_iter=2000, C=1.0)), FEATURES),
        "logistic (no incumbent feat)": (make_pipeline(StandardScaler(),
                                LogisticRegression(max_iter=2000, C=1.0)), RAW_FEATURES),
        "gradient boosting": (GradientBoostingClassifier(random_state=0), FEATURES),
        "hist gradient boosting": (HistGradientBoostingClassifier(
                                random_state=0, learning_rate=0.05, max_iter=500,
                                max_leaf_nodes=15, l2_regularization=1.0,
                                early_stopping=True, validation_fraction=0.15), FEATURES),
        "random forest": (RandomForestClassifier(n_estimators=400, min_samples_leaf=20,
                                random_state=0, n_jobs=-1), FEATURES),
        "extra trees": (ExtraTreesClassifier(n_estimators=400, min_samples_leaf=20,
                                random_state=0, n_jobs=-1), FEATURES),
        "gaussian naive bayes": (make_pipeline(StandardScaler(), GaussianNB()), FEATURES),
        "k-nearest neighbors": (make_pipeline(StandardScaler(),
                                KNeighborsClassifier(n_neighbors=75)), FEATURES),
        "neural net (MLP)": (make_pipeline(StandardScaler(),
                                MLPClassifier(hidden_layer_sizes=(24,), alpha=1e-2,
                                              max_iter=1500, early_stopping=True,
                                              random_state=0)), FEATURES),
    }


def isotonic_prob(s_train, y_train, s_test):
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(s_train, y_train)
    return iso.transform(s_test)


def evaluate():
    feats = pd.read_csv(os.path.join(HERE, "features.csv"))
    feats["player_id"] = feats.player_id.astype(str)
    train = feats[feats.season.isin([2021, 2022])].copy()
    test = feats[feats.season.isin([2023, 2024])].copy()
    ytr, yte = train.scored.values, test.scored.values
    print(f"train rows={len(train):,} (2021-22)   test rows={len(test):,} (2023-24)   "
          f"test base rate={yte.mean():.3f}")

    results = {}          # name -> dict of metrics
    train_scores = {}     # name -> raw train score (for honest ensemble calibration)
    test_scores = {}      # name -> raw test score array (for ensemble)

    # ---- heuristic / statistical ----
    for name, (str_, ste) in heuristic_scores(train, test).items():
        train_scores[name] = np.asarray(str_, float)
        p_test = isotonic_prob(str_, ytr, ste)
        _store(results, test_scores, name, ste, p_test, yte, test)

    # ---- ML (out-of-fold calibration on train, full-fit for test) ----
    for name, (est, cols) in ml_models().items():
        Xtr, Xte = train[cols].values, test[cols].values
        # honest train scores via cross-val; test scores from full-train fit
        oof = cross_val_predict(est, Xtr, ytr, cv=4, method="predict_proba", n_jobs=-1)[:, 1]
        est.fit(Xtr, ytr)
        ste = est.predict_proba(Xte)[:, 1]
        train_scores[name] = oof
        p_test = isotonic_prob(oof, ytr, ste)
        _store(results, test_scores, name, ste, p_test, yte, test)

    # ---- ensemble of three strong, diverse models (calibrated on train) ----
    comps = ["Poisson allocation (incumbent)", "logistic regression", "hist gradient boosting"]
    ens_tr = np.mean([train_scores[c] for c in comps], axis=0)
    ens_te = np.mean([test_scores[c] for c in comps], axis=0)
    p_ens = isotonic_prob(ens_tr, ytr, ens_te)
    _store(results, test_scores, "ensemble (incumbent+LR+GBM)", ens_te, p_ens, yte, test)

    # ---- assemble table ----
    rows = []
    for name, m in results.items():
        rows.append(dict(model=name, **m))
    tab = pd.DataFrame(rows)
    tab.to_csv(os.path.join(HERE, "bakeoff_results.csv"), index=False)
    with open(os.path.join(HERE, "bakeoff_metrics.json"), "w") as f:
        json.dump(rows, f, indent=2)

    _print_rankings(tab, yte.mean(), len(test.game_id.unique()))
    return tab


def _store(results, test_scores, name, s_test, p_test, y, test_df):
    test_scores[name] = np.asarray(s_test, float)
    d = test_df.copy(); d["_s"] = s_test
    t1, t2 = pick_metrics(d, "_s")
    results[name] = dict(
        top1=t1, top2=t2, auc=bt.auc(y, s_test),
        brier=bt.brier(y, p_test), logloss=bt.logloss(y, p_test),
        ece=bt.calibration(y, p_test)[1],
    )


def _print_rankings(tab, base, ngames):
    se = (base * (1 - base) / ngames) ** 0.5
    print(f"\n{ngames} test games; top-1 hit-rate noise ~ +/-{1.96*se:.1%} (95%).")

    print("\n" + "=" * 78)
    print("RANKED BY PICK ACCURACY  (top-1: did the #1 player score a TD?)")
    print("=" * 78)
    print(f"{'#':>2} {'model':34s} {'top1':>6} {'top2':>6} {'AUC':>6} {'Brier':>7} {'logloss':>7}")
    for i, r in enumerate(tab.sort_values('top1', ascending=False).itertuples(), 1):
        print(f"{i:>2} {r.model:34s} {r.top1:>6.1%} {r.top2:>6.1%} {r.auc:>6.3f} "
              f"{r.brier:>7.4f} {r.logloss:>7.4f}")

    print("\n" + "=" * 78)
    print("RANKED BY PROBABILITY QUALITY  (AUC, then Brier)")
    print("=" * 78)
    print(f"{'#':>2} {'model':34s} {'AUC':>6} {'Brier':>7} {'logloss':>7} {'ECE':>6} {'top1':>6}")
    for i, r in enumerate(tab.sort_values(['auc', 'brier'], ascending=[False, True]).itertuples(), 1):
        print(f"{i:>2} {r.model:34s} {r.auc:>6.3f} {r.brier:>7.4f} {r.logloss:>7.4f} "
              f"{r.ece:>6.3f} {r.top1:>6.1%}")


if __name__ == "__main__":
    evaluate()
