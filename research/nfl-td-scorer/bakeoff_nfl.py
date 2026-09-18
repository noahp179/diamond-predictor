"""
The same wide bakeoff the college board got, run against the NFL feature table.

WHY THIS IS NOT A COPY-PASTE OF THE COLLEGE RUN
-----------------------------------------------
Two things differ, and both cut against simply assuming the college winner
(extra trees) transfers:

  1. THE NFL BOARD HAS A MARKET. Three of the eighteen features — the implied
     team total, the game total, and the team's margin — are derived from the
     closing line. College has none of that: ESPN keeps no historical CFB odds,
     so the college model had to infer game context from Elo. A market feature
     is an aggregate of everyone else's opinion, already nonlinear in the raw
     inputs, and a linear model consuming it is not the naive thing it would be
     without one. The tree advantage that won college may already be priced in.

  2. THE SAMPLE IS A FIFTH THE SIZE. 1,424 games against college's ~7,000.
     Flexible models are exactly the ones that need rows. A forest that wins by
     0.9 points on 3,700 college test games can lose on 300 NFL ones and the
     difference be noise in both directions — which is why every headline gap
     here goes through a week-clustered bootstrap before it is believed.

Scored five ways, per metric, no collapsing into one number:

  auc        ordering over all rows — the conventional answer, and the wrong one
  logloss    probability quality
  ece        calibration: does a stated 60% happen 60% of the time
  top1       of each game's candidates, did the highest-ranked one score
  parlay5    five games on one slate, one leg each, all five scored

Train 2021-24, test 2025 and 2026-to-date. Nothing about the test seasons
touches any fit, scaler or calibrator.
"""
import os, json, time, warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

from sklearn.linear_model import (
    LogisticRegression,
    RidgeClassifier,
    PoissonRegressor,
    LinearRegression,
)
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import (
    RandomForestClassifier,
    ExtraTreesClassifier,
    HistGradientBoostingClassifier,
    AdaBoostClassifier,
)
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "td-model.json")
FEATURES = json.load(open(MODEL))["features"]

TRAIN = [2021, 2022, 2023, 2024]
TEST = [2025, 2026]
SEED = 0
PARLAY_SIZE = 5
PARLAY_FLOOR = 0.55


# ------------------------------------------------------------------ metrics
def ece(y, p, bins=10):
    """Expected calibration error: mean |stated - actual| over probability bins,
    weighted by how many predictions land in each."""
    y, p = np.asarray(y), np.asarray(p)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.sum() == 0:
            continue
        total += (m.sum() / len(y)) * abs(p[m].mean() - y[m].mean())
    return total


def per_game_top1(te, score):
    """Of each game's candidates, did the highest-scoring one score a TD?
    Returns the per-game hit vector so it can be bootstrapped."""
    d = te[["game_id", "scored", "date"]].copy()
    d["s"] = score
    hits, gids = [], []
    for gid, g in d.groupby("game_id"):
        top = g.loc[g.s.idxmax()]
        hits.append(int(top.scored))
        gids.append(gid)
    return np.array(hits), np.array(gids)


def parlay_rate(te, score, size=PARLAY_SIZE, floor=PARLAY_FLOOR, probs=None):
    """Five games on a slate, one leg each, all five scored. Legs are chosen by
    the model's own ranking; the floor only applies where a probability exists,
    so a pure ranker is not silently exempt from the quality bar."""
    d = te[["date", "game_id", "scored"]].copy()
    d["s"] = score
    d["p"] = probs if probs is not None else np.nan
    out = []
    for _, slate in d.groupby("date"):
        best = slate.loc[slate.groupby("game_id").s.idxmax()]
        if probs is not None:
            best = best[best.p >= floor]
        best = best.nlargest(size, "s")
        if len(best) < size:
            continue
        out.append(int(best.scored.sum() == size))
    return np.array(out)


# ------------------------------------------------------------------ models
TEAM_COLS = ["team_rush_tdpg", "team_rec_tdpg", "mkt_implied_total", "mkt_total",
             "mkt_team_margin", "is_home"]
SHARE_COLS = ["carry_share", "target_share", "cpg", "tpg", "rush_ypg", "rec_ypg",
              "anytime_rate"]


def fit_predict(kind, tr, te, Xtr, Xte, ytr):
    """Returns (score, prob or None). `score` is only used for ranking, so a
    ranker may return an unbounded score with prob=None."""
    if kind == "heuristic_anytime":
        return te.anytime_rate.values, np.clip(te.anytime_rate.values, 1e-6, 1 - 1e-6)
    if kind == "heuristic_share":
        return te.carry_share.values, np.clip(te.carry_share.values, 1e-6, 1 - 1e-6)
    if kind == "heuristic_touches":
        return (te.cpg + te.tpg).values, None
    if kind == "heuristic_expected_td":
        # carries x rushing TD rate + targets x receiving TD rate — an explicit
        # "expected touchdowns" count with no fitting whatsoever.
        lam = te.cpg * te.rush_td_rate + te.tpg * te.rec_td_rate
        return lam.values, np.clip(1 - np.exp(-lam.values), 1e-6, 1 - 1e-6)
    if kind == "random":
        rng = np.random.default_rng(SEED)
        return rng.random(len(te)), np.full(len(te), ytr.mean())

    if kind == "poisson":
        # Fit expected touchdowns, then P(>=1) = 1 - exp(-lambda).
        m = PoissonRegressor(alpha=1e-3, max_iter=2000).fit(Xtr, tr.td_count.values)
        lam = np.clip(m.predict(Xte), 1e-9, None)
        return lam, np.clip(1 - np.exp(-lam), 1e-6, 1 - 1e-6)

    if kind == "team_share":
        # Hierarchical: team touchdowns per game x this player's share of them.
        team_m = PoissonRegressor(alpha=1e-3, max_iter=2000).fit(
            tr[TEAM_COLS].values, tr.team_td.values
        )
        share_m = LinearRegression().fit(tr[SHARE_COLS].values, tr.td_share.values)
        team_lam = np.clip(team_m.predict(te[TEAM_COLS].values), 1e-9, None)
        share = np.clip(share_m.predict(te[SHARE_COLS].values), 0, 1)
        lam = team_lam * share
        return lam, np.clip(1 - np.exp(-lam), 1e-6, 1 - 1e-6)

    if kind == "rank_pairs":
        # Within-game pairwise learning to rank: for each game, pair every
        # scorer with every non-scorer and learn on the feature DIFFERENCE, with
        # no intercept. Optimises the comparison the card actually makes.
        rng = np.random.default_rng(SEED)
        diffs, labels = [], []
        gcol = tr.game_id.values
        order = np.argsort(gcol, kind="stable")
        Xs, ys, gs = Xtr[order], ytr[order], gcol[order]
        starts = np.searchsorted(gs, np.unique(gs))
        bounds = list(starts) + [len(gs)]
        for a, b in zip(bounds[:-1], bounds[1:]):
            yi = ys[a:b]
            pos = np.flatnonzero(yi == 1) + a
            neg = np.flatnonzero(yi == 0) + a
            if len(pos) == 0 or len(neg) == 0:
                continue
            # cap the pairs per game so a five-scorer rout cannot dominate
            for i in pos[: min(len(pos), 4)]:
                for j in rng.choice(neg, size=min(len(neg), 4), replace=False):
                    d = Xs[i] - Xs[j]
                    if rng.random() < 0.5:
                        diffs.append(d); labels.append(1)
                    else:
                        diffs.append(-d); labels.append(0)
        D, L = np.asarray(diffs), np.asarray(labels)
        m = LogisticRegression(max_iter=3000, fit_intercept=False, C=1.0).fit(D, L)
        return Xte @ m.coef_[0], None

    if kind == "ordinal":
        # 0 / 1 / 2+ touchdowns, then collapse to P(>=1). A two-touchdown
        # afternoon is evidence a binary label discards.
        m = LogisticRegression(max_iter=3000, C=1.0).fit(Xtr, tr.td_bucket.values)
        proba = m.predict_proba(Xte)
        idx0 = list(m.classes_).index(0)
        p = 1 - proba[:, idx0]
        return p, np.clip(p, 1e-6, 1 - 1e-6)

    if kind == "stack":
        # Out-of-fold blend of three different formulations.
        from sklearn.model_selection import cross_val_predict

        base = [
            LogisticRegression(max_iter=2000, C=1.0),
            HistGradientBoostingClassifier(max_iter=250, learning_rate=0.06,
                                           random_state=SEED),
        ]
        oof = np.column_stack(
            [cross_val_predict(b, Xtr, ytr, cv=3, method="predict_proba")[:, 1]
             for b in base]
        )
        pm = PoissonRegressor(alpha=1e-3, max_iter=2000)
        oof_p = cross_val_predict(pm, Xtr, tr.td_count.values, cv=3)
        oof = np.column_stack([oof, 1 - np.exp(-np.clip(oof_p, 1e-9, None))])
        meta = LogisticRegression(max_iter=2000).fit(oof, ytr)
        fitted = [b.fit(Xtr, ytr) for b in base]
        pm.fit(Xtr, tr.td_count.values)
        test_feats = np.column_stack(
            [f.predict_proba(Xte)[:, 1] for f in fitted]
            + [1 - np.exp(-np.clip(pm.predict(Xte), 1e-9, None))]
        )
        p = meta.predict_proba(test_feats)[:, 1]
        return p, p

    # plain sklearn classifiers
    model = kind
    model.fit(Xtr, ytr)
    if hasattr(model, "predict_proba"):
        p = model.predict_proba(Xte)[:, 1]
        return p, np.clip(p, 1e-6, 1 - 1e-6)
    return model.decision_function(Xte), None


CANDIDATES = [
    ("baseline: rank by scoring rate", "heuristic_anytime", "heuristic"),
    ("baseline: rank by carry share", "heuristic_share", "heuristic"),
    ("baseline: rank by touches", "heuristic_touches", "heuristic"),
    ("baseline: expected TDs (no fit)", "heuristic_expected_td", "heuristic"),
    ("control: random", "random", "heuristic"),
    ("logistic L2 (shipped)", LogisticRegression(max_iter=3000, C=1.0), "linear"),
    ("logistic L1", LogisticRegression(max_iter=3000, C=1.0, penalty="l1", solver="liblinear"), "linear"),
    ("logistic elastic-net", LogisticRegression(max_iter=3000, C=1.0, penalty="elasticnet", solver="saga", l1_ratio=0.5), "linear"),
    ("linear discriminant", LinearDiscriminantAnalysis(), "linear"),
    ("gaussian naive bayes", GaussianNB(), "linear"),
    ("ridge classifier", RidgeClassifier(alpha=1.0), "linear"),
    ("k-nearest neighbours (k=200)", KNeighborsClassifier(n_neighbors=200, n_jobs=-1), "nonlinear"),
    ("decision tree (depth 6)", DecisionTreeClassifier(max_depth=6, random_state=SEED), "nonlinear"),
    ("random forest", RandomForestClassifier(n_estimators=300, min_samples_leaf=20, random_state=SEED, n_jobs=-1), "nonlinear"),
    ("extra trees", ExtraTreesClassifier(n_estimators=300, min_samples_leaf=20, random_state=SEED, n_jobs=-1), "nonlinear"),
    ("hist gradient boosting", HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06, max_depth=6, random_state=SEED), "nonlinear"),
    ("adaboost", AdaBoostClassifier(n_estimators=200, random_state=SEED), "nonlinear"),
    ("neural net (64,32)", MLPClassifier(hidden_layer_sizes=(64, 32), max_iter=400, random_state=SEED, early_stopping=True), "nonlinear"),
    ("poisson rate -> P(>=1)", "poisson", "reformulated"),
    ("hierarchical team x share", "team_share", "reformulated"),
    ("within-game pairwise ranker", "rank_pairs", "reformulated"),
    ("ordinal 0/1/2+", "ordinal", "reformulated"),
    ("stack: logistic+boost+poisson", "stack", "reformulated"),
    ("calibrated boosting (isotonic)", CalibratedClassifierCV(
        HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06, random_state=SEED),
        method="isotonic", cv=3), "nonlinear"),
]


def load():
    """Feature table plus the count/share targets the reformulated models need."""
    df = pd.read_csv(os.path.join(HERE, "data", "nfl_features.csv"))
    pg = pd.read_csv(os.path.join(HERE, "data", "nfl_player_games.csv"))
    pg["tdc"] = pg.rush_td + pg.rec_td
    df["td_bucket"] = np.minimum(df.td_count, 2).astype(int)
    tm = pg.groupby(["game_id", "team"]).agg(team_td=("tdc", "sum")).reset_index()
    df = df.merge(tm, on=["game_id", "team"], how="left")
    df["team_td"] = df.team_td.fillna(0)
    df["td_share"] = np.where(df.team_td > 0, df.td_count / df.team_td, 0.0)
    return df


def main():
    df = load()
    tr = df[df.season.isin(TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[FEATURES].values)
    Xtr, Xte = sc.transform(tr[FEATURES].values), sc.transform(te[FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values

    print(f"train {len(tr):,} rows ({tr.game_id.nunique():,} games) · "
          f"test {len(te):,} rows ({te.game_id.nunique():,} games, "
          f"{te.date.nunique()} slates)")
    print(f"base rate: train {ytr.mean()*100:.1f}%, test {yte.mean()*100:.1f}%\n")

    rows, top1_vectors, parlay_vectors = [], {}, {}
    for name, kind, family in CANDIDATES:
        t0 = time.time()
        try:
            score, prob = fit_predict(kind, tr, te, Xtr, Xte, ytr)
        except Exception as e:
            print(f"  {name:<32} FAILED: {str(e)[:60]}")
            continue
        hits, _ = per_game_top1(te, score)
        pv = parlay_rate(te, score, probs=prob)
        r = {
            "model": name, "family": family,
            "auc": float(roc_auc_score(yte, score)),
            "logloss": float(log_loss(yte, prob)) if prob is not None else None,
            "brier": float(brier_score_loss(yte, prob)) if prob is not None else None,
            "ece": float(ece(yte, prob)) if prob is not None else None,
            "top1": float(hits.mean()), "top1_n": int(len(hits)),
            "parlay5": float(pv.mean()) if len(pv) else None,
            "parlay5_n": int(len(pv)),
            "secs": round(time.time() - t0, 1),
        }
        rows.append(r)
        top1_vectors[name] = hits
        parlay_vectors[name] = pv
        print(f"  {name:<32} auc {r['auc']:.4f}  top1 {r['top1']*100:5.1f}%  "
              f"{'ll %.4f' % r['logloss'] if r['logloss'] else 'll    —  '}  "
              f"{'ece %.3f' % r['ece'] if r['ece'] is not None else 'ece   — '}"
              f"  {r['secs']:>5}s")

    res = pd.DataFrame(rows)
    res.to_csv(os.path.join(HERE, "bakeoff_nfl_results.csv"), index=False)
    json.dump({"results": rows, "train": TRAIN, "test": TEST,
               "features": FEATURES},
              open(os.path.join(HERE, "bakeoff_nfl_metrics.json"), "w"), indent=1)
    print("\nwrote bakeoff_nfl_results.csv / bakeoff_nfl_metrics.json")
    return res, top1_vectors, parlay_vectors


if __name__ == "__main__":
    main()
