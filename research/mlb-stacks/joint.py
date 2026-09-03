"""
The joint question: do the highest-scoring teams and 2+ total-base hitters work
*together*?

Each half is already a model. `bakeoff_team.py` ranks the night's offences and
research/mlb-props prices a hitter's 2+ total bases. Bet either one on its own
and you are pricing a marginal. Bet them together — a team total plus a hitter
off that same lineup, or three hitters from one lineup — and independence is
simply wrong: the whole point of a stack is that the legs rise together.

This script measures five things, all on the 2026 season neither model saw:

  A  does the team's projected offence add anything to the 2+ TB model, on top
     of the team context that model already carries?
  B  the 2+ TB hit rate on a grid of player rating x team rating
  C  the two-leg correlated bet: team total over AND a hitter off that lineup
  D  same-team stacks of k hitters, observed vs independence, against a
     cross-game control that should be (and is) independent
  E  a one-parameter latent-factor (Gaussian copula) model of a stack, fit on
     2024-25 and verified on 2026, which is what the app ships

Usage: python3 joint.py
"""

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler
from scipy.special import ndtr, ndtri
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS_DATA = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
from bakeoff import apply_platt, auc, brier, logloss, platt  # noqa: E402
from features import BATTER_FEATURES  # noqa: E402

from features_team import TEAM_FEATURES  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026
RNG = 0
# 24-node Gauss-Hermite is exact to ~1e-10 here and cheap enough to re-run in
# the browser; the app uses the same nodes.
GH_N = 24


# ---------------------------------------------------------------- utilities
def fit_predict(df, feats, ycol, extra_train=None):
    """Fit on TRAIN, return (p_test, p_train_oof, test_mask)."""
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    X = df[feats].values.astype(float)
    y = df[ycol].values.astype(int)
    sc = StandardScaler().fit(X[tr])
    Xtr, Xte = sc.transform(X[tr]), sc.transform(X[te])
    lr = LogisticRegression(max_iter=3000).fit(Xtr, y[tr])
    # Platt on the training seasons, matching what research/mlb-props/final.py
    # freezes into the shipped model — the correlation below has to be fitted
    # against the same marginals the app will serve.
    pb = platt(lr.predict_proba(Xtr)[:, 1], y[tr])
    p_te = apply_platt(lr.predict_proba(Xte)[:, 1], pb)
    # out-of-fold on the training seasons, so the correlation fit never sees a
    # probability that was fitted on its own row
    oof = np.zeros(tr.sum())
    skf = StratifiedKFold(n_splits=3, shuffle=True, random_state=RNG)
    for a, b in skf.split(Xtr, y[tr]):
        m = LogisticRegression(max_iter=3000).fit(Xtr[a], y[tr][a])
        pbf = platt(m.predict_proba(Xtr[a])[:, 1], y[tr][a])
        oof[b] = apply_platt(m.predict_proba(Xtr[b])[:, 1], pbf)
    return p_te, oof, tr, te


def boot_auc_delta(y, pa, pb, n=400):
    """Bootstrap CI for auc(pb) - auc(pa)."""
    rng = np.random.RandomState(RNG)
    d = np.empty(n)
    idx = np.arange(len(y))
    for i in range(n):
        s = rng.choice(idx, len(idx), replace=True)
        if y[s].sum() in (0, len(s)):
            d[i] = np.nan
            continue
        d[i] = auc(y[s], pb[s]) - auc(y[s], pa[s])
    return float(np.nanmean(d)), float(np.nanpercentile(d, 2.5)), float(np.nanpercentile(d, 97.5))


# --------------------------------------------------- latent-factor stacking
_GH_X, _GH_W = np.polynomial.hermite_e.hermegauss(GH_N)
_GH_W = _GH_W / _GH_W.sum()


def stack_prob(ps, rho):
    """P(all legs hit) under one shared team factor with correlation rho.

    Y_i = 1 iff sqrt(rho) Z + sqrt(1-rho) e_i > -Phi^-1(p_i), with Z the team's
    night and e_i the hitter's own. Marginals are exactly p_i for any rho; rho
    is the only free parameter and it is what independence gets wrong.
    """
    return float(stack_prob_many(np.asarray(ps, dtype=float)[None, :], rho)[0])


def stack_prob_many(P, rho):
    """Vectorised stack_prob over a (n, k) matrix of leg probabilities."""
    P = np.clip(np.asarray(P, dtype=float), 1e-9, 1 - 1e-9)
    if rho <= 0:
        return P.prod(axis=1)
    a = ndtri(P)                                   # (n, k)
    z = np.sqrt(rho) * _GH_X                       # (m,)
    cond = ndtr((a[:, None, :] + z[None, :, None]) / np.sqrt(1.0 - rho))
    return (cond.prod(axis=2) * _GH_W[None, :]).sum(axis=1)


def fit_rho(groups, lo=0.0, hi=0.7, it=40):
    """Match the observed all-hit rate of the groups by bisection on rho."""
    P = np.array([g["p"] for g in groups], dtype=float)
    obs = float(np.mean([g["hit"] for g in groups]))

    def pred(r):
        return float(stack_prob_many(P, r).mean())

    if pred(hi) < obs:
        return hi, obs, pred(hi)
    if pred(lo) > obs:
        return lo, obs, pred(lo)
    for _ in range(it):
        mid = (lo + hi) / 2
        if pred(mid) < obs:
            lo = mid
        else:
            hi = mid
    r = (lo + hi) / 2
    return r, obs, pred(r)


def main():
    out = {}
    tf = pd.read_csv(os.path.join(DATA, "team_features.csv"))
    bf = pd.read_csv(os.path.join(PROPS_DATA, "batter_features.csv"))
    print(f"team rows {len(tf):,}   batter rows {len(bf):,}")

    # ---------------------------------------------------------- team model
    p_team5_te, p_team5_oof, t_tr, t_te = fit_predict(tf, TEAM_FEATURES, "y_r5")
    Xt = tf[TEAM_FEATURES].values.astype(float)
    sct = StandardScaler().fit(Xt[t_tr])
    runs_lr = LinearRegression().fit(sct.transform(Xt[t_tr]), tf.runs.values[t_tr])
    exp_runs = runs_lr.predict(sct.transform(Xt))
    tf["p_team5"] = np.nan
    tf.loc[t_te, "p_team5"] = p_team5_te
    tf.loc[t_tr, "p_team5"] = p_team5_oof
    tf["exp_runs"] = exp_runs
    # slate rank: 1 = the night's highest projected offence
    tf["team_rank"] = tf.groupby("date").exp_runs.rank(ascending=False, method="first")
    tf["n_teams"] = tf.groupby("date").exp_runs.transform("size")

    print(f"\nteam model  test AUC(5+ runs) = {auc(tf.y_r5.values[t_te], p_team5_te):.4f}")

    # -------------------------------------------------------- player model
    own = ["own_tb2", "ownw_tb2"]
    p_tb2_te, p_tb2_oof, b_tr, b_te = fit_predict(bf, BATTER_FEATURES + own, "y_tb2")
    bf["p_tb2"] = np.nan
    bf.loc[b_te, "p_tb2"] = p_tb2_te
    bf.loc[b_tr, "p_tb2"] = p_tb2_oof
    y_tb2 = bf.y_tb2.values.astype(int)
    print(f"player model test AUC(2+ TB)   = {auc(y_tb2[b_te], p_tb2_te):.4f}  "
          f"base {y_tb2[b_te].mean():.4f}")

    # ------------------------------------------------------------ the join
    keys = ["gamePk", "team_id"]
    tcols = keys + ["p_team5", "exp_runs", "team_rank", "n_teams", "runs",
                    "y_r4", "y_r5", "y_r6", "team"]
    j = bf.merge(tf[tcols], on=keys, how="inner", suffixes=("", "_t"))
    print(f"joined rows {len(j):,}  ({j.p_team5.notna().mean():.1%} with a team rating)")
    jte = j[j.season == TEST].copy()
    jtr = j[j.season.isin(TRAIN)].copy()

    # ============================================== A: does the team help?
    print("\n=== A. Does the team's projected offence add to the 2+ TB model? ===")
    aug = BATTER_FEATURES + own + ["team_logit", "exp_runs"]
    for d in (j,):
        d["team_logit"] = np.log(np.clip(d.p_team5, 1e-6, 1 - 1e-6) /
                                 (1 - np.clip(d.p_team5, 1e-6, 1 - 1e-6)))
    p_aug_te, _, a_tr, a_te = fit_predict(j, aug, "y_tb2")
    yj = j.y_tb2.values.astype(int)
    base_te = j.p_tb2.values[a_te]
    a0, a1 = auc(yj[a_te], base_te), auc(yj[a_te], p_aug_te)
    m, lo, hi = boot_auc_delta(yj[a_te], base_te, p_aug_te)
    print(f"  2+ TB alone      AUC {a0:.4f}   brier {brier(yj[a_te], base_te):.4f}")
    print(f"  + team offence   AUC {a1:.4f}   brier {brier(yj[a_te], p_aug_te):.4f}")
    print(f"  delta {a1 - a0:+.4f}   bootstrap 95% [{lo:+.4f}, {hi:+.4f}]")
    out["A_add_team_to_player"] = dict(auc_player=a0, auc_augmented=a1,
                                       delta=a1 - a0, ci=[lo, hi],
                                       n=int(a_te.sum()))

    # ================================== B: hit rate on the two-way grid
    print("\n=== B. 2+ TB hit rate by player rating x team rating (2026) ===")
    g = jte.copy()
    g["pq"] = pd.qcut(g.p_tb2, 5, labels=[1, 2, 3, 4, 5]).astype(int)
    g["tq"] = pd.qcut(g.exp_runs, 5, labels=[1, 2, 3, 4, 5]).astype(int)
    grid = g.pivot_table(index="pq", columns="tq", values="y_tb2", aggfunc="mean")
    cnt = g.pivot_table(index="pq", columns="tq", values="y_tb2", aggfunc="size")
    print("  rows = player-rating quintile, cols = team-offence quintile")
    print((grid * 100).round(1).to_string())
    print(f"  cell sizes {int(cnt.values.min()):,}-{int(cnt.values.max()):,}")
    spread = float(grid[5].mean() - grid[1].mean())
    print(f"  mean gap between the best and worst team column: {spread*100:+.1f} pts")
    top = float(grid.loc[5, 5]); bot = float(grid.loc[5, 1])
    print(f"  top player quintile: {bot*100:.1f}% on the worst offences -> "
          f"{top*100:.1f}% on the best ({top/bot:.2f}x)")
    out["B_grid"] = dict(grid=grid.round(4).to_dict(), spread=spread,
                         top_row_ratio=top / bot)

    # ============================ C: the two-leg bet, team total + hitter
    print("\n=== C. Team total over 4.5 AND a hitter off that lineup, 2+ TB ===")
    c = jte.copy()
    c["joint"] = (c.y_r5.astype(int) * c.y_tb2.astype(int))
    c["indep"] = c.p_team5 * c.p_tb2
    obs, ind = float(c.joint.mean()), float(c.indep.mean())
    print(f"  all {len(c):,} pairs: observed {obs:.4f}  independence {ind:.4f}  "
          f"lift {obs/ind:.3f}x")
    # the way you would actually bet it: the day's best combined pairs
    for n in (1, 3, 5):
        d = c.sort_values("indep", ascending=False).groupby("date").head(n)
        print(f"  day's top {n} pairs: observed {d.joint.mean():.4f}  "
              f"independence {d.indep.mean():.4f}  lift {d.joint.mean()/d.indep.mean():.3f}x "
              f"(n={len(d):,})")
    out["C_two_leg"] = dict(observed=obs, independence=ind, lift=obs / ind, n=len(c))

    # ================================== D: same-team stacks vs a control
    print("\n=== D. Same-team stacks of k hitters, all 2+ TB ===")

    def stacks_from(df, k):
        rows = []
        for _, gg in df.groupby(["gamePk", "team_id"], sort=False):
            gg = gg.nlargest(k, "p_tb2")
            if len(gg) < k:
                continue
            rows.append(dict(p=gg.p_tb2.values, hit=int(gg.y_tb2.sum() == k),
                             date=gg.date.iloc[0]))
        return rows

    # A control that isolates correlation from calibration: same k legs, same
    # marginals, but each leg from a *different* game on the same night. If the
    # lift over independence is the same in both, the lift is the model being
    # slightly under-confident at the top, not the legs moving together.
    rng = np.random.RandomState(RNG)

    def matched_control(df, k, reps=3):
        rows = []
        for d, gg in df.groupby("date"):
            gg = gg.sort_values("p_tb2").reset_index(drop=True)
            pv = gg.p_tb2.values
            games = gg.gamePk.values
            by_game = {}
            for i, g in enumerate(games):
                by_game.setdefault(g, []).append(i)
            if len(by_game) < k:
                continue
            for _, tgt in df[df.date == d].groupby(["gamePk", "team_id"], sort=False):
                tgt = tgt.nlargest(k, "p_tb2")
                if len(tgt) < k:
                    continue
                for _ in range(reps):
                    used, sel = set(), []
                    ok = True
                    for want in tgt.p_tb2.values:
                        # nearest probability from a game not already used
                        order = np.argsort(np.abs(pv - want))
                        pick = next((i for i in order[:400]
                                     if games[i] not in used), None)
                        if pick is None:
                            ok = False
                            break
                        used.add(games[pick])
                        sel.append(pick)
                    if not ok:
                        continue
                    rows.append(dict(p=pv[sel],
                                     hit=int(gg.y_tb2.values[sel].sum() == k),
                                     date=d))
        return rows

    dres = []
    for k in (2, 3, 4, 5):
        st = stacks_from(jte, k)
        obs = float(np.mean([s["hit"] for s in st]))
        ind = float(np.mean([np.prod(s["p"]) for s in st]))
        ct = matched_control(jte, k)
        cobs = float(np.mean([s["hit"] for s in ct]))
        cind = float(np.mean([np.prod(s["p"]) for s in ct]))
        print(f"  k={k}  same team: observed {obs:.4f} vs independence {ind:.4f} "
              f"= {obs/ind:.3f}x  (n={len(st):,})")
        print(f"        matched  : observed {cobs:.4f} vs independence {cind:.4f} "
              f"= {cobs/cind:.3f}x  (n={len(ct):,})")
        dres.append(dict(k=k, observed=obs, independence=ind, lift=obs / ind,
                         n=len(st), control_lift=cobs / cind, control_n=len(ct),
                         control_observed=cobs, control_independence=cind))
    out["D_stacks"] = dres

    # The cleanest statistic: correlation of the residuals y - p. Two hitters
    # in one lineup vs two hitters in different games on the same night.
    print("\n  residual correlation of 2+ TB, pooled over all three seasons:")
    allj = j[j.p_tb2.notna()].copy()
    allj["res"] = allj.y_tb2 - allj.p_tb2

    def pair_corr(df, same_team):
        xs, ys = [], []
        for d, gg in df.groupby("date"):
            if same_team:
                for _, tt in gg.groupby(["gamePk", "team_id"], sort=False):
                    v = tt.res.values
                    for a in range(len(v)):
                        for b in range(a + 1, len(v)):
                            xs.append(v[a]); ys.append(v[b])
            else:
                games = gg.gamePk.unique()
                if len(games) < 2:
                    continue
                for _ in range(len(gg)):
                    g1, g2 = rng.choice(games, 2, replace=False)
                    a = gg[gg.gamePk == g1].res.values
                    b = gg[gg.gamePk == g2].res.values
                    xs.append(a[rng.randint(len(a))])
                    ys.append(b[rng.randint(len(b))])
        x, y = np.array(xs), np.array(ys)
        r = float(np.corrcoef(x, y)[0, 1])
        return r, len(x)

    r_same, n_same = pair_corr(allj, True)
    r_diff, n_diff = pair_corr(allj, False)
    print(f"    two hitters, same lineup    r = {r_same:+.4f}  (n={n_same:,} pairs)")
    print(f"    two hitters, different games r = {r_diff:+.4f}  (n={n_diff:,} pairs)")
    tres = allj.drop_duplicates(["gamePk", "team_id"]).copy()
    rt = float(np.corrcoef(allj.y_tb2 - allj.p_tb2, allj.y_r5 - allj.p_team5)[0, 1])
    print(f"    hitter 2+ TB vs his team's 5+ runs  r = {rt:+.4f} "
          f"(n={len(allj):,})")
    out["D_residual_corr"] = dict(same_lineup=r_same, different_games=r_diff,
                                  hitter_vs_team=rt, n_same=n_same, n_diff=n_diff)

    # ==================== E: one-parameter latent factor, fit then verified
    print("\n=== E. Latent-factor stack model (fit 2024-25, tested on 2026) ===")

    def all_pairs(df, cap=None):
        """Every same-lineup pair of starters — the representative sample, not
        just the two best hitters (whose joint rate is confounded by the prop
        model's calibration at the very top of its own distribution)."""
        rows = []
        for _, tt in df.groupby(["gamePk", "team_id"], sort=False):
            pv, yv = tt.p_tb2.values, tt.y_tb2.values
            n = len(pv)
            for i in range(n):
                for jx in range(i + 1, n):
                    rows.append(dict(p=np.array([pv[i], pv[jx]]),
                                     hit=int(yv[i] == 1 and yv[jx] == 1)))
        if cap and len(rows) > cap:
            idx = np.random.RandomState(RNG).choice(len(rows), cap, replace=False)
            rows = [rows[i] for i in idx]
        return rows

    tr_pairs = all_pairs(jtr, cap=250000)
    rho, obs2, pred2 = fit_rho(tr_pairs)
    print(f"  hitter-hitter rho, fitted on {len(tr_pairs):,} same-lineup pairs "
          f"= {rho:.4f}  (train observed {obs2:.4f}, model {pred2:.4f})")
    te_pairs = all_pairs(jte)
    o = float(np.mean([x["hit"] for x in te_pairs]))
    i0 = float(np.mean([np.prod(x["p"]) for x in te_pairs]))
    i1 = float(stack_prob_many([x["p"] for x in te_pairs], rho).mean())
    print(f"  2026, all {len(te_pairs):,} same-lineup pairs: observed {o:.4f}  "
          f"independence {i0:.4f} ({i0/o - 1:+.1%})  latent {i1:.4f} ({i1/o - 1:+.1%})")
    out["E_pairs"] = dict(rho=rho, observed=o, independence=i0, latent=i1,
                          n=len(te_pairs), n_train=len(tr_pairs))

    rows = []
    for k in (2, 3, 4, 5):
        st = stacks_from(jte, k)
        obs = float(np.mean([x["hit"] for x in st]))
        ind = float(np.mean([np.prod(x["p"]) for x in st]))
        mod = float(stack_prob_many([x["p"] for x in st], rho).mean())
        rows.append(dict(k=k, observed=obs, independence=ind, latent=mod, n=len(st)))
        print(f"  top-{k} hitters of a lineup: observed {obs:.4f}   "
              f"independence {ind:.4f} ({ind/obs - 1:+.1%})   "
              f"latent {mod:.4f} ({mod/obs - 1:+.1%})")
    out["E_latent"] = dict(rho=rho, rows=rows)

    # ---- the leg that actually is correlated: the team total ----
    def team_pairs(df, best_only=True):
        rows = []
        for _, gg in df.groupby(["gamePk", "team_id"], sort=False):
            sel = gg.nlargest(1, "p_tb2") if best_only else gg
            for b_ in sel.itertuples():
                rows.append(dict(p=np.array([b_.p_team5, b_.p_tb2]),
                                 hit=int(b_.y_r5 == 1 and b_.y_tb2 == 1)))
        return rows

    tp_tr = all_team_pairs = team_pairs(jtr, best_only=False)
    rho_t, obst, predt = fit_rho(tp_tr)
    for label, tp_te in (("every starter", team_pairs(jte, best_only=False)),
                         ("best hitter of each lineup", team_pairs(jte))):
        obs_te = float(np.mean([x["hit"] for x in tp_te]))
        ind_te = float(np.mean([np.prod(x["p"]) for x in tp_te]))
        mod_te = float(stack_prob_many([x["p"] for x in tp_te], rho_t).mean())
        print(f"  team total 4.5 + 2+ TB, {label}: observed {obs_te:.4f}  "
              f"independence {ind_te:.4f} ({ind_te/obs_te - 1:+.1%})  "
              f"latent {mod_te:.4f} ({mod_te/obs_te - 1:+.1%})  n={len(tp_te):,}")
        if label == "every starter":
            out["E_team_leg"] = dict(rho=rho_t, observed=obs_te,
                                     independence=ind_te, latent=mod_te,
                                     n=len(tp_te), n_train=len(tp_tr))
    print(f"  team-leg rho fitted on {len(tp_tr):,} train pairs = {rho_t:.4f}")

    # calibration of the prop model at the top, which is what confounds the
    # top-k stack table above
    dec = jte.copy()
    dec["d"] = pd.qcut(dec.p_tb2, 10, labels=False)
    tail = dec[dec.d == 9]
    print(f"  (2+ TB model top decile: predicted {tail.p_tb2.mean():.4f}, "
          f"actual {tail.y_tb2.mean():.4f} — the top-k table inherits this)")
    out["E_top_decile"] = dict(pred=float(tail.p_tb2.mean()),
                               actual=float(tail.y_tb2.mean()), n=len(tail))

    # ============ F: gating 2+ TB picks on the night's biggest offences
    print("\n=== F. Gate 2+ TB picks on the team's slate rank ===")
    f = jte.copy()
    f["top3"] = (f.team_rank <= 3).astype(int)
    allrate = float(f.y_tb2.mean())
    for n in (1, 3, 5, 8):
        m = f[f.team_rank <= n]
        print(f"  hitters on the night's top-{n} projected offences: "
              f"{m.y_tb2.mean()*100:.1f}%  (n={len(m):,}, all hitters {allrate*100:.1f}%)")
    # best pick of the day, with and without the gate
    def daily_top(df, n, gate=None):
        d = df if gate is None else df[df.team_rank <= gate]
        return float(d.sort_values("p_tb2", ascending=False)
                     .groupby("date").head(n).y_tb2.mean())
    for n in (1, 3, 5):
        a, b = daily_top(f, n), daily_top(f, n, 5)
        print(f"  day's top {n} 2+ TB picks: ungated {a*100:.1f}%  "
              f"gated to top-5 offences {b*100:.1f}%  ({b-a:+.1%})")
    out["F_gate"] = {f"top{n}": float(f[f.team_rank <= n].y_tb2.mean())
                     for n in (1, 3, 5, 8)}
    out["F_gate"]["all"] = allrate

    # ============ G: the card — correlated two- and three-leg team stacks
    print("\n=== G. The shipped card: team total + hitters off that lineup ===")
    card = jte.copy()
    card["p_pair"] = stack_prob_many(card[["p_team5", "p_tb2"]].values, rho_t)
    card["y_pair"] = (card.y_r5.astype(int) * card.y_tb2.astype(int))
    card["p_indep"] = card.p_team5 * card.p_tb2
    tiers = []
    q = card.p_pair.quantile([0.95, 0.85, 0.65]).values
    for label, lo_, hi_ in (("Strong", q[0], 1.1), ("Solid", q[1], q[0]),
                            ("Lean", q[2], q[1]), ("Rest", 0.0, q[2])):
        m = card[(card.p_pair >= lo_) & (card.p_pair < hi_)]
        be = (100 * (1 - m.y_pair.mean()) / m.y_pair.mean()) if m.y_pair.mean() else float("nan")
        print(f"  {label:7s} n={len(m):6,}  predicted {m.p_pair.mean():.4f}  "
              f"actual {m.y_pair.mean():.4f}  independence would say "
              f"{m.p_indep.mean():.4f}  breakeven +{be:.0f}")
        tiers.append(dict(label=label, minProb=float(lo_), n=int(len(m)),
                          pred=float(m.p_pair.mean()),
                          actual=float(m.y_pair.mean()),
                          indep=float(m.p_indep.mean())))
    out["G_tiers"] = tiers
    for n in (1, 3, 5):
        d = card.sort_values("p_pair", ascending=False).groupby("date").head(n)
        print(f"  day's top {n}: actual {d.y_pair.mean():.4f}  "
              f"model {d.p_pair.mean():.4f}  independence {d.p_indep.mean():.4f}")
    out["G_daily"] = {f"top{n}": float(card.sort_values("p_pair", ascending=False)
                                       .groupby("date").head(n).y_pair.mean())
                      for n in (1, 3, 5)}

    # three legs: the team total plus its two best 2+ TB bats
    tri = []
    for _, gg in jte.groupby(["gamePk", "team_id"], sort=False):
        gg2 = gg.nlargest(2, "p_tb2")
        if len(gg2) < 2:
            continue
        tri.append(dict(p=np.array([gg2.p_team5.iloc[0], *gg2.p_tb2.values]),
                        hit=int(gg2.y_r5.iloc[0] == 1 and gg2.y_tb2.sum() == 2)))
    P3 = np.array([t["p"] for t in tri])
    obs3 = float(np.mean([t["hit"] for t in tri]))
    # the team leg is the shared factor, so price it with rho_t and let the two
    # hitters carry the (much weaker) hitter-hitter correlation on top
    mixed = float(stack_prob_many(P3, rho_t).mean())
    print(f"  three legs (team total + two bats): actual {obs3:.4f}  "
          f"independence {float(P3.prod(axis=1).mean()):.4f}  "
          f"latent {mixed:.4f}  n={len(tri):,}")
    out["G_three_leg"] = dict(observed=obs3, independence=float(P3.prod(axis=1).mean()),
                              latent=mixed, n=len(tri))

    json.dump(out, open(os.path.join(HERE, "joint_results.json"), "w"), indent=1)
    print(f"\nwrote {os.path.join(HERE, 'joint_results.json')}")


if __name__ == "__main__":
    main()
