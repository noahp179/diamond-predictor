"""
Freeze the Champions League match model for the live site, and price a date.

  * Elo constants: results/tuned_params.json (tuned on 2014-15..2016-17).
  * Goal mapping: Poisson rates from (gap, home, Champions League terms) plus a
    Dixon-Coles correction, fitted once on every European match of
    2014-15..2025-26. The live site never refits, so 2026-27 is out of sample.
  * Ratings snapshot: every club's rating and league after every match before
    the cut-off (00:00 UTC on --date). The server continues the replay from
    there over the results ESPN has posted since, so the live ratings move
    with every match without a refit, and re-running this script only shortens
    how far the server has to read.

Writes src/lib/ucl-model.json, src/lib/ucl-ratings.json (snapshot),
src/lib/ucl-history.json (every Champions League match since 2017-18 priced
walk-forward), src/lib/ucl-scorers.json (goal logs for this season's clubs),
results/ucl_parity.json (for scripts/test-ucl.ts) and results/slate_<date>.json.

Usage: python3 ship_ucl.py [--date 2026-10-13]
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

from backtest_ucl import feats, fit_goals, fit_rho, goal_rates
from common import (HERE, LEAGUE_PRIOR, dc_matrix, hda_from_matrix, load_matches,
                    pre_match_ratings, replay, summary)

SRC = os.path.join(HERE, "..", "..", "src", "lib")
SNAPSHOT_SEASON = 2025


def price(lh, la, rho):
    P = dc_matrix(lh, la, rho)
    hda = hda_from_matrix(P)
    flat = [(P[i, j], i, j) for i in range(7) for j in range(7)]
    flat.sort(reverse=True)
    return dict(
        home=float(hda[0]), draw=float(hda[1]), away=float(hda[2]),
        xg_home=float(lh), xg_away=float(la),
        over25=float(1 - sum(P[i, k] for i in range(3) for k in range(3 - i))),
        btts=float(1 - P[0, :].sum() - P[:, 0].sum() + P[0, 0]),
        scores=[dict(score=f"{i}-{j}", p=float(p)) for p, i, j in flat[:6]],
    )


def snapshot_of(snap, tuned, cutoff):
    s_rating, s_league = replay(snap, tuned)
    return dict(
        cutoff=cutoff,
        season=int(snap.season.iloc[-1]),
        nMatches=int(len(snap)),
        clubs={t: [round(r, 4), s_league.get(t)] for t, r in sorted(s_rating.items())},
    )


def compact(df):
    """The match fields the live replay reads, as rows of
    [id, comp, date, home, away, hg, ag, neutral]."""
    return [[r.id, r.comp, r.date, r.home_id, r.away_id, int(r.hg), int(r.ag), bool(r.neutral)]
            for r in df.itertuples()]


def write_parity(m, tuned, cutoff, goals, rho, start="2026-09-15"):
    """Python's replay from one snapshot to the next, plus a grid of goal-model
    prices, for scripts/test-ucl.ts to replay through the TypeScript."""
    a = m[m.date < start]
    # Rounded exactly as shipped, so both sides start from the same numbers.
    snap_a = snapshot_of(a, tuned, start)
    rating = {t: v[0] for t, v in snap_a["clubs"].items()}
    league = {t: v[1] for t, v in snap_a["clubs"].items() if v[1]}
    tail = m[(m.date >= start) & (m.date < cutoff)]
    final, _ = replay_from(tail, tuned, rating, league, snap_a["season"])
    grid = []
    for rh_, ra_, neutral, ucl in [(1900, 1700, False, True), (1700, 1900, False, True),
                                   (1800, 1800, False, True), (2100, 1650, False, True),
                                   (1850, 1800, True, True), (1600, 1500, False, False)]:
        x = feats(np.array([rh_]), np.array([ra_]), np.array([neutral]), np.array([ucl]))
        lh, la = goal_rates(goals, x)
        p = price(float(lh[0]), float(la[0]), rho)
        grid.append(dict(rh=rh_, ra=ra_, neutral=neutral, ucl=ucl, lh=float(lh[0]), la=float(la[0]),
                         home=p["home"], draw=p["draw"], away=p["away"], over25=p["over25"],
                         btts=p["btts"]))
    with open(os.path.join(HERE, "results", "ucl_parity.json"), "w") as f:
        json.dump(dict(snapshot=snap_a, matches=compact(tail),
                       expected={t: final[t] for t in sorted(set(tail.home_id) | set(tail.away_id))},
                       grid=grid), f, separators=(",", ":"))


def replay_from(df, tuned, rating, league, season):
    """common.replay, started from a snapshot instead of from nothing."""
    from common import replay_state
    return replay_state(df, tuned, dict(rating), dict(league), season)


def write_history(m, rh, ra, goals, rho, cutoff):
    """Every Champions League match since 2017-18, priced walk-forward.

    2017-18..2025-26 come from backtest_ucl.py (mapping refitted each season on
    earlier seasons only). 2026-27 matches before the cut-off are priced with
    the shipped mapping, which never saw them. The server adds the rest live.
    """
    bt = pd.read_csv(os.path.join(HERE, "results", "backtest_matches.csv"), dtype={"id": str})
    bt = bt[bt.season <= SNAPSHOT_SEASON]
    rows = [[r.id, r.date, r.home, r.away, round(r.p_home, 4), round(r.p_draw, 4), round(r.p_away, 4),
             round(r.xg_home, 3), round(r.xg_away, 3),
             None if pd.isna(r.hg90) else int(r.hg90), None if pd.isna(r.ag90) else int(r.ag90),
             r.result] for r in bt.itertuples()]
    live = m.ucl.values & (m.season.values > SNAPSHOT_SEASON) & (m.date.values < cutoff)
    X = feats(rh[live], ra[live], m.neutral.values[live], np.ones(live.sum(), bool))
    lh, la = goal_rates(goals, X)
    for j, r in enumerate(m[live].itertuples()):
        p = price(float(lh[j]), float(la[j]), rho)
        rows.append([r.id, r.date[:10], r.home_name, r.away_name, round(p["home"], 4),
                     round(p["draw"], 4), round(p["away"], 4), round(float(lh[j]), 3),
                     round(float(la[j]), 3),
                     None if pd.isna(r.hg90) else int(r.hg90), None if pd.isna(r.ag90) else int(r.ag90),
                     "HDA"[r.res]])
    with open(os.path.join(SRC, "ucl-history.json"), "w") as f:
        json.dump(dict(cutoff=cutoff, fields=["id", "date", "home", "away", "pHome", "pDraw", "pAway",
                                              "xgHome", "xgAway", "hg", "ag", "result"],
                       rows=rows), f, separators=(",", ":"))


def write_scorers(m, cutoff, half_life=180.0, window=400):
    """Recency-weighted goals per player for every club in this season's
    Champions League, over the 400 days before the cut-off, in all
    competitions. The server shrinks these toward a position prior using the
    club's live ESPN roster (which also drops departed and injured players)."""
    ev = pd.read_csv(os.path.join(HERE, "data", "events.csv"),
                     dtype={"match_id": str, "team_id": str, "player_id": str})
    fx = pd.read_csv(os.path.join(HERE, "data", "fixtures.csv"), dtype={"home_id": str, "away_id": str})
    cur = m[m.ucl & (m.season > SNAPSHOT_SEASON)]
    fxu = fx[fx.comp == "uefa.champions"]
    clubs = set(cur.home_id) | set(cur.away_id) | set(fxu.home_id) | set(fxu.away_id)
    t0 = pd.Timestamp(cutoff, tz="UTC")
    when = pd.to_datetime(m.date, utc=True)
    recent = m[(when < t0) & (when > t0 - pd.Timedelta(days=window))]
    wt = dict(zip(recent.id, np.exp(-(t0 - pd.to_datetime(recent.date, utc=True)).dt.days.values / half_life)))
    goals = ev[(ev.kind == "goal") & ev.match_id.isin(wt) & ~ev.own.astype(bool)]
    out = {}
    for club in sorted(clubs):
        g = goals[goals.team_id == club]
        players = {}
        for pid, name, mid in zip(g.player_id, g.player, g.match_id):
            w = wt[mid]
            p = players.setdefault(pid, [name, 0.0])
            p[1] += w
        out[club] = dict(
            teamGoals=round(sum(wt[mid] for mid in g.match_id), 4),
            players={pid: [v[0], round(v[1], 4)] for pid, v in sorted(players.items(), key=lambda kv: -kv[1][1])},
        )
    with open(os.path.join(SRC, "ucl-scorers.json"), "w") as f:
        json.dump(dict(cutoff=cutoff, halfLife=half_life, window=window, clubs=out), f,
                  separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=pd.Timestamp.now("UTC").strftime("%Y-%m-%d"))
    args = ap.parse_args()

    tuned = json.load(open(os.path.join(HERE, "results", "tuned_params.json")))["params"]
    bt = json.load(open(os.path.join(HERE, "results", "backtest_summary.json")))
    m = load_matches()
    rh, ra, final, league_of = pre_match_ratings(m, tuned)
    X = feats(rh, ra, m.neutral.values, m.ucl.values)

    train = m.europe.values & m.season.between(2014, SNAPSHOT_SEASON).values & m.hg90.notna().values
    hg = m.hg90.values[train].astype(int)
    ag = m.ag90.values[train].astype(int)
    bh, ba = fit_goals(X[train], hg, ag)
    lh_tr, la_tr = goal_rates((bh, ba), X[train])
    rho = fit_rho(lh_tr, la_tr, hg, ag)

    # Out of sample: 2026-27 Champions League matches, never seen by the fit.
    oos = m.ucl.values & (m.season.values > SNAPSHOT_SEASON)
    lh, la = goal_rates((bh, ba), X[oos])
    p_oos = np.array([hda_from_matrix(dc_matrix(h, a, rho)) for h, a in zip(lh, la)])
    live = summary(p_oos, m.res.values[oos]) if oos.sum() else None

    # Ratings snapshot at the cut-off — the live replay's starting point.
    cutoff = args.date
    snap = m[m.date < cutoff]
    snapshot = snapshot_of(snap, tuned, cutoff)
    # This season's Champions League clubs, named, for the live power table.
    fx_all = pd.read_csv(os.path.join(HERE, "data", "fixtures.csv"),
                         dtype={"id": str, "home_id": str, "away_id": str})
    cur = pd.concat([
        m[m.ucl & (m.season > SNAPSHOT_SEASON)][["home_id", "away_id", "home_name", "away_name"]],
        fx_all[(fx_all.comp == "uefa.champions")][["home_id", "away_id", "home_name", "away_name"]],
    ])
    snapshot["ucl"] = dict(sorted({**dict(zip(cur.home_id, cur.home_name)),
                                   **dict(zip(cur.away_id, cur.away_name))}.items()))
    with open(os.path.join(SRC, "ucl-ratings.json"), "w") as f:
        json.dump(snapshot, f, separators=(",", ":"))
    write_parity(m, tuned, cutoff, (bh, ba), rho)
    write_history(m, rh, ra, (bh, ba), rho, cutoff)
    write_scorers(m, cutoff)

    ucl_hist = m[m.ucl & m.season.between(2014, SNAPSHOT_SEASON)]
    priors = dict(
        home=float((ucl_hist.res == 0).mean()), draw=float((ucl_hist.res == 1).mean()),
        away=float((ucl_hist.res == 2).mean()),
        goals=float((ucl_hist.hg90 + ucl_hist.ag90).mean()),
    )

    model = dict(
        name="Champions League",
        algorithm="cross_league_elo_dc",
        elo=dict(tuned, leaguePrior=LEAGUE_PRIOR),
        goals=dict(home=list(map(float, bh)), away=list(map(float, ba)), rho=rho,
                   trainedThrough=SNAPSHOT_SEASON, nTrain=int(train.sum())),
        backtest=dict(
            pooled=bt["pooled"], perSeason=bt["per_season"], calibration=bt["calibration"],
            scorelines=bt["scorelines"], live=live, liveSeason=SNAPSHOT_SEASON + 1,
        ),
        priors=priors,
        comps=sorted(set(m.comp)),
    )
    with open(os.path.join(SRC, "ucl-model.json"), "w") as f:
        json.dump(model, f, indent=1)

    # ---- the slate
    fx = pd.read_csv(os.path.join(HERE, "data", "fixtures.csv"), dtype={"id": str, "home_id": str, "away_id": str})
    fx = fx[(fx.comp == "uefa.champions") & fx.date.str.startswith(args.date)]
    names = dict(zip(m.home_id, m.home_name))
    names.update(dict(zip(m.away_id, m.away_name)))
    slate = []
    for _, r in fx.iterrows():
        h, a = final.get(r.home_id), final.get(r.away_id)
        if h is None or a is None:
            continue
        x = feats(np.array([h]), np.array([a]), np.array([bool(r.neutral)]), np.array([True]))
        lh1, la1 = goal_rates((bh, ba), x)
        p = price(float(lh1[0]), float(la1[0]), rho)
        mk = [r.p_home_mkt, r.p_draw_mkt, r.p_away_mkt]
        if all(pd.notna(v) for v in mk):
            s = sum(mk)
            p["market"] = dict(home=mk[0] / s, draw=mk[1] / s, away=mk[2] / s, overround=s - 1,
                               provider=r.provider)
        slate.append(dict(id=r.id, kickoff=r.date, home_name=r.home_name, away_name=r.away_name,
                          home_id=r.home_id, away_id=r.away_id,
                          home_elo=h, away_elo=a,
                          home_league=league_of.get(r.home_id), away_league=league_of.get(r.away_id),
                          **p))
    with open(os.path.join(HERE, "results", f"slate_{args.date}.json"), "w") as f:
        json.dump(dict(date=args.date, rho=rho, goals=dict(home=list(bh), away=list(ba)),
                       slate=slate), f, indent=1)

    print(f"goal model home={np.round(bh, 4)} away={np.round(ba, 4)} rho={rho:.4f} n={train.sum()}")
    print(f"2026-27 out of sample: {live}")
    print(f"snapshot: {len(snapshot['clubs'])} clubs, {snapshot['nMatches']:,} matches before {cutoff}")
    for g in slate:
        mk = g.get("market")
        mks = f"  mkt {mk['home']:.0%}/{mk['draw']:.0%}/{mk['away']:.0%}" if mk else ""
        print(f"{g['kickoff'][11:16]} {g['home_name']:>18} {g['home_elo']:6.0f} v {g['away_elo']:6.0f} {g['away_name']:<18} "
              f"{g['home']:.0%}/{g['draw']:.0%}/{g['away']:.0%}  xG {g['xg_home']:.2f}-{g['xg_away']:.2f} "
              f"top {g['scores'][0]['score']}{mks}")


if __name__ == "__main__":
    main()
