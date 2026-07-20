"""
Market implied-total features - the one lever the backtest said could move the
ceiling. Pulls closing spread_line / total_line from nflverse schedules and
derives, per team-game, the market's own estimate of how much that team will
score. This is genuine pre-game information (the closing line), not leakage.

    team_margin  = spread_line if home else -spread_line   (+ = team favored)
    implied_total= total_line/2 + team_margin/2            (market points estimate)

Then it re-runs the strongest models WITH vs WITHOUT these features and bootstraps
whether the market breaks the no-market ceiling.
"""
import os, json, warnings
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

import backtest as bt
import bakeoff as bo
import advanced as A

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
SEASONS = [2021, 2022, 2023, 2024]
MKT = ["mkt_implied_total", "mkt_total", "mkt_team_margin", "mkt_is_fav"]


def build_market_lines():
    import nfl_data_py as nfl
    s = nfl.import_schedules(SEASONS)
    s = s[s["espn"].notna() & s["result"].notna()].copy()
    rows = []
    for r in s.itertuples():
        tot, spr = r.total_line, r.spread_line
        if pd.isna(tot) or pd.isna(spr):
            tot = tot if not pd.isna(tot) else np.nan
            spr = spr if not pd.isna(spr) else 0.0
        for team, margin in [(r.home_team, spr), (r.away_team, -spr)]:
            rows.append(dict(game_id=r.game_id, team=team,
                             mkt_total=tot,
                             mkt_team_margin=margin,
                             mkt_implied_total=(tot / 2 + margin / 2) if not pd.isna(tot) else np.nan,
                             mkt_is_fav=int(margin > 0)))
    df = pd.DataFrame(rows)
    # fill the rare missing line with league medians
    df["mkt_total"] = df["mkt_total"].fillna(df["mkt_total"].median())
    df["mkt_implied_total"] = df["mkt_implied_total"].fillna(df["mkt_total"] / 2)
    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    df.to_csv(os.path.join(HERE, "data", "market_lines.csv"), index=False)
    return df


def merged_with_market():
    mkt = build_market_lines()
    f = A.load_merged()
    f = f.merge(mkt, on=["game_id", "team"], how="left")
    f["mkt_implied_total"] = f["mkt_implied_total"].fillna(f["mkt_implied_total"].median())
    f["mkt_total"] = f["mkt_total"].fillna(f["mkt_total"].median())
    f["mkt_team_margin"] = f["mkt_team_margin"].fillna(0.0)
    f["mkt_is_fav"] = f["mkt_is_fav"].fillna(0).astype(int)
    return f


def eval_sklearn(name, make, cols, tr, te):
    oof, test = A.oof_sklearn(make, tr[cols].values, tr.scored.values,
                              te[cols].values, tr.game_id.values)
    return A.metrics(name, oof, tr.scored.values, test, te.scored.values, te), test


def run_hts(tr, te, team_feats):
    """HTS with a chosen Stage-A feature set (mutates the module global safely)."""
    saved = A.TEAM_FEATS
    A.TEAM_FEATS = team_feats
    try:
        oof, test = A.oof_hts(tr, te)
        m = A.metrics("_", oof, tr.scored.values, test, te.scored.values, te)
    finally:
        A.TEAM_FEATS = saved
    return m, test


def per_game_top1(te, score):
    d = te.copy(); d["_s"] = score
    return {gid: int(g.sort_values("_s", ascending=False).iloc[0].player_id
                     in set(g.loc[g.scored == 1, "player_id"]))
            for gid, g in d.groupby("game_id")}


def main():
    f = merged_with_market()
    tr = f[f.season.isin([2021, 2022])].reset_index(drop=True)
    te = f[f.season.isin([2023, 2024])].reset_index(drop=True)
    ytr, yte = tr.scored.values, te.scored.values
    games = sorted(te.game_id.unique())
    print(f"train {len(tr):,}  test {len(te):,}  games {len(games)}  "
          f"market coverage={f.mkt_implied_total.notna().mean():.1%}")
    print(f"implied-total range: {te.mkt_implied_total.min():.1f}-{te.mkt_implied_total.max():.1f} "
          f"(mean {te.mkt_implied_total.mean():.1f})")

    logit = lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))
    results, scores = [], {}

    # ---------- logistic: no market vs market ----------
    m, s = eval_sklearn("logistic (no market)", logit, bo.FEATURES, tr, te)
    results.append(m); scores["log_nomkt"] = s
    m, s = eval_sklearn("logistic + MARKET", logit, bo.FEATURES + MKT, tr, te)
    results.append(m); scores["log_mkt"] = s

    # ---------- HTS: no market vs market vs market-only team total ----------
    m, s = run_hts(tr, te, A.TEAM_FEATS)
    m["model"] = "HTS (no market)"; results.append(m); scores["hts_nomkt"] = s
    m, s = run_hts(tr, te, A.TEAM_FEATS + MKT)
    m["model"] = "HTS + MARKET"; results.append(m); scores["hts_mkt"] = s
    m, s = run_hts(tr, te, MKT)
    m["model"] = "Market-Poisson (mkt total x share)"; results.append(m); scores["mktpois"] = s

    # ---------- STACK: no market vs market ----------
    saved_feats, saved_team = bo.FEATURES, A.TEAM_FEATS
    s_tr, s_te, w0, _, _ = A.build_stack(tr, te)
    results.append(A.metrics("STACK (no market)", s_tr, ytr, s_te, yte, te)); scores["stk_nomkt"] = s_te
    bo.FEATURES = saved_feats + MKT
    A.TEAM_FEATS = saved_team + MKT
    try:
        s_tr, s_te, w1, _, _ = A.build_stack(tr, te)
    finally:
        bo.FEATURES, A.TEAM_FEATS = saved_feats, saved_team
    results.append(A.metrics("STACK + MARKET", s_tr, ytr, s_te, yte, te)); scores["stk_mkt"] = s_te

    # ---------- how much does logistic lean on the market? ----------
    scaler = StandardScaler().fit(tr[bo.FEATURES + MKT].values)
    lr = LogisticRegression(max_iter=2000).fit(scaler.transform(tr[bo.FEATURES + MKT].values), ytr)
    coefs = dict(zip(bo.FEATURES + MKT, lr.coef_[0]))
    top = sorted(coefs.items(), key=lambda kv: -abs(kv[1]))[:6]

    # ---------- report ----------
    print("\n" + "=" * 74)
    print("MARKET vs NO-MARKET  (test 2023-2024, 569 games)")
    print("=" * 74)
    print(f"{'model':38s} {'top1':>6} {'top2':>6} {'AUC':>6} {'Brier':>7} {'logloss':>8}")
    for r in results:
        print(f"{r['model']:38s} {r['top1']:>6.1%} {r['top2']:>6.1%} {r['auc']:>6.3f} "
              f"{r['brier']:>7.4f} {r['logloss']:>8.4f}")

    print("\nTop logistic drivers WITH market (standardized):")
    for n, c in top:
        print(f"   {c:+.3f}  {n}")

    # ---------- significance: market vs no-market ----------
    rb = np.random.default_rng(0)
    game_rows = {gid: te.index[te.game_id == gid].to_numpy() for gid in games}

    def boot_auc(sa, sb, n=2000):
        d = []
        for _ in range(n):
            gsel = rb.integers(0, len(games), len(games))
            ridx = np.concatenate([game_rows[games[k]] for k in gsel])
            d.append(bt.auc(yte[ridx], sa[ridx]) - bt.auc(yte[ridx], sb[ridx]))
        return np.mean(d), np.percentile(d, 2.5), np.percentile(d, 97.5)

    def boot_top1(sa, sb, n=5000):
        ha = np.array([per_game_top1(te, sa)[g] for g in games])
        hb = np.array([per_game_top1(te, sb)[g] for g in games])
        idx = rb.integers(0, len(games), (n, len(games)))
        d = ha[idx].mean(1) - hb[idx].mean(1)
        return d.mean(), np.percentile(d, 2.5), np.percentile(d, 97.5)

    print("\n[Significance] does MARKET beat NO-MARKET? (clustered bootstrap)")
    for lbl, a, b in [("logistic  +mkt vs -mkt", scores["log_mkt"], scores["log_nomkt"]),
                      ("HTS       +mkt vs -mkt", scores["hts_mkt"], scores["hts_nomkt"]),
                      ("STACK     +mkt vs -mkt", scores["stk_mkt"], scores["stk_nomkt"])]:
        am, alo, ahi = boot_auc(a, b)
        tm, tlo, thi = boot_top1(a, b)
        asig = "SIG" if alo > 0 else "ns"
        print(f"  {lbl:26s}  dAUC={am:+.4f} [{alo:+.4f},{ahi:+.4f}] {asig:3s}   "
              f"dTop1={tm:+.1%} [{tlo:+.1%},{thi:+.1%}]")

    with open(os.path.join(HERE, "market_metrics.json"), "w") as fp:
        json.dump({"models": results, "top_drivers": top}, fp, indent=2)
    print(f"\nSaved market_metrics.json")


if __name__ == "__main__":
    main()
