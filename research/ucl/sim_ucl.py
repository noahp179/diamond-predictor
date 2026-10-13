"""
The minute-by-minute match simulator: fit its constants from real goal logs,
check it against the backtest, and play a date's fixtures.

A match is played one minute at a time. In each minute each side scores at

    (its 90-minute goal rate / 90) x minute effect x game-state effect x
    man-advantage effect

and picks up a red card at the minute's red-card rate. The 90-minute goal
rates come from the match model (ship_ucl.py); everything else is fitted here
by Poisson regression on every European match with a goal log — about 9,000
of them, every goal and red card with its minute:

  minute     8 windows; 45 and 90 carry their stoppage time
  state      the side's goal difference, -2..+2 (trailing sides push)
  red cards  one man up / one man down

Using the model's own rates as the regression offset means the fitted effects
are relative to what the model already expects, so a simulated match averages
the model's goals rather than drifting away from them.

Backtest: the constants are refitted on 2014-15..2016-17 only, and every
Champions League match of 2017-18..2025-26 is played 4,000 times from its
walk-forward goal rates (results/backtest_matches.csv). So neither the goal
rates nor the simulator's constants have seen the matches they are scored on.

Writes src/lib/ucl-sim.json (shipped constants), results/sim_backtest.json and
results/sim_<date>.json.
"""

import argparse
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests
from scipy.optimize import minimize

from backtest_ucl import feats, goal_rates
from common import HERE, load_matches, pre_match_ratings, rps, summary

SRC = os.path.join(HERE, "..", "..", "src", "lib")

# Minute windows. 45 and 90 are their own windows because they hold every
# stoppage-time goal of their half.
BUCKETS = [(1, 15), (16, 30), (31, 44), (45, 45), (46, 60), (61, 75), (76, 89), (90, 90)]
BUCKET_OF = np.zeros(91, int)
for b, (lo, hi) in enumerate(BUCKETS):
    BUCKET_OF[lo:hi + 1] = b
STATES = [-2, -1, 0, 1, 2]


def load_events():
    ev = pd.read_csv(os.path.join(HERE, "data", "events.csv"),
                     dtype={"match_id": str, "team_id": str, "player_id": str})
    ev["minute"] = ev["minute"].clip(lower=1)
    return ev


def minute_grid(m, ev, lam_h, lam_a):
    """Per (match, minute, side) rows: offset, bucket, state, man diff, goals, reds."""
    ids = m.id.values
    pos = {mid: i for i, mid in enumerate(ids)}
    n = len(ids)
    goals = np.zeros((n, 91, 2), np.int16)
    reds = np.zeros((n, 91, 2), np.int16)
    sub = ev[ev.match_id.isin(pos) & (ev.minute <= 90)]
    home_of = dict(zip(m.id, m.home_id))
    for mid, kind, minute, team in zip(sub.match_id, sub.kind, sub.minute, sub.team_id):
        i = pos[mid]
        side = 0 if team == home_of[mid] else 1
        (goals if kind == "goal" else reds)[i, int(minute), side] += 1
    # State entering each minute = everything before it.
    cg = np.cumsum(goals, 1) - goals
    cr = np.cumsum(reds, 1) - reds
    rows = []
    for side in (0, 1):
        lam = lam_h if side == 0 else lam_a
        gd = np.clip(cg[:, 1:, side] - cg[:, 1:, 1 - side], -2, 2)
        man = np.clip(cr[:, 1:, 1 - side] - cr[:, 1:, side], -1, 1)
        rows.append(dict(
            off=np.log(np.repeat(lam[:, None] / 90.0, 90, 1)).ravel(),
            bucket=np.tile(BUCKET_OF[1:], n),
            state=gd.ravel(), man=man.ravel(),
            y=goals[:, 1:, side].ravel(), red=reds[:, 1:, side].ravel(),
        ))
    return {k: np.concatenate([r[k] for r in rows]) for k in rows[0]}


def fit_hazard(g):
    """Poisson regression: log mu = off + bucket + state(-2..2, 0 = level) + man(-1..1)."""
    nb = len(BUCKETS)
    B = np.zeros((len(g["y"]), nb))
    B[np.arange(len(g["y"])), g["bucket"]] = 1
    S = np.stack([(g["state"] == s).astype(float) for s in (-2, -1, 1, 2)], 1)
    M = np.stack([(g["man"] == s).astype(float) for s in (-1, 1)], 1)
    Z = np.hstack([B, S, M])
    y = g["y"].astype(float)
    off = g["off"]

    def nll(w):
        eta = off + Z @ w
        mu = np.exp(eta)
        return (mu - y * eta).sum() / len(y), Z.T @ (mu - y) / len(y)

    w = minimize(nll, np.zeros(Z.shape[1]), jac=True, method="L-BFGS-B").x
    reds_by_bucket = np.array([g["red"][g["bucket"] == b].sum() / (g["bucket"] == b).sum()
                               for b in range(nb)])
    return dict(
        bucket=w[:nb].tolist(),
        state={str(s): float(v) for s, v in zip((-2, -1, 1, 2), w[nb:nb + 4])} | {"0": 0.0},
        man={"-1": float(w[nb + 4]), "0": 0.0, "1": float(w[nb + 5])},
        redRate=reds_by_bucket.tolist(),
        buckets=BUCKETS,
    )


def simulate(lh, la, P, n, rng, extra_time=False):
    """Play n matches between rates lh, la. Returns home goals, away goals arrays
    (and, with extra_time, 120-minute goals and the shoot-out winner)."""
    hg = np.zeros(n, np.int32)
    ag = np.zeros(n, np.int32)
    hr = np.zeros(n, np.int32)
    ar = np.zeros(n, np.int32)
    bucket = np.array(P["bucket"])
    st = {int(k): v for k, v in P["state"].items()}
    mn = {int(k): v for k, v in P["man"].items()}
    st_arr = np.array([st[s] for s in STATES])
    mn_arr = np.array([mn[-1], mn[0], mn[1]])
    red = np.array(P["redRate"])
    for minute in range(1, 91):
        b = BUCKET_OF[minute]
        gd = np.clip(hg - ag, -2, 2)
        man = np.clip(ar - hr, -1, 1)
        mu_h = lh / 90 * np.exp(bucket[b] + st_arr[gd + 2] + mn_arr[man + 1])
        mu_a = la / 90 * np.exp(bucket[b] + st_arr[-gd + 2] + mn_arr[-man + 1])
        hg += rng.poisson(mu_h)
        ag += rng.poisson(mu_a)
        hr += rng.random(n) < red[b]
        ar += rng.random(n) < red[b]
    return hg, ag


# ------------------------------------------------------------ goalscorers

def roster(team_id):
    try:
        r = requests.get(
            f"https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/teams/{team_id}/roster",
            timeout=30)
        out = []
        for a in r.json().get("athletes", []):
            pos = (a.get("position") or {}).get("abbreviation", "")
            inj = a.get("injuries") or []
            out.append(dict(id=str(a["id"]), name=a.get("displayName"), pos=pos,
                            out=any((i.get("status") or "").lower() in ("out", "injured") for i in inj)))
        return out
    except Exception:
        return []


POS_PRIOR = {"F": 0.10, "M": 0.035, "D": 0.012, "G": 0.0}
OWN_GOAL_SHARE = 0.028  # measured: 6,588 of 230,898 goals in the logs


def scorer_shares(team_id, ev, m, asof, squad, half_life=180.0, k=6.0):
    """Each squad player's share of his team's goals: recency-weighted goals for
    this club over the last 400 days, shrunk toward a position prior with k
    weighted team goals. Shares are per TEAM goal, so a rotation player's share
    already reflects the matches he did not play."""
    t0 = pd.Timestamp(asof, tz="UTC")
    mm = m[((m.home_id == team_id) | (m.away_id == team_id))].copy()
    mm["when"] = pd.to_datetime(mm.date, utc=True)
    mm = mm[(mm.when < t0) & (mm.when > t0 - pd.Timedelta(days=400))]
    w = np.exp(-(t0 - mm.when).dt.days.values / half_life)
    wmap = dict(zip(mm.id, w))
    g = ev[(ev.kind == "goal") & (ev.team_id == team_id) & ev.match_id.isin(wmap) & ~ev.own.astype(bool)]
    team_w = sum(wmap[mid] for mid in g.match_id)
    by_player = {}
    for pid, mid in zip(g.player_id, g.match_id):
        by_player[pid] = by_player.get(pid, 0.0) + wmap[mid]
    rows = []
    for p in squad:
        prior = POS_PRIOR.get(p["pos"][:1], 0.02)
        share = (by_player.get(p["id"], 0.0) + k * prior) / (team_w + k)
        rows.append(dict(p, raw=by_player.get(p["id"], 0.0), share=0.0 if p["out"] else share))
    tot = sum(r["share"] for r in rows) or 1.0
    for r in rows:
        r["share"] = r["share"] / tot * (1 - OWN_GOAL_SHARE)
    return sorted(rows, key=lambda r: -r["share"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--n", type=int, default=20000)
    ap.add_argument("--skip-backtest", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(20261013)

    tuned = json.load(open(os.path.join(HERE, "results", "tuned_params.json")))["params"]
    model = json.load(open(os.path.join(SRC, "ucl-model.json")))
    bh, ba = np.array(model["goals"]["home"]), np.array(model["goals"]["away"])

    m = load_matches()
    ev = load_events()
    rh, ra, final, _ = pre_match_ratings(m, tuned)
    X = feats(rh, ra, m.neutral.values, m.ucl.values)
    lam_h, lam_a = goal_rates((bh, ba), X)

    usable = (m.europe & m.detail.astype(bool) & ~m.et.astype(bool)).values

    # Shipped constants: every European season through 2025-26.
    ship_mask = usable & m.season.between(2014, 2025).values
    P = fit_hazard(minute_grid(m[ship_mask], ev, lam_h[ship_mask], lam_a[ship_mask]))
    P["fittedOn"] = int(ship_mask.sum())
    P["ownGoalShare"] = OWN_GOAL_SHARE

    # Knockouts. Extra time is scored at the 90-minute rate times this factor
    # (goals in minutes 91-120 of every European match that went to extra
    # time, against the model's rates for those matches); a shoot-out is a
    # coin toss — the side hosting it won 49.5% of 212.
    et = (m.europe & m.et.astype(bool) & m.detail.astype(bool) & m.season.between(2014, 2025)).values
    et_goals = ev[(ev.kind == "goal") & ev.match_id.isin(set(m.id[et])) & (ev.minute > 90)]
    P["etFactor"] = float(len(et_goals) / ((lam_h[et] + lam_a[et]).sum() / 90 * 30))
    so = m[m.shootout_home.notna() & m.europe]
    P["shootoutHome"] = 0.5
    P["shootoutSample"] = dict(n=int(len(so)), homeWon=float((so.shootout_home > so.shootout_away).mean()))
    print("extra-time factor", round(P["etFactor"], 3), "shoot-outs", P["shootoutSample"])
    print("minute effects", np.round(np.exp(P["bucket"]), 3))
    print("state effects", {k: round(np.exp(v), 3) for k, v in P["state"].items()})
    print("man effects", {k: round(np.exp(v), 3) for k, v in P["man"].items()})
    print("reds per side per match", round(sum(P["redRate"][b] * (hi - lo + 1) for b, (lo, hi) in enumerate(BUCKETS)), 3))

    if not args.skip_backtest:
        early = usable & m.season.between(2014, 2016).values
        P_bt = fit_hazard(minute_grid(m[early], ev, lam_h[early], lam_a[early]))
        bt = pd.read_csv(os.path.join(HERE, "results", "backtest_matches.csv"))
        bt = bt[bt.season <= 2025].reset_index(drop=True)
        N = 4000
        sims = np.zeros((len(bt), 3))
        tot = np.zeros(len(bt))
        o25 = np.zeros(len(bt))
        btts = np.zeros(len(bt))
        for i, r in bt.iterrows():
            h, a = simulate(np.full(N, r.xg_home), np.full(N, r.xg_away), P_bt, N, rng)
            sims[i] = [(h > a).mean(), (h == a).mean(), (h < a).mean()]
            tot[i] = (h + a).mean()
            o25[i] = ((h + a) > 2.5).mean()
            btts[i] = ((h > 0) & (a > 0)).mean()
        y = bt.result.map({"H": 0, "D": 1, "A": 2}).values
        dc = bt[["p_home", "p_draw", "p_away"]].values
        ok = bt.hg90.notna().values
        act_tot = (bt.hg90 + bt.ag90).values
        act_o25 = (act_tot > 2.5).astype(float)
        act_btts = ((bt.hg90 > 0) & (bt.ag90 > 0)).astype(float).values
        # Score distribution: share of matches by total goals, simulated vs real.
        res = dict(
            n=int(len(bt)), sims_per_match=N,
            simulator=summary(sims, y), scoreline_model=summary(dc, y),
            goals_sim=float(tot[ok].mean()), goals_model=float((bt.xg_home + bt.xg_away)[ok].mean()),
            goals_actual=float(act_tot[ok].mean()),
            draw_sim=float(sims[:, 1].mean()), draw_actual=float((y == 1).mean()),
            over25_sim=float(o25[ok].mean()), over25_actual=float(act_o25[ok].mean()),
            over25_brier_sim=float(((o25 - act_o25)[ok] ** 2).mean()),
            btts_sim=float(btts[ok].mean()), btts_actual=float(act_btts[ok].mean()),
            per_season={int(s): dict(sim=summary(sims[bt.season == s], y[bt.season == s]),
                                     model=summary(dc[bt.season == s], y[bt.season == s]))
                        for s in sorted(bt.season.unique())},
            constants_fitted_on="2014-15..2016-17",
        )
        with open(os.path.join(HERE, "results", "sim_backtest.json"), "w") as f:
            json.dump(res, f, indent=1)
        P["backtest"] = {k: res[k] for k in ("n", "sims_per_match", "simulator", "scoreline_model",
                                              "goals_sim", "goals_actual", "draw_sim", "draw_actual",
                                              "over25_sim", "over25_actual", "btts_sim", "btts_actual")}
        print(json.dumps({k: v for k, v in res.items() if k != "per_season"}, indent=1))

    with open(os.path.join(SRC, "ucl-sim.json"), "w") as f:
        json.dump(P, f, indent=1)

    # ---- play the date's fixtures
    slate_path = os.path.join(HERE, "results", f"slate_{args.date}.json")
    if not os.path.exists(slate_path):
        return
    slate = json.load(open(slate_path))["slate"]
    out = []
    for g in slate:
        n = args.n
        h, a = simulate(np.full(n, g["xg_home"]), np.full(n, g["xg_away"]), P, n, rng)
        scores = pd.Series([f"{x}-{y}" for x, y in zip(h, a)]).value_counts(normalize=True).head(6)
        rec = dict(id=g["id"], home=g["home_name"], away=g["away_name"], kickoff=g["kickoff"], n=n,
                   home_win=float((h > a).mean()), draw=float((h == a).mean()), away_win=float((h < a).mean()),
                   avg_home=float(h.mean()), avg_away=float(a.mean()),
                   over25=float(((h + a) > 2.5).mean()), btts=float(((h > 0) & (a > 0)).mean()),
                   home_clean_sheet=float((a == 0).mean()), away_clean_sheet=float((h == 0).mean()),
                   scores=[dict(score=s, p=float(p)) for s, p in scores.items()],
                   model=dict(home=g["home"], draw=g["draw"], away=g["away"]), market=g.get("market"))
        # Anytime scorers: each simulated goal goes to a player by share, so a
        # player's chance is 1 - E[(1 - share)^goals].
        for side, goals_arr, tid in (("home", h, g["home_id"]), ("away", a, g["away_id"])):
            squad = roster(tid)
            shares = scorer_shares(tid, ev, m, g["kickoff"], squad)
            rec[f"{side}_scorers"] = [
                dict(name=p["name"], pos=p["pos"], share=p["share"],
                     anytime=float(1 - np.mean((1 - p["share"]) ** goals_arr)))
                for p in shares[:6] if p["share"] > 0
            ]
        out.append(rec)
        mk = g.get("market")
        print(f"\n{g['home_name']} v {g['away_name']}  ({n:,} sims)")
        print(f"  sim  {rec['home_win']:.1%} / {rec['draw']:.1%} / {rec['away_win']:.1%}   avg {rec['avg_home']:.2f}-{rec['avg_away']:.2f}"
              f"   O2.5 {rec['over25']:.0%}  BTTS {rec['btts']:.0%}")
        if mk:
            print(f"  mkt  {mk['home']:.1%} / {mk['draw']:.1%} / {mk['away']:.1%}")
        print("  scores " + ", ".join(f"{s['score']} {s['p']:.1%}" for s in rec["scores"]))
        for side in ("home", "away"):
            print(f"  {side}: " + ", ".join(f"{p['name']} {p['anytime']:.0%}" for p in rec[f"{side}_scorers"][:4]))
    with open(os.path.join(HERE, "results", f"sim_{args.date}.json"), "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
