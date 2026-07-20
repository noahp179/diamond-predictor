"""
Extraordinary round: models that respect the STRUCTURE the flat models ignore.

Every model in the bake-off scored each player independently, then ranked. But
touchdowns inside a game are a *competing allocation*: a team scores a limited
number of TDs and its players compete for them. This module builds:

  HTS  - Hierarchical Two-Stage model
         Stage A: how many rush / rec TDs will the TEAM score?  (Poisson GLM)
         Stage B: given a team TD, WHO scores it?  (conditional logit / softmax
                  over the team's players - a within-team competition)
         Combine by Poisson thinning: lambda_player = teamCount * playerShare,
         P = 1 - exp(-lambda). This is the competing-risks structure done right.

  STACK - a stacked super-learner (Wolpert stacking): out-of-fold predictions of
          several diverse base models feed a meta-logistic that learns the
          optimal blend. Proper OOF folds => no leakage.

  RANKAVG - a non-parametric rank-average ensemble (robust blending).

All are evaluated on the same 2023-2024 test games as the bake-off.
"""
import os, warnings
import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.linear_model import PoissonRegressor, LogisticRegression
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
from sklearn.naive_bayes import GaussianNB
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import cross_val_predict

from sklearn.model_selection import GroupKFold
import backtest as bt
import bakeoff as bo

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_SEASONS, TEST_SEASONS = [2021, 2022], [2023, 2024]

TEAM_FEATS = ["team_off_rush", "team_off_rec", "opp_def_rush", "opp_def_rec", "is_home"]
RUSH_SHARE_FEATS = ["proj_carries", "carry_share", "rush_td_rate", "proj_rush_yds", "anytime_rate"]
REC_SHARE_FEATS = ["proj_targets", "target_share", "rec_td_rate", "proj_rec_yds", "anytime_rate"]


# --------------------------------------------------------------------------- #
def load_merged():
    f = pd.read_csv(os.path.join(HERE, "features.csv"))
    f["player_id"] = f.player_id.astype(str)
    pg = pd.read_csv(os.path.join(HERE, "data", "player_games.csv"))
    pg["player_id"] = pg.player_id.astype(str)
    f = f.merge(pg[["game_id", "player_id", "rush_td", "rec_td"]],
                on=["game_id", "player_id"], how="left").fillna({"rush_td": 0, "rec_td": 0})
    return f


# ------------------------- Stage B: conditional logit ---------------------- #
def _group_indices(df):
    """list of (row-index arrays) for each (game_id, team)."""
    groups = []
    for _, idx in df.groupby(["game_id", "team"]).indices.items():
        groups.append(np.asarray(idx))
    return groups


def fit_softmax_shares(X, events, groups, l2=1.0, iters=200):
    """
    Conditional-logit MLE: weight_i = exp(x_i . b); share within group = softmax.
    Maximize sum_g sum_i events_i * log(share_i)  (multinomial allocation kernel).
    Analytic gradient; L-BFGS. Groups with no events contribute nothing.
    """
    X = np.asarray(X, float)
    events = np.asarray(events, float)
    active = [g for g in groups if events[g].sum() > 0]

    def negll(b):
        ll = 0.0
        grad = np.zeros(X.shape[1])
        for g in active:
            xg, eg = X[g], events[g]
            z = xg @ b
            z -= z.max()
            w = np.exp(z)
            p = w / w.sum()
            ll += (eg * np.log(p + 1e-12)).sum()
            xbar = p @ xg
            grad += (eg[:, None] * (xg - xbar)).sum(axis=0)
        ll -= l2 * (b @ b)
        grad -= 2 * l2 * b
        return -ll, -grad

    res = minimize(negll, np.zeros(X.shape[1]), jac=True, method="L-BFGS-B",
                   options={"maxiter": iters})
    return res.x


def softmax_within(df, X, beta):
    """Return per-row share, normalized within each (game_id, team)."""
    z = np.asarray(X, float) @ beta
    out = np.zeros(len(df))
    tmp = df.copy()
    tmp["_z"] = z
    for _, idx in tmp.groupby(["game_id", "team"]).indices.items():
        zz = z[idx]; zz = zz - zz.max()
        w = np.exp(zz)
        out[np.asarray(idx)] = w / w.sum()
    return out


# ------------------------------ HTS assembly ------------------------------- #
class HTS:
    """Hierarchical two-stage model with fit/predict over a merged feature frame."""
    def __init__(self):
        self.rush_count = make_pipeline(StandardScaler(), PoissonRegressor(alpha=1.0, max_iter=500))
        self.rec_count = make_pipeline(StandardScaler(), PoissonRegressor(alpha=1.0, max_iter=500))
        self.scaler_r = StandardScaler()
        self.scaler_c = StandardScaler()
        self.beta_r = None
        self.beta_c = None

    def _team_table(self, df):
        tt = df.drop_duplicates(["game_id", "team"]).copy()
        tg = pd.read_csv(os.path.join(HERE, "data", "team_games.csv"))
        tt = tt.merge(tg[["game_id", "team", "rush_td", "rec_td"]],
                      on=["game_id", "team"], how="left", suffixes=("", "_team"))
        return tt

    def fit(self, tr):
        tt = self._team_table(tr)
        self.rush_count.fit(tt[TEAM_FEATS].values, tt["rush_td_team"].values)
        self.rec_count.fit(tt[TEAM_FEATS].values, tt["rec_td_team"].values)
        groups = _group_indices(tr.reset_index(drop=True))
        trr = tr.reset_index(drop=True)
        Xr = self.scaler_r.fit_transform(trr[RUSH_SHARE_FEATS].values)
        Xc = self.scaler_c.fit_transform(trr[REC_SHARE_FEATS].values)
        self.beta_r = fit_softmax_shares(Xr, trr["rush_td"].values, groups)
        self.beta_c = fit_softmax_shares(Xc, trr["rec_td"].values, groups)
        return self

    def predict(self, df):
        d = df.reset_index(drop=True).copy()
        # team-level predicted counts, broadcast to players
        tt = d.drop_duplicates(["game_id", "team"]).copy()
        tt["rush_cnt"] = np.clip(self.rush_count.predict(tt[TEAM_FEATS].values), 0, None)
        tt["rec_cnt"] = np.clip(self.rec_count.predict(tt[TEAM_FEATS].values), 0, None)
        d = d.merge(tt[["game_id", "team", "rush_cnt", "rec_cnt"]], on=["game_id", "team"], how="left")
        share_r = softmax_within(d, self.scaler_r.transform(d[RUSH_SHARE_FEATS].values), self.beta_r)
        share_c = softmax_within(d, self.scaler_c.transform(d[REC_SHARE_FEATS].values), self.beta_c)
        lam = d["rush_cnt"].values * share_r + d["rec_cnt"].values * share_c
        return 1 - np.exp(-np.clip(lam, 0, None))


# ------------------------------ evaluation --------------------------------- #
def isotonic(s_tr, y_tr, s_te):
    iso = IsotonicRegression(out_of_bounds="clip"); iso.fit(s_tr, y_tr)
    return iso.transform(s_te)


def metrics(name, s_tr, y_tr, s_te, y_te, test_df):
    d = test_df.copy(); d["_s"] = s_te
    t1, t2 = bo.pick_metrics(d, "_s")
    p = isotonic(s_tr, y_tr, s_te)
    return dict(model=name, top1=t1, top2=t2, auc=bt.auc(y_te, s_te),
                brier=bt.brier(y_te, p), logloss=bt.logloss(y_te, p),
                ece=bt.calibration(y_te, p)[1])


# --------------------- stacking: out-of-fold base learners ----------------- #
def oof_sklearn(make, Xtr, ytr, Xte, groups, folds=4):
    """Group-K-fold OOF train predictions + full-fit test predictions."""
    oof = np.zeros(len(ytr))
    for tri, vai in GroupKFold(folds).split(Xtr, ytr, groups):
        m = make(); m.fit(Xtr[tri], ytr[tri])
        oof[vai] = m.predict_proba(Xtr[vai])[:, 1]
    m = make(); m.fit(Xtr, ytr)
    return oof, m.predict_proba(Xte)[:, 1]


def oof_hts(tr, te, folds=4):
    oof = np.zeros(len(tr)); g = tr.game_id.values
    for tri, vai in GroupKFold(folds).split(tr, tr.scored.values, g):
        m = HTS().fit(tr.iloc[tri])
        oof[vai] = m.predict(tr.iloc[vai])
    m = HTS().fit(tr)
    return oof, m.predict(te)


def build_stack(tr, te):
    """Level-0 OOF predictions -> level-1 meta-logistic (Wolpert stacking)."""
    ytr = tr.scored.values
    g = tr.game_id.values
    Xtr_f, Xte_f = tr[bo.FEATURES].values, te[bo.FEATURES].values
    base = {}
    base["logistic"] = oof_sklearn(
        lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        Xtr_f, ytr, Xte_f, g)
    base["hist_gbm"] = oof_sklearn(
        lambda: HistGradientBoostingClassifier(random_state=0, learning_rate=0.05,
                max_iter=500, max_leaf_nodes=15, l2_regularization=1.0,
                early_stopping=True, validation_fraction=0.15),
        Xtr_f, ytr, Xte_f, g)
    base["random_forest"] = oof_sklearn(
        lambda: RandomForestClassifier(n_estimators=400, min_samples_leaf=20,
                random_state=0, n_jobs=-1), Xtr_f, ytr, Xte_f, g)
    base["naive_bayes"] = oof_sklearn(
        lambda: make_pipeline(StandardScaler(), GaussianNB()), Xtr_f, ytr, Xte_f, g)
    base["hts"] = oof_hts(tr, te)
    # incumbent Poisson is a fixed pre-game computation (not fit to labels) -> use directly
    base["incumbent_poisson"] = (tr.poisson_p.values, te.poisson_p.values)

    names = list(base)
    OOF = np.column_stack([base[n][0] for n in names])
    TEST = np.column_stack([base[n][1] for n in names])
    meta = LogisticRegression(max_iter=2000)
    meta.fit(OOF, ytr)
    s_tr = meta.predict_proba(OOF)[:, 1]
    s_te = meta.predict_proba(TEST)[:, 1]
    weights = dict(zip(names, np.round(meta.coef_[0], 3)))
    return s_tr, s_te, weights, base, names


def main():
    f = load_merged()
    tr = f[f.season.isin(TRAIN_SEASONS)].reset_index(drop=True)
    te = f[f.season.isin(TEST_SEASONS)].reset_index(drop=True)
    ytr, yte = tr.scored.values, te.scored.values
    print(f"train {len(tr):,}  test {len(te):,}  test games {te.game_id.nunique()}")

    rows = []

    # ---- HTS ----
    hts = HTS().fit(tr)
    hts_tr, hts_te = hts.predict(tr), hts.predict(te)
    print("beta_rush (share drivers):", dict(zip(RUSH_SHARE_FEATS, np.round(hts.beta_r, 2))))
    print("beta_rec  (share drivers):", dict(zip(REC_SHARE_FEATS, np.round(hts.beta_c, 2))))
    rows.append(metrics("HTS hierarchical (team x share)", hts_tr, ytr, hts_te, yte, te))

    # ---- STACK (super-learner) ----
    s_tr, s_te, weights, base, names = build_stack(tr, te)
    print("\nstack meta-weights:", weights)
    rows.append(metrics("STACK super-learner (6 models)", s_tr, ytr, s_te, yte, te))

    # ---- RANKAVG (non-parametric blend of diverse models) ----
    from scipy.stats import rankdata
    blend_names = ["logistic", "hist_gbm", "random_forest", "hts", "incumbent_poisson"]
    ra_tr = np.mean([rankdata(base[n][0]) / len(ytr) for n in blend_names], axis=0)
    ra_te = np.mean([rankdata(base[n][1]) / len(yte) for n in blend_names], axis=0)
    rows.append(metrics("RANKAVG ensemble (5 models)", ra_tr, ytr, ra_te, yte, te))

    print()
    for r in rows:
        print(f"  {r['model']:34s} top1={r['top1']:.1%} top2={r['top2']:.1%} "
              f"AUC={r['auc']:.3f} Brier={r['brier']:.4f} logloss={r['logloss']:.4f}")

    # ---- is STACK really better? paired bootstrap over test games ----
    def per_game_top1(score):
        d = te.copy(); d["_s"] = score
        return {gid: int(g.sort_values("_s", ascending=False).iloc[0].player_id
                         in set(g.loc[g.scored == 1, "player_id"]))
                for gid, g in d.groupby("game_id")}
    games = sorted(te.game_id.unique())
    arr = lambda h: np.array([h[g] for g in games])
    hs = arr(per_game_top1(s_te))                      # stack
    hl = arr(per_game_top1(base["logistic"][1]))       # best single
    hi = arr(per_game_top1(te.poisson_p.values))       # incumbent
    rb = np.random.default_rng(0)

    def boot(a, b, n=5000):
        idx = rb.integers(0, len(a), (n, len(a)))
        d = a[idx].mean(1) - b[idx].mean(1)
        return d.mean(), np.percentile(d, 2.5), np.percentile(d, 97.5)

    print("\n[Significance] STACK top-1 advantage (paired bootstrap over 569 games)")
    for lbl, b in [("vs incumbent Poisson", hi), ("vs best single (logistic)", hl)]:
        m, lo, hihi = boot(hs, b)
        sig = "significant" if lo > 0 else "within noise"
        print(f"  {lbl:26s} +{m:.1%}  95% CI [{lo:+.1%}, {hihi:+.1%}]  ({sig})")

    # AUC advantage - clustered (by game) bootstrap over the 9,612 predictions
    game_rows = {gid: te.index[te.game_id == gid].to_numpy() -
                 te.index[0] for gid in games}
    sc_stack, sc_log, sc_inc = s_te, base["logistic"][1], te.poisson_p.values
    yv = yte

    def boot_auc(sa, sb, n=2000):
        d = []
        for _ in range(n):
            gsel = rb.integers(0, len(games), len(games))
            ridx = np.concatenate([game_rows[games[k]] for k in gsel])
            d.append(bt.auc(yv[ridx], sa[ridx]) - bt.auc(yv[ridx], sb[ridx]))
        return np.mean(d), np.percentile(d, 2.5), np.percentile(d, 97.5)

    print("\n[Significance] STACK AUC advantage (clustered bootstrap, 9,612 preds)")
    for lbl, sb in [("vs incumbent Poisson", sc_inc), ("vs best single (logistic)", sc_log)]:
        m, lo, hihi = boot_auc(sc_stack, sb)
        sig = "significant" if lo > 0 else "within noise"
        print(f"  {lbl:26s} +{m:+.4f}  95% CI [{lo:+.4f}, {hihi:+.4f}]  ({sig})")

    with open(os.path.join(HERE, "advanced_metrics.json"), "w") as fp:
        import json
        json.dump({"models": rows, "stack_weights": weights,
                   "beta_rush": dict(zip(RUSH_SHARE_FEATS, hts.beta_r.round(3).tolist())),
                   "beta_rec": dict(zip(REC_SHARE_FEATS, hts.beta_c.round(3).tolist()))}, fp, indent=2)
    return f, tr, te, rows


if __name__ == "__main__":
    main()
