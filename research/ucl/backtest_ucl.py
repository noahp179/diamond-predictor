"""
Walk-forward backtest of the Champions League match model, 2017-18 to date.

For each Champions League season S:
  * ratings are the cross-league Elo as it stood the morning of each match
    (the replay is chronological, so this is automatic);
  * the probability mappings are fitted on European matches from 2014-15
    through S-1 only — never on S;
  * every Champions League match of S (league/group phase and knockouts,
    not qualifiers) is priced and scored on its 90-minute result.

Two mappings from rating gap to probabilities are compared:
  MNL   multinomial logistic on (gap, home) -> H/D/A directly
  GOALS Poisson goal rates for each side from (gap, home), with a
        Dixon-Coles low-score correction -> a full scoreline matrix

GOALS is what the simulator needs (it plays goals, not outcomes), so the
question this answers is whether pricing through scorelines costs anything
against pricing outcomes directly.

Baselines: the prior seasons' Champions League base rates, and a pure-domestic
Elo (each league its own island, the way the five league models work) to
measure what the European links are worth.

Writes results/backtest_summary.json and results/backtest_matches.csv.
"""

import json
import os

import numpy as np
import pandas as pd
from scipy.optimize import minimize, minimize_scalar

from common import (HERE, dc_matrix, fit_mnl, hda_from_matrix, load_matches, mnl_predict,
                    pre_match_ratings, rps, summary)

TEST = list(range(2017, 2027))


def feats(rh, ra, neutral, ucl=None):
    """(gap, home, ucl, ucl*gap). The Champions League proper is its own
    competition — more goals, fewer draws and stronger favourites than the
    European pool its mapping is fitted on — so it gets its own intercept and
    slope. Columns 2-3 are zero everywhere else."""
    gap = (rh - ra) / 400.0
    u = np.zeros(len(gap)) if ucl is None else np.asarray(ucl, float)
    return np.c_[gap, (~neutral).astype(float), u, u * gap]


def goal_design(X, sign, ucl_terms=True):
    cols = [np.ones(len(X)), sign * X[:, 0], X[:, 1]]
    if ucl_terms:
        cols += [X[:, 2], sign * X[:, 3]]
    return np.column_stack(cols)


def fit_goals(X, hg, ag, ucl_terms=True):
    """Poisson GLM per side on the gap (sign-flipped for the away side), home,
    and the Champions League terms. Returns (bh, ba)."""
    def fit(y, sign):
        Z = goal_design(X, sign, ucl_terms)

        def nll(b):
            eta = Z @ b
            lam = np.exp(eta)
            return (lam - y * eta).mean(), Z.T @ (lam - y) / len(y)

        return minimize(nll, np.zeros(Z.shape[1]) + 0.1, jac=True, method="L-BFGS-B").x

    return fit(hg, 1.0), fit(ag, -1.0)


def goal_rates(b, X):
    bh, ba = b
    ucl_terms = len(bh) == 5
    lh = np.exp(goal_design(X, 1.0, ucl_terms) @ bh)
    la = np.exp(goal_design(X, -1.0, ucl_terms) @ ba)
    return lh, la


def fit_rho(lh, la, hg, ag):
    def nll(rho):
        t = np.ones(len(hg))
        m00 = (hg == 0) & (ag == 0)
        m01 = (hg == 0) & (ag == 1)
        m10 = (hg == 1) & (ag == 0)
        m11 = (hg == 1) & (ag == 1)
        t[m00] = 1 - lh[m00] * la[m00] * rho
        t[m01] = 1 + lh[m01] * rho
        t[m10] = 1 + la[m10] * rho
        t[m11] = 1 - rho
        return -np.log(np.clip(t, 1e-9, None)).sum()

    return float(minimize_scalar(nll, bounds=(-0.3, 0.3), method="bounded").x)


def main():
    tuned = json.load(open(os.path.join(HERE, "results", "tuned_params.json")))["params"]
    m = load_matches()
    rh, ra, final, league_of = pre_match_ratings(m, tuned)
    X = feats(rh, ra, m.neutral.values, m.ucl.values)
    y = m.res.values
    have90 = m.hg90.notna().values
    hg90 = m.hg90.fillna(0).values.astype(int)
    ag90 = m.ag90.fillna(0).values.astype(int)

    # Domestic-island baseline: each European match priced with each club's
    # rating going into its latest domestic match before that date, from a
    # replay that never saw a European result. (One match stale; a baseline.)
    dom = m[~m.europe].reset_index(drop=True)
    drh, dra, _, _ = pre_match_ratings(dom, tuned)
    long = pd.DataFrame({
        "date": pd.to_datetime(np.r_[dom.date.values, dom.date.values]),
        "team": np.r_[dom.home_id.values, dom.away_id.values],
        "r": np.r_[drh, dra],
    }).sort_values("date")
    eu_rows = m[m.europe][["date", "home_id", "away_id"]].reset_index()
    eu_rows["date"] = pd.to_datetime(eu_rows["date"])
    def asof(col):
        q = eu_rows[["index", "date", col]].rename(columns={col: "team"}).sort_values("date")
        j = pd.merge_asof(q, long, on="date", by="team", allow_exact_matches=False)
        return j.set_index("index")["r"]
    dom_h = asof("home_id").reindex(m.index)
    dom_a = asof("away_id").reindex(m.index)
    Xd = feats(dom_h.fillna(1300).values, dom_a.fillna(1300).values, m.neutral.values,
               m.ucl.values)

    rows = []
    per_season = []
    for S in TEST:
        train = m.europe.values & m.season.between(2014, S - 1).values
        test = m.ucl.values & (m.season.values == S)
        if test.sum() == 0:
            continue
        W, b = fit_mnl(X[train], y[train])
        p_mnl = mnl_predict(W, b, X[test])

        tr90 = train & have90
        gb = fit_goals(X[tr90], hg90[tr90], ag90[tr90])
        lh_tr, la_tr = goal_rates(gb, X[tr90])
        rho = fit_rho(lh_tr, la_tr, hg90[tr90], ag90[tr90])
        lh, la = goal_rates(gb, X[test])
        mats = [dc_matrix(h, a, rho) for h, a in zip(lh, la)]
        p_goals = np.array([hda_from_matrix(P) for P in mats])

        gb1 = fit_goals(X[tr90], hg90[tr90], ag90[tr90], ucl_terms=False)
        l1h, l1a = goal_rates(gb1, X[tr90])
        rho1 = fit_rho(l1h, l1a, hg90[tr90], ag90[tr90])
        v1h, v1a = goal_rates(gb1, X[test])
        p_v1 = np.array([hda_from_matrix(dc_matrix(h, a, rho1)) for h, a in zip(v1h, v1a)])

        trd = train & ~np.isnan(Xd[:, 0])
        Wd, bd = fit_mnl(Xd[trd], y[trd])
        p_dom = mnl_predict(Wd, bd, Xd[test])

        ucl_prior = m.ucl.values & m.season.between(2014, S - 1).values
        base = np.bincount(y[ucl_prior], minlength=3) / ucl_prior.sum()
        p_base = np.tile(base, (test.sum(), 1))

        yt = y[test]
        rec = dict(season=S, n=int(test.sum()))
        for name, p in (("goals", p_goals), ("mnl", p_mnl), ("goals_v1_pooled", p_v1),
                        ("domestic_only", p_dom), ("base_rates", p_base)):
            rec[name] = summary(p, yt)
        per_season.append(rec)

        sub = m[test]
        for j, (idx, r) in enumerate(sub.iterrows()):
            P = mats[j]
            hi, ai = np.unravel_index(P.argmax(), P.shape)
            rows.append(dict(
                season=S, id=r.id, date=r.date[:10], home=r.home_name, away=r.away_name,
                home_elo=round(rh[idx], 1), away_elo=round(ra[idx], 1),
                p_home=p_goals[j, 0], p_draw=p_goals[j, 1], p_away=p_goals[j, 2],
                p_home_mnl=p_mnl[j, 0], p_draw_mnl=p_mnl[j, 1], p_away_mnl=p_mnl[j, 2],
                xg_home=lh[j], xg_away=la[j], likely_score=f"{hi}-{ai}",
                p_over25=float(1 - sum(P[i, k] for i in range(3) for k in range(3 - i))),
                p_btts=float(1 - P[0, :].sum() - P[:, 0].sum() + P[0, 0]),
                hg=r.hg, ag=r.ag, hg90=r.hg90, ag90=r.ag90, et=r.et,
                result="HDA"[r.res],
                pick="HDA"[int(p_goals[j].argmax())],
            ))

    bt = pd.DataFrame(rows)
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    bt.to_csv(os.path.join(HERE, "results", "backtest_matches.csv"), index=False)

    # Pooled over the nine complete seasons (2026-27 has barely started and is
    # reported on its own).
    full = bt[bt.season <= 2025]
    yy = full.result.map({"H": 0, "D": 1, "A": 2}).values
    pooled = {
        "goals": summary(full[["p_home", "p_draw", "p_away"]].values, yy),
        "mnl": summary(full[["p_home_mnl", "p_draw_mnl", "p_away_mnl"]].values, yy),
    }
    # Pooled baselines from the per-season records, weighted by matches.
    for name in ("goals_v1_pooled", "domestic_only", "base_rates"):
        tot = sum(r["n"] for r in per_season if r["season"] <= 2025)
        pooled[name] = {k: sum(r[name][k] * r["n"] for r in per_season if r["season"] <= 2025) / tot
                        for k in ("rps", "logloss", "brier", "acc")}
        pooled[name]["n"] = tot

    # Calibration of the shipped mapping: favourite's probability in bins vs
    # how often the favourite won.
    fav_p = full[["p_home", "p_draw", "p_away"]].max(axis=1).values
    fav_hit = (full[["p_home", "p_draw", "p_away"]].values.argmax(1) == yy)
    bins = [0.33, 0.45, 0.55, 0.65, 0.75, 0.85, 1.0]
    calib = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        sel = (fav_p >= lo) & (fav_p < hi)
        if sel.sum():
            calib.append(dict(lo=lo, hi=hi, n=int(sel.sum()), predicted=float(fav_p[sel].mean()),
                              actual=float(fav_hit[sel].mean())))

    # Scoreline checks: what the simulator inherits.
    goals_ok = full[full.hg90.notna()]
    tot_pred = goals_ok.xg_home + goals_ok.xg_away
    tot_act = goals_ok.hg90 + goals_ok.ag90
    o25 = (tot_act > 2.5).astype(float)
    btts = ((goals_ok.hg90 > 0) & (goals_ok.ag90 > 0)).astype(float)
    scorelines = dict(
        n=int(len(goals_ok)),
        goals_pred=float(tot_pred.mean()), goals_actual=float(tot_act.mean()),
        home_goals_pred=float(goals_ok.xg_home.mean()), home_goals_actual=float(goals_ok.hg90.mean()),
        away_goals_pred=float(goals_ok.xg_away.mean()), away_goals_actual=float(goals_ok.ag90.mean()),
        over25_pred=float(goals_ok.p_over25.mean()), over25_actual=float(o25.mean()),
        over25_brier=float(((goals_ok.p_over25 - o25) ** 2).mean()),
        over25_brier_base=float(((o25.mean() - o25) ** 2).mean()),
        btts_pred=float(goals_ok.p_btts.mean()), btts_actual=float(btts.mean()),
        draw_pred=float(full.p_draw.mean()), draw_actual=float((full.result == "D").mean()),
        likely_score_hit=float((goals_ok.likely_score == goals_ok.hg90.astype(int).astype(str) + "-" + goals_ok.ag90.astype(int).astype(str)).mean()),
    )

    out = dict(params=tuned, per_season=per_season, pooled=pooled, calibration=calib,
               scorelines=scorelines)
    with open(os.path.join(HERE, "results", "backtest_summary.json"), "w") as f:
        json.dump(out, f, indent=2)

    print(f"{'season':<8}{'n':>5}  {'GOALS rps':>10} {'acc':>6}  {'MNL rps':>8}  {'v1':>7}  {'dom-only':>9}  {'base':>7}")
    for r in per_season:
        print(f"{r['season']}-{(r['season'] + 1) % 100:02d} {r['n']:>5}  {r['goals']['rps']:>10.4f} "
              f"{r['goals']['acc']:>6.1%}  {r['mnl']['rps']:>8.4f}  {r['goals_v1_pooled']['rps']:>7.4f}  {r['domestic_only']['rps']:>9.4f}  "
              f"{r['base_rates']['rps']:>7.4f}")
    print("pooled 2017-18..2025-26:")
    for k, v in pooled.items():
        print(f"  {k:<14} n={v['n']} rps={v['rps']:.4f} ll={v['logloss']:.4f} brier={v['brier']:.4f} acc={v['acc']:.1%}")
    print("calibration:", json.dumps(calib, indent=0))
    print("scorelines:", json.dumps(scorelines, indent=1))


if __name__ == "__main__":
    main()
