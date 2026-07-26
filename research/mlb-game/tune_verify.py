"""
Two questions the bake-off leaves open, answered rigorously:

  1. Is the winner (pitcher-adjusted Elo) REALLY better than the Poisson /
     Dixon-Coles family the platform currently ships for MLB, or is the gap
     noise?  -> paired bootstrap over the 2024 test games.

  2. What are the best hyperparameters for it?  -> a fast standalone sweep,
     tuned on 2023 (validation) with 2021-22 as warm-up, then confirmed ONCE on
     the untouched 2024 test season.
"""
import os, math, warnings
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

import bakeoff_mlb as B

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


# --------------------------------------------------------------------------
def elo_pitcher_walk(df, k=4.0, hfa=24.0, pw=26.0, carry=0.70, mov=True, sp_k=6.0):
    """Standalone pitcher-adjusted margin-of-victory Elo. Returns raw signal."""
    lg = float((df.home_score.sum() + df.away_score.sum()) / (2 * len(df)))
    elo = defaultdict(lambda: 1500.0)
    sp_r, sp_g = defaultdict(float), defaultdict(int)
    out = np.empty(len(df)); season = None

    def spq(pid):
        if pid is None or (isinstance(pid, float) and math.isnan(pid)) or sp_g[pid] == 0:
            return lg
        return (sp_r[pid] + sp_k * lg) / (sp_g[pid] + sp_k)

    for i, g in enumerate(df.itertuples()):
        if g.season != season:
            if season is not None:
                for t in list(elo):
                    elo[t] = 1500 + carry * (elo[t] - 1500)
            season = g.season
        h, a = g.home, g.away
        gap = (elo[h] + hfa) - elo[a] + pw * (spq(g.away_sp) - spq(g.home_sp))
        out[i] = gap
        # update
        hw = 1 if g.home_score > g.away_score else 0
        exp_h = 1 / (1 + 10 ** (-((elo[h] + hfa) - elo[a]) / 400))
        mult = math.log(abs(g.home_score - g.away_score) + 1) if mov else 1.0
        d = k * mult * (hw - exp_h)
        elo[h] += d; elo[a] -= d
        if not pd.isna(g.home_sp):
            sp_r[g.home_sp] += g.away_score; sp_g[g.home_sp] += 1
        if not pd.isna(g.away_sp):
            sp_r[g.away_sp] += g.home_score; sp_g[g.away_sp] += 1
    return out


def fit_eval(sig, df, train_seasons, test_season):
    tr = df.season.isin(train_seasons).values
    te = (df.season == test_season).values
    y = df.home_win.values
    lr = LogisticRegression(max_iter=1000).fit(sig[tr].reshape(-1, 1), y[tr])
    p = lr.predict_proba(sig[te].reshape(-1, 1))[:, 1]
    return p, y[te]


def metrics(y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return dict(auc=B.auc(y, p), acc=float(((p >= .5) == (y == 1)).mean()),
                brier=float(np.mean((p - y) ** 2)),
                logloss=float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))))


def main():
    df = pd.read_csv(os.path.join(DATA, "games.csv"))
    B.LG_RUNS = float((df.home_score.sum() + df.away_score.sum()) / (2 * len(df)))

    # ---------- 1. significance vs what the platform ships ----------
    print("re-running the full walk for paired significance testing ...")
    sigs, _ = B.walk(df)
    tr = sigs[sigs.season.isin({2021, 2022, 2023})]
    te = sigs[sigs.season == 2024]
    ytr, yte = tr.home_win.values, te.home_win.values

    def prob(col):
        return B.platt(tr[col].values, ytr, te[col].values)

    cand = {c: prob(c) for c in ["elo_plus_pitcher", "elo_margin_of_victory",
                                 "dixon_coles", "poisson_skellam", "bradley_terry"]}
    rng = np.random.default_rng(0)
    n = len(yte)

    def boot(pa, pb, iters=4000):
        da, db = [], []
        for _ in range(iters):
            idx = rng.integers(0, n, n)
            yy = yte[idx]
            if yy.min() == yy.max():
                continue
            da.append(B.auc(yy, pa[idx]) - B.auc(yy, pb[idx]))
            db.append(np.mean((pb[idx] - yy) ** 2) - np.mean((pa[idx] - yy) ** 2))
        return (np.mean(da), np.percentile(da, 2.5), np.percentile(da, 97.5),
                np.mean(db), np.percentile(db, 2.5), np.percentile(db, 97.5))

    print("\n[Significance] pitcher-adjusted Elo vs the alternatives (paired bootstrap, 2,432 games)")
    print(f"  {'comparison':38s} {'dAUC':>8}  {'95% CI':>20}  {'dBrier':>9}  verdict")
    for other in ["dixon_coles", "poisson_skellam", "elo_margin_of_victory", "bradley_terry"]:
        m, lo, hi, bm, blo, bhi = boot(cand["elo_plus_pitcher"], cand[other])
        v = "SIGNIFICANT" if lo > 0 else "within noise"
        print(f"  vs {other:35s} {m:>+8.4f}  [{lo:+.4f}, {hi:+.4f}]  {bm:>+9.5f}  {v}")

    # ---------- 2. hyperparameter sweep (validate on 2023) ----------
    print("\n[Tuning] pitcher-adjusted Elo — validation season 2023 (2021-22 warm-up)")
    grid = []
    for k in (3.0, 4.0, 6.0):
        for pw in (0.0, 18.0, 26.0, 40.0):
            grid.append(dict(k=k, pw=pw, hfa=24.0, carry=0.70))
    for hfa in (18.0, 30.0):
        grid.append(dict(k=4.0, pw=26.0, hfa=hfa, carry=0.70))
    for carry in (0.50, 0.85):
        grid.append(dict(k=4.0, pw=26.0, hfa=24.0, carry=carry))

    rows = []
    for cfg in grid:
        s = elo_pitcher_walk(df, **cfg)
        p, y = fit_eval(s, df, {2021, 2022}, 2023)
        rows.append({**cfg, **metrics(y, p)})
    V = pd.DataFrame(rows).sort_values("auc", ascending=False)
    print(f"  {'k':>4} {'pitcher_w':>10} {'hfa':>5} {'carry':>6} {'val AUC':>8} {'val acc':>8}")
    for r in V.head(8).itertuples():
        print(f"  {r.k:>4} {r.pw:>10} {r.hfa:>5} {r.carry:>6} {r.auc:>8.4f} {r.acc:>8.1%}")
    best = V.iloc[0]
    print(f"  -> best config: k={best.k} pitcher_weight={best.pw} hfa={best.hfa} carry={best.carry}")

    # ---------- 3. confirm ONCE on the untouched test season ----------
    s = elo_pitcher_walk(df, k=float(best.k), pw=float(best.pw),
                         hfa=float(best.hfa), carry=float(best.carry))
    p, y = fit_eval(s, df, {2021, 2022, 2023}, 2024)
    tuned = metrics(y, p)
    s0 = elo_pitcher_walk(df)          # default config
    p0, _ = fit_eval(s0, df, {2021, 2022, 2023}, 2024)
    print("\n[Confirmation] untouched 2024 test season")
    print(f"  default  Elo+pitcher : AUC={metrics(y, p0)['auc']:.4f}  acc={metrics(y, p0)['acc']:.1%}")
    print(f"  TUNED    Elo+pitcher : AUC={tuned['auc']:.4f}  acc={tuned['acc']:.1%}  "
          f"Brier={tuned['brier']:.4f}  logloss={tuned['logloss']:.4f}")
    dc = metrics(yte, cand["dixon_coles"])
    print(f"  shipped-family (Dixon-Coles): AUC={dc['auc']:.4f}  acc={dc['acc']:.1%}  "
          f"Brier={dc['brier']:.4f}")
    print(f"  --> improvement over shipped family: AUC {tuned['auc']-dc['auc']:+.4f}, "
          f"accuracy {tuned['acc']-dc['acc']:+.1%}")

    # accuracy by confidence, for the tuned winner
    print("\n[Calibration by confidence] tuned Elo+pitcher, 2024")
    conf = np.maximum(p, 1 - p)
    pick_right = ((p >= .5) == (y == 1))
    for lo, hi in [(.50, .54), (.54, .58), (.58, .62), (.62, 1.0)]:
        m = (conf >= lo) & (conf < hi)
        if m.sum() > 20:
            print(f"  conf {lo:.0%}-{hi:.0%}: n={m.sum():5d}  actual win rate={pick_right[m].mean():.1%}")

    pd.DataFrame([{"config": "tuned", **{k: float(best[k]) for k in ('k', 'pw', 'hfa', 'carry')},
                   **tuned}]).to_csv(os.path.join(HERE, "tuned_winner.csv"), index=False)


if __name__ == "__main__":
    main()
