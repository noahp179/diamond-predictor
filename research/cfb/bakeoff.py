"""
Which model actually predicts a college touchdown scorer?

Train on 2021-2024, test on 2025 and on 2026-to-date, separately. Nothing about
the test seasons touches the fit — not the scaler, not the calibration, not the
feature list.

Candidates, weakest first, because the only number that matters is whether the
complicated one beats the obvious one:

  usage-rate baseline   rank by `anytime_rate` alone — how often this player has
                        scored. If a logistic regression cannot beat this, the
                        regression is decoration.
  carry-share baseline  rank by share of the team's carries.
  logistic              L2 logistic regression on the full feature set.
  logistic + calib      the same, Platt-scaled on a held-back slice of train.
  gradient boosting     HistGradientBoosting, to see whether the relationships
                        are non-linear enough to be worth an unexplainable model.

Scored two ways, because they answer different questions:
  AUC / log loss / Brier   is the probability any good?
  top-1 hit rate per game  does the pick the board would actually show hit?
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TRAIN = [2021, 2022, 2023, 2024]
TEST = [2025, 2026]


def load():
    fp = os.path.join(DATA, "features.csv")
    if os.path.exists(fp):
        df = pd.read_csv(fp)
    else:
        df, _ = F.build()
        df.to_csv(fp, index=False)
    return df


def per_game_hit(df, p, k=1):
    """Of the games on the board, how often did a top-k pick score?

    Measured per game, not per row: the board shows one card per game, so the
    question is 'did the name on the card score', not 'what fraction of all
    players we ranked highly scored'.
    """
    d = df.copy()
    d["p"] = p
    hits = tot = 0
    for _, g in d.groupby("game_id"):
        top = g.nlargest(k, "p")
        if len(top) < k:
            continue
        tot += 1
        hits += int(top.scored.max() > 0) if k > 1 else int(top.scored.iloc[0] > 0)
    return hits / tot if tot else float("nan"), tot


def evaluate(name, y, p, df, out):
    row = {
        "model": name,
        "auc": roc_auc_score(y, p),
        "logloss": log_loss(y, p),
        "brier": brier_score_loss(y, p),
        "base_rate": float(np.mean(y)),
    }
    for k in (1, 2, 3):
        hit, n = per_game_hit(df, p, k)
        row[f"top{k}_hit"] = hit
        row["games"] = n
    out.append(row)
    print(f"  {name:<22} AUC {row['auc']:.4f}  logloss {row['logloss']:.4f}  "
          f"top1 {row['top1_hit']*100:5.1f}%  top2 {row['top2_hit']*100:5.1f}%  "
          f"top3 {row['top3_hit']*100:5.1f}%  (n={row['games']} games)")
    return row


def main():
    df = load()
    print(f"{len(df):,} rows; scored rate {df.scored.mean()*100:.1f}%")
    for s in sorted(df.season.unique()):
        sub = df[df.season == s]
        print(f"  {s}: {len(sub):,} rows, {sub.game_id.nunique():,} games, "
              f"{sub.scored.mean()*100:.1f}% scored")

    tr = df[df.season.isin(TRAIN)]
    X = tr[F.FEATURES].values
    y = tr.scored.values
    sc = StandardScaler().fit(X)
    Xs = sc.transform(X)

    # A slice of the training seasons, held back for Platt scaling only — the
    # test seasons must not inform the calibration either.
    cut = int(len(tr) * 0.85)
    lr_main = LogisticRegression(max_iter=2000, C=1.0).fit(Xs[:cut], y[:cut])
    from sklearn.linear_model import LogisticRegression as LR
    raw_cal = lr_main.decision_function(Xs[cut:])
    platt = LR(max_iter=1000).fit(raw_cal.reshape(-1, 1), y[cut:])

    lr = LogisticRegression(max_iter=2000, C=1.0).fit(Xs, y)
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06,
                                        max_depth=6, random_state=0).fit(X, y)

    results = []
    for season in TEST:
        te = df[df.season == season]
        if te.empty:
            continue
        print(f"\n=== held out: {season} ({te.game_id.nunique()} games, {len(te):,} rows) ===")
        Xt, yt = te[F.FEATURES].values, te.scored.values
        Xts = sc.transform(Xt)
        rows = []
        evaluate("baseline: anytime_rate", yt, np.clip(te.anytime_rate.values, 1e-6, 1 - 1e-6), te, rows)
        evaluate("baseline: carry_share", yt, np.clip(te.carry_share.values, 1e-6, 1 - 1e-6), te, rows)
        p_lr = lr.predict_proba(Xts)[:, 1]
        evaluate("logistic", yt, p_lr, te, rows)
        p_cal = platt.predict_proba(lr_main.decision_function(Xts).reshape(-1, 1))[:, 1]
        evaluate("logistic + platt", yt, p_cal, te, rows)
        p_gb = gb.predict_proba(Xt)[:, 1]
        evaluate("gradient boosting", yt, p_gb, te, rows)
        for r in rows:
            r["season"] = season
        results += rows

    # Which features are actually doing the work?
    print("\ncoefficients (standardized, logistic):")
    for name, c in sorted(zip(F.FEATURES, lr.coef_[0]), key=lambda x: -abs(x[1])):
        print(f"  {name:<24} {c:+.4f}")

    json.dump({"results": results,
               "coefficients": dict(zip(F.FEATURES, lr.coef_[0].tolist())),
               "train_seasons": TRAIN, "test_seasons": TEST},
              open(os.path.join(HERE, "bakeoff_metrics.json"), "w"), indent=1)
    pd.DataFrame(results).to_csv(os.path.join(HERE, "bakeoff_results.csv"), index=False)
    print("\nwrote bakeoff_metrics.json / bakeoff_results.csv")


if __name__ == "__main__":
    main()
