"""
Why do picks miss, and can we see it coming?

A single miss on a 72% pick is not a defect — 28% of them are supposed to lose.
The question worth asking is whether misses **cluster**: if some pre-game
condition makes a 72% pick behave like a 60% pick, the model is miscalibrated in
that condition and we can flag it before the first pitch. If nothing predicts the
residual, the misses are irreducible and no flag is possible.

So this runs three passes over the 2026 hold-out:

  1. ANATOMY  — what physically happened in the games we missed (plate
     appearances lost, starters hooked early, blowouts, extra innings).
  2. RESIDUAL — for every pre-game feature, does the miss rate move with it once
     the model's own probability is accounted for? Bootstrap CIs, so noise does
     not get promoted to a finding.
  3. PREDICT  — fit an explicit miss-risk model on the first half of the season
     and test it on the second half. If it cannot beat "trust the probability"
     out of sample, there is nothing to flag.

Findings are written up in MISS-ANALYSIS.md. Short version: nothing predicts a
miss better than the published probability, and the two leads that looked real
(early-hook risk, a hot-month run-environment effect) both die out of sample —
the first because the model already prices it, the second because a correlation
computed over six month-aggregates does not survive being computed per game.

Usage: python3 miss_analysis.py
"""

import json
import os
import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression

from features import BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES, PITCHER_MARKETS

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
GAME_DATA = os.path.abspath(os.path.join(HERE, "..", "mlb-game", "data"))
MODEL = json.load(open(os.path.abspath(
    os.path.join(HERE, "..", "..", "src", "lib", "mlb-props-model.json"))))
TEST_SEASON = 2026
HIGH_BAR = 0.70          # the confidence bar the parlay card actually uses


# --------------------------------------------------------------------- utils
def predict(df, market):
    m = MODEL["markets"][market]
    X = df[m["features"]].values.astype(float)
    z = ((X - np.array(m["mean"])) / np.array(m["std"])) @ np.array(m["coef"]) + m["intercept"]
    raw = 1 / (1 + np.exp(-z))
    lg = np.log(np.clip(raw, 1e-9, 1 - 1e-9) / np.clip(1 - raw, 1e-9, 1 - 1e-9))
    return 1 / (1 + np.exp(-(m["plattA"] * lg + m["plattB"])))


def boot_mean(x, n=2000, seed=0):
    """Mean with a 95% bootstrap CI."""
    x = np.asarray(x, float)
    if len(x) < 30:
        return float(np.mean(x)) if len(x) else np.nan, np.nan, np.nan
    rng = np.random.default_rng(seed)
    d = rng.choice(x, (n, len(x)), replace=True).mean(axis=1)
    return float(x.mean()), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))


def logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def auc(y, p):
    y = np.asarray(y)
    p = np.asarray(p)
    o = p.argsort()
    r = np.empty(len(p))
    r[o] = np.arange(1, len(p) + 1)
    r = pd.DataFrame({"p": p, "r": r}).groupby("p").r.transform("mean").values
    n1 = y.sum()
    n0 = len(y) - n1
    return float("nan") if n1 == 0 or n0 == 0 else float(
        (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


# ------------------------------------------------------------------ assembly
def build():
    """One row per (pick, market) on the hold-out season, with pre-game features,
    the shipped probability, the outcome, and what actually happened in the game."""
    games = pd.read_csv(os.path.join(GAME_DATA, "games.csv"))
    games["total_runs"] = games.home_score + games.away_score
    games["margin"] = (games.home_score - games.away_score).abs()
    games["extras"] = (games.innings > 9).astype(int)
    gmap = games.set_index("gamePk")[["total_runs", "margin", "extras", "innings",
                                      "home_score", "away_score"]]

    bg = pd.read_csv(os.path.join(DATA, "batter_games.csv"))
    bg = bg[bg.season == TEST_SEASON][["gamePk", "batter_id", "pa", "ab", "h", "tb", "k", "bb"]]
    bf = pd.read_csv(os.path.join(DATA, "batter_features.csv"))
    bf = bf[bf.season == TEST_SEASON].copy()
    bf = bf.merge(bg, on=["gamePk", "batter_id"], how="left", suffixes=("", "_act"))

    pg = pd.read_csv(os.path.join(DATA, "pitcher_games.csv"))
    pg = pg[(pg.season == TEST_SEASON) & (pg.is_starter == 1)][
        ["gamePk", "pitcher_id", "k", "outs", "bf", "h_allowed", "bb_allowed", "er"]]
    pf = pd.read_csv(os.path.join(DATA, "pitcher_features.csv"))
    pf = pf[pf.season == TEST_SEASON].copy()
    pf = pf.merge(pg, on=["gamePk", "pitcher_id"], how="left", suffixes=("", "_act"))

    rows = []
    for mk in BATTER_MARKETS:
        d = bf.copy()
        d["market"] = mk
        d["kind"] = "batter"
        d["p"] = predict(d, mk)
        d["y"] = d[f"y_{mk}"]
        rows.append(d)
    for mk in PITCHER_MARKETS:
        d = pf.copy()
        d["market"] = mk
        d["kind"] = "pitcher"
        d["p"] = predict(d, mk)
        d["y"] = d[f"y_{mk}"]
        rows.append(d)

    all_rows = pd.concat(rows, ignore_index=True)
    all_rows = all_rows.join(gmap, on="gamePk")
    all_rows["miss"] = 1 - all_rows.y
    all_rows["resid"] = all_rows.y - all_rows.p
    return all_rows, bf, pf


# ------------------------------------------------------------- 1. the anatomy
def anatomy(df):
    print("=" * 78)
    print("1. ANATOMY — what actually happened when a confident pick missed")
    print("=" * 78)

    hi = df[df.p >= HIGH_BAR]
    print(f"\n{len(hi):,} picks at or above {HIGH_BAR:.0%} confidence; "
          f"{int(hi.miss.sum()):,} missed ({hi.miss.mean():.1%})\n")

    # --- batters: playing time is the mechanism to check first ---
    b = hi[(hi.kind == "batter") & hi.pa.notna()]
    if len(b):
        print("BATTERS — plate appearances actually received")
        print(f"{'PA':>4} {'picks':>7} {'miss rate':>10} {'share of misses':>16}")
        tot_miss = b.miss.sum()
        for pa in sorted(b.pa.unique()):
            s = b[b.pa == pa]
            if len(s) < 20:
                continue
            print(f"{int(pa):>4} {len(s):>7,} {s.miss.mean():>10.1%} "
                  f"{s.miss.sum() / tot_miss:>15.1%}")
        lo, hi_pa = b[b.pa <= 3], b[b.pa >= 4]
        print(f"\n  <=3 PA: {len(lo):,} picks, {lo.miss.mean():.1%} miss")
        print(f"  >=4 PA: {len(hi_pa):,} picks, {hi_pa.miss.mean():.1%} miss")
        print(f"  short days are {len(lo) / len(b):.1%} of confident picks but "
              f"{lo.miss.sum() / tot_miss:.1%} of the misses")

    # --- pitchers: length of the start ---
    p = hi[(hi.kind == "pitcher") & hi.outs.notna()]
    if len(p):
        print("\nPITCHERS — outs recorded in the start")
        for lo_o, hi_o, lbl in [(0, 11, "<4.0 IP (hooked)"), (12, 14, "4.0-4.2 IP"),
                                (15, 17, "5.0-5.2 IP"), (18, 99, "6.0+ IP")]:
            s = p[(p.outs >= lo_o) & (p.outs <= hi_o)]
            if len(s) < 20:
                continue
            print(f"  {lbl:18s} {len(s):>5,} picks  {s.miss.mean():>6.1%} miss  "
                  f"{s.miss.sum() / p.miss.sum():>6.1%} of misses")

    # --- game context ---
    print("\nGAME CONTEXT (confident picks)")
    for col, edges, lbl in [
        ("total_runs", [0, 5, 7, 9, 11, 99], "combined runs"),
        ("margin", [0, 1, 3, 5, 99], "final margin"),
    ]:
        print(f"  by {lbl}:")
        for a, bnd in zip(edges, edges[1:]):
            s = hi[(hi[col] >= a) & (hi[col] < bnd)]
            if len(s) < 50:
                continue
            print(f"    {a}-{bnd - 1:<3} {len(s):>6,} picks  {s.miss.mean():>6.1%} miss")
    ex = hi[hi.extras == 1]
    if len(ex) > 50:
        print(f"  extra innings: {len(ex):,} picks  {ex.miss.mean():.1%} miss "
              f"(vs {hi[hi.extras == 0].miss.mean():.1%} in 9)")


# --------------------------------------------- 2. does anything move the miss?
CANDIDATES_B = ["slot", "pa_pg", "gp", "is_home", "park", "team_r_pg", "opp_r_allowed_pg",
                "sp_k_bf", "sp_h_bf", "sp_bf_start", "sp_known", "h_pa", "k_pa", "bb_pa",
                "w_pa_pg", "w_g", "py_known", "iso"]
CANDIDATES_P = ["bf_start", "outs_start", "k_start", "gs", "days_rest", "is_home", "park",
                "opp_k_pa", "opp_h_pa", "opp_r_pg", "team_r_pg", "w_gs", "w_bf_start",
                "py_known", "k_bf"]


def residual_scan(df, kind, cands, min_n=200):
    """Mean residual (actual - predicted) by quintile of each pre-game feature.

    A calibrated model has residual ~0 everywhere. A quintile whose CI clears
    zero is a condition where the probability is systematically wrong.
    """
    print("\n" + "=" * 78)
    print(f"2. RESIDUAL SCAN — {kind}s, picks at or above {HIGH_BAR:.0%} confidence")
    print("   (actual minus predicted; negative = the model was too optimistic)")
    print("=" * 78)
    d = df[(df.kind == kind) & (df.p >= HIGH_BAR)]
    if len(d) < min_n:
        print(f"  only {len(d)} rows — skipped")
        return []
    findings = []
    for c in cands:
        if c not in d.columns or d[c].nunique() < 3:
            continue
        try:
            q = pd.qcut(d[c], 5, duplicates="drop", labels=False)
        except ValueError:
            continue
        cells = []
        for k in sorted(pd.unique(q.dropna())):
            s = d[q == k]
            if len(s) < min_n:
                continue
            m, lo, hi_ = boot_mean(s.resid.values)
            cells.append((k, len(s), s[c].mean(), m, lo, hi_))
        if not cells:
            continue
        sig = [x for x in cells if not np.isnan(x[4]) and (x[4] > 0 or x[5] < 0)]
        spread = max(x[3] for x in cells) - min(x[3] for x in cells)
        if sig or spread > 0.03:
            findings.append((c, spread, cells, len(sig)))
    findings.sort(key=lambda f: -f[1])
    for c, spread, cells, nsig in findings[:8]:
        flag = "  <-- significant cells" if nsig else ""
        print(f"\n  {c}  (spread {spread:+.3f}){flag}")
        print(f"    {'quintile':>8} {'n':>7} {'feature':>9} {'residual':>10} {'95% CI':>20}")
        for k, n, fv, m, lo, hi_ in cells:
            star = " *" if (not np.isnan(lo) and (lo > 0 or hi_ < 0)) else ""
            print(f"    {int(k) + 1:>8} {n:>7,} {fv:>9.3f} {m:>+10.3f} "
                  f"  [{lo:+.3f}, {hi_:+.3f}]{star}")
    if not findings:
        print("  nothing moved the residual by more than 0.03 — no conditional bias found")
    return findings


# ------------------------------------------------- 3. can we predict the miss?
def predictive(df):
    print("\n" + "=" * 78)
    print("3. PREDICT — fit a miss-risk model on the first half, test on the second")
    print("=" * 78)
    d = df[df.p >= HIGH_BAR].copy()
    d = d.sort_values("date")
    dates = np.sort(d.date.unique())
    cut = dates[int(len(dates) * 0.55)]
    tr, te = d[d.date <= cut], d[d.date > cut]
    print(f"  train {len(tr):,} picks (through {cut})   test {len(te):,} picks")
    print(f"  base miss rate: train {tr.miss.mean():.3f}   test {te.miss.mean():.3f}")

    feats = ["p", "slot", "pa_pg", "gp", "is_home", "park", "team_r_pg", "opp_r_allowed_pg",
             "sp_k_bf", "sp_h_bf", "sp_bf_start", "bf_start", "outs_start", "k_start",
             "days_rest", "opp_k_pa", "opp_h_pa", "opp_r_pg", "w_pa_pg", "w_gs", "k_bf"]
    feats = [f for f in feats if f in d.columns]
    Xtr = tr[feats].fillna(-1).values
    Xte = te[feats].fillna(-1).values

    # Baseline: the model's own probability is the only miss predictor allowed.
    base_p = 1 - te.p.values
    print(f"\n  baseline (1 - model probability):  AUC {auc(te.miss.values, base_p):.4f}   "
          f"logloss {logloss(te.miss.values, base_p):.4f}")

    for name, est in [
        ("logistic + features", LogisticRegression(max_iter=3000)),
        ("hist-GBM + features", HistGradientBoostingClassifier(
            max_iter=200, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1.0,
            random_state=0)),
    ]:
        est.fit(Xtr, tr.miss.values)
        p = est.predict_proba(Xte)[:, 1]
        print(f"  {name:26s} AUC {auc(te.miss.values, p):.4f}   "
              f"logloss {logloss(te.miss.values, p):.4f}")

    # Same question, stated as calibration: does adding features beat the
    # probability we already have, as an offset?
    lr = LogisticRegression(max_iter=3000).fit(
        np.column_stack([np.log(np.clip(tr.p, 1e-6, 1 - 1e-6) / (1 - np.clip(tr.p, 1e-6, 1 - 1e-6))),
                         Xtr[:, 1:]]), tr.y.values)
    lg_te = np.log(np.clip(te.p, 1e-6, 1 - 1e-6) / (1 - np.clip(te.p, 1e-6, 1 - 1e-6)))
    p_adj = lr.predict_proba(np.column_stack([lg_te, Xte[:, 1:]]))[:, 1]
    print(f"\n  hit-probability log loss on the test half:")
    print(f"    shipped model as-is        {logloss(te.y.values, te.p.values):.5f}")
    print(f"    re-fit with all features   {logloss(te.y.values, p_adj):.5f}")
    delta = logloss(te.y.values, te.p.values) - logloss(te.y.values, p_adj)
    print(f"    improvement                {delta:+.5f}"
          f"   -> {'worth shipping' if delta > 0.002 else 'not worth shipping'}")


# ---------------------------------------------------- market-level miss report
def by_market(df):
    print("\n" + "=" * 78)
    print(f"MISS RATE BY MARKET (picks >= {HIGH_BAR:.0%} confidence)")
    print("=" * 78)
    d = df[df.p >= HIGH_BAR]
    g = d.groupby("market").agg(picks=("miss", "size"), pred=("p", "mean"),
                                actual=("y", "mean"), miss=("miss", "mean"))
    g["gap"] = g.actual - g.pred
    print(g.sort_values("picks", ascending=False).round(3).to_string())


# ------------------------------------------------- 4. the mechanisms directly
def mechanisms(df):
    """The anatomy points at two physical causes. Are either knowable pre-game?"""
    print("\n" + "=" * 78)
    print("4. MECHANISMS — the two physical causes, tested as pre-game questions")
    print("=" * 78)

    # (a) Home batters lose the bottom of the 9th when their team is winning.
    b = df[(df.kind == "batter") & (df.p >= HIGH_BAR) & df.pa.notna()]
    print("\n(a) the lost plate appearance — home teams that win do not bat in the 9th")
    for home in (0, 1):
        s = b[b.is_home == home]
        won = s[(s.is_home == 1) & (s.home_score > s.away_score)] if home else \
              s[(s.is_home == 0) & (s.away_score > s.home_score)]
        print(f"  {'home' if home else 'away'} batters: {len(s):>5,} picks  "
              f"mean PA {s.pa.mean():.2f}  miss {s.miss.mean():.1%}   "
              f"| when their team won: mean PA {won.pa.mean():.2f}  miss {won.miss.mean():.1%}")
    hw = b[(b.is_home == 1) & (b.home_score > b.away_score)]
    hl = b[(b.is_home == 1) & (b.home_score < b.away_score)]
    print(f"  home & won  : {len(hw):>5,} picks  mean PA {hw.pa.mean():.2f}  miss {hw.miss.mean():.1%}")
    print(f"  home & lost : {len(hl):>5,} picks  mean PA {hl.pa.mean():.2f}  miss {hl.miss.mean():.1%}")
    m, lo, hi_ = boot_mean((hw.miss.values.astype(float)))
    m2, lo2, hi2 = boot_mean((hl.miss.values.astype(float)))
    print(f"  95% CIs: won [{lo:.3f}, {hi_:.3f}]  lost [{lo2:.3f}, {hi2:.3f}]"
          f"  -> {'separated' if hi_ < lo2 or hi2 < lo else 'overlapping'}")

    # (b) The early hook. Predictable pre-game, or not?
    p_ = df[(df.kind == "pitcher") & (df.market == "outs16") & df.outs.notna()].copy()
    p_["hook"] = (p_.outs < 15).astype(int)
    dates = np.sort(p_.date.unique())
    cut = dates[int(len(dates) * 0.55)]
    tr, te = p_[p_.date <= cut], p_[p_.date > cut]
    feats = [c for c in ["bf_start", "outs_start", "k_start", "gs", "days_rest", "is_home",
                         "park", "opp_k_pa", "opp_h_pa", "opp_r_pg", "w_gs", "w_bf_start",
                         "w_k_start", "k_bf", "h_bf", "bb_bf"] if c in p_.columns]
    est = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15,
                                         l2_regularization=1.0, random_state=0)
    est.fit(tr[feats].values, tr.hook.values)
    ph = est.predict_proba(te[feats].values)[:, 1]
    print(f"\n(b) predicting the early hook (<5 innings) from pre-game features")
    print(f"  train {len(tr):,} starts, test {len(te):,}   base hook rate {te.hook.mean():.3f}")
    print(f"  AUC {auc(te.hook.values, ph):.4f}   "
          f"(0.50 = no signal; the props model already uses these same features)")
    q = pd.qcut(ph, 4, labels=False, duplicates="drop")
    for k in sorted(pd.unique(q)):
        s = te[q == k]
        print(f"    risk quartile {int(k) + 1}: {len(s):>4} starts  hook rate {s.hook.mean():.3f}  "
              f"outs16 miss {s.miss.mean():.3f}")


# ------------------------------------------------------ 5. the game-side model
def game_model(shipped_elo_probs):
    print("\n" + "=" * 78)
    print("5. GAME MODEL — the same question for the moneyline picks")
    print("=" * 78)
    g = pd.read_csv(os.path.join(GAME_DATA, "games.csv"))
    g["home_win"] = (g.home_score > g.away_score).astype(int)
    g = g.sort_values(["date", "gamePk"]).reset_index(drop=True)
    g["elo_p"] = shipped_elo_probs(g)
    tr = g[g.season.isin([2021, 2022])]
    te = g[g.season.isin([2023, 2024, 2025, 2026])].copy()
    lr = LogisticRegression(max_iter=1000).fit(tr[["elo_p"]].values, tr.home_win.values)
    te["p_home"] = lr.predict_proba(te[["elo_p"]].values)[:, 1]
    te["pick_home"] = te.p_home >= 0.5
    te["conf"] = np.maximum(te.p_home, 1 - te.p_home)
    te["hit"] = np.where(te.pick_home, te.home_win == 1, te.home_win == 0)
    te["miss"] = 1 - te.hit.astype(int)
    te["resid"] = te.hit.astype(int) - te.conf

    hi = te[te.conf >= 0.60]
    print(f"\n{len(hi):,} picks at 60%+ confidence, {hi.miss.mean():.1%} missed")
    print("\n  by side taken:")
    for home in (True, False):
        s = hi[hi.pick_home == home]
        m, lo, h_ = boot_mean(s.resid.values)
        print(f"    {'home' if home else 'road'} favourite: {len(s):>5,} picks  "
              f"miss {s.miss.mean():.1%}   residual {m:+.3f} [{lo:+.3f}, {h_:+.3f}]")
    print("\n  by month of season:")
    hi = hi.assign(month=hi.date.str.slice(5, 7))
    for mth, s in hi.groupby("month"):
        if len(s) < 100:
            continue
        m, lo, h_ = boot_mean(s.resid.values)
        star = " *" if (lo > 0 or h_ < 0) else ""
        print(f"    {mth}: {len(s):>5,} picks  miss {s.miss.mean():.1%}  "
              f"residual {m:+.3f} [{lo:+.3f}, {h_:+.3f}]{star}")
    print("\n  by run environment of the game that followed (post-hoc):")
    hi = hi.assign(total=hi.home_score + hi.away_score,
                   margin=(hi.home_score - hi.away_score).abs())
    for a, b_ in [(0, 6), (6, 9), (9, 12), (12, 99)]:
        s = hi[(hi.total >= a) & (hi.total < b_)]
        if len(s) < 100:
            continue
        print(f"    {a}-{b_ - 1:<2} runs: {len(s):>5,} picks  miss {s.miss.mean():.1%}")
    for a, b_ in [(1, 2), (2, 4), (4, 99)]:
        s = hi[(hi.margin >= a) & (hi.margin < b_)]
        if len(s) < 100:
            continue
        print(f"    margin {a}-{b_ - 1 if b_ < 99 else '+'}: {len(s):>5,} picks  "
              f"miss {s.miss.mean():.1%}")


def main():
    df, bf, pf = build()
    print(f"{len(df):,} (pick, market) rows on the {TEST_SEASON} hold-out\n")
    by_market(df)
    anatomy(df)
    fb = residual_scan(df, "batter", CANDIDATES_B)
    fp = residual_scan(df, "pitcher", CANDIDATES_P, min_n=60)
    print(f"\n  multiple-comparison note: {len(CANDIDATES_B) + len(CANDIDATES_P)} features x 5 "
          f"quintiles = {(len(CANDIDATES_B) + len(CANDIDATES_P)) * 5} tests at 95%; "
          f"~{(len(CANDIDATES_B) + len(CANDIDATES_P)) * 5 * 0.05:.0f} cells are expected to "
          f"clear zero by chance alone.")
    predictive(df)
    mechanisms(df)
    import sys
    sys.path.insert(0, os.path.join(HERE, "..", "mlb-game"))
    from bakeoff_v2 import shipped_elo_probs
    game_model(shipped_elo_probs)

    out = df[df.p >= HIGH_BAR][
        ["date", "gamePk", "market", "kind", "name", "p", "y", "miss", "resid",
         "pa", "outs", "total_runs", "margin", "extras"]]
    out.to_csv(os.path.join(HERE, "miss_analysis_rows.csv"), index=False)
    print(f"\nsaved -> miss_analysis_rows.csv ({len(out):,} confident picks)")


if __name__ == "__main__":
    main()
