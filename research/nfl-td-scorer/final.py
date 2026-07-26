"""
Final, leakage-controlled evaluation.

  2021  -> builds initial running state + league priors      (warmup)
  2022  -> structural params were validated here; Platt        (validation / fit)
           probability calibration is fit ONLY on this season
  2023-2024 -> headline out-of-sample test                     (never touched
               by any fitting or parameter choice)

Calibration is monotonic, so it does not change WHO is picked - only the stated
likelihood. Pick accuracy is therefore identical raw vs calibrated; calibration
just makes the probabilities honest.
"""
import os, json
import numpy as np
import pandas as pd
import backtest as bt

HERE = os.path.dirname(os.path.abspath(__file__))
TEST = {2023, 2024}
FIT = 2022


def logit(p, eps=1e-6):
    p = np.clip(p, eps, 1 - eps)
    return np.log(p / (1 - p))


def fit_platt(p_raw, y, iters=50):
    """2-parameter logistic recalibration via Newton/IRLS on x = logit(p_raw)."""
    x = logit(p_raw)
    X = np.column_stack([x, np.ones_like(x)])
    beta = np.zeros(2)
    for _ in range(iters):
        z = X @ beta
        q = 1 / (1 + np.exp(-z))
        W = np.clip(q * (1 - q), 1e-9, None)
        grad = X.T @ (q - y)
        H = X.T @ (X * W[:, None]) + 1e-8 * np.eye(2)
        beta -= np.linalg.solve(H, grad)
    return beta


def apply_platt(p_raw, beta):
    return 1 / (1 + np.exp(-(logit(p_raw) * beta[0] + beta[1])))


def block(name, y, p):
    return (f"  {name:28s} Brier={bt.brier(y,p):.4f}  LogLoss={bt.logloss(y,p):.4f}  "
            f"AUC={bt.auc(y,p):.4f}")


def main():
    rec, games = bt.run(score_seasons={2022, 2023, 2024}, do_report=False, verbose=True)

    # fit calibration on 2022 only
    fit = rec[rec.season == FIT]
    beta = fit_platt(fit.p_td.values, fit.scored.values.astype(float))
    rec["p_cal"] = apply_platt(rec.p_td.values, beta)
    print(f"\nPlatt calibration fit on {FIT}:  a={beta[0]:.3f}  b={beta[1]:.3f}")

    test = rec[rec.season.isin(TEST)].copy()
    tgames = games[games.season.isin(TEST)].copy()
    y = test.scored.values

    print("\n" + "=" * 72)
    print(f"OUT-OF-SAMPLE TEST  seasons={sorted(TEST)}   "
          f"player-game predictions={len(test):,}   games={len(tgames):,}")
    print("=" * 72)

    base = y.mean()
    print(f"\n[Probability quality]   anytime-TD base rate among ranked players = {base:.3f}")
    print(block("constant base rate", y, np.full(len(y), base)))
    print(block("model (raw Poisson)", y, test.p_td.values))
    print(block("model (calibrated)", y, test.p_cal.values))
    _, ece_raw = bt.calibration(y, test.p_td.values)
    _, ece_cal = bt.calibration(y, test.p_cal.values)
    print(f"  Expected Calibration Error:  raw={ece_raw:.4f}   calibrated={ece_cal:.4f}")

    print("\n[Calibrated reliability]  (test seasons)")
    rows, _ = bt.calibration(y, test.p_cal.values)
    print("  predicted-bin      n     mean-pred   actual")
    for lo, hi, n, mp, ma in rows:
        print(f"   {lo:.1f}-{hi:.1f}      {n:6d}     {mp:.3f}      {ma:.3f}   {'#'*int(ma*40)}")

    print("\n[Pick accuracy]  (rank players across both teams)")
    t1, t2, vol = tgames.top1_hit.mean(), tgames.top2_hit.mean(), tgames.vol_top1_hit.mean()
    print(f"  Top-1 pick scored a TD        : {t1:.1%}   (volume baseline {vol:.1%};  lift {t1-vol:+.1%})")
    print(f"  Top-2: at least one scored    : {t2:.1%}")
    print(f"  Top-1 lift over avg player    : {t1/base:.2f}x")
    print(f"  Recall@2 / @3 (mean/game)     : {tgames.recall_at2.mean():.1%} / {tgames.recall_at3.mean():.1%}")
    print(f"  Scorer coverage               : {tgames.n_scorers_covered.sum()/tgames.n_scorers.sum():.1%}")

    print("\n[Confidence validation]  top-1 hit rate by confidence tier (test)")
    tgames["cbin"] = pd.cut(tgames.top1_conf, [0, 45, 60, 75, 100], include_lowest=True)
    for b, sub in tgames.groupby("cbin", observed=True):
        print(f"  {str(b):14s} n={len(sub):4d}   hit={sub.top1_hit.mean():.1%}   avg stated p={sub.top1_p.mean():.3f}")

    # ---- example games for the writeup (calibrated likelihood + confidence) ----
    print("\n[Example predictions]  (test seasons; top-2 picks per game)")
    ex_ids = (tgames.sort_values("game_id")
              .iloc[[20, 120, 240, 360, 480, 540]].game_id.tolist())
    examples = []
    for gid in ex_ids:
        sub = test[test.game_id == gid].sort_values("p_cal", ascending=False)
        if len(sub) < 2:
            continue
        picks = []
        for r in sub.head(2).itertuples():
            picks.append(dict(player=r.player, team=r.team, opp=r.opp,
                              likelihood=round(float(r.p_cal), 3),
                              confidence=float(r.conf), scored=int(r.scored)))
        line = " vs ".join({sub.iloc[0].team, sub.iloc[0].opp})
        print(f"  {gid}")
        for pk in picks:
            mark = "TD  " if pk["scored"] else "no  "
            print(f"      {mark} {pk['player']:22s} ({pk['team']}) "
                  f"likelihood={pk['likelihood']:.0%}  confidence={pk['confidence']:.0f}")
        examples.append(dict(game_id=gid, picks=picks))

    out = dict(
        test_seasons=sorted(TEST), n_player_games=int(len(test)), n_games=int(len(tgames)),
        base_rate=float(base), platt=dict(a=float(beta[0]), b=float(beta[1])),
        brier_base=bt.brier(y, np.full(len(y), base)),
        brier_raw=bt.brier(y, test.p_td.values), brier_cal=bt.brier(y, test.p_cal.values),
        logloss_raw=bt.logloss(y, test.p_td.values), logloss_cal=bt.logloss(y, test.p_cal.values),
        auc=bt.auc(y, test.p_td.values), ece_raw=ece_raw, ece_cal=ece_cal,
        top1_hit=float(t1), top2_hit=float(t2), vol_top1_hit=float(vol), top1_lift=float(t1/base),
        recall_at2=float(tgames.recall_at2.mean()), recall_at3=float(tgames.recall_at3.mean()),
        scorer_coverage=float(tgames.n_scorers_covered.sum()/tgames.n_scorers.sum()),
        examples=examples,
    )
    with open(os.path.join(HERE, "final_metrics.json"), "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved final_metrics.json to {HERE}")


if __name__ == "__main__":
    main()
