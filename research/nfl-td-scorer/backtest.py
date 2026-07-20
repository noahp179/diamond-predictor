"""
Walk-forward backtest of the anytime-TD-scorer model.

Protocol (no leakage):
  * Games are processed in real chronological order (by kickoff day).
  * All 2021 games seed the running state and calibrate the league priors.
  * Every 2022-2024 game is PREDICTED from state built only from earlier days,
    then its box score is ingested to update state.
  * A player's features come only from prior games. The only forward-looking
    thing we condition on is the active list - we score players who appeared in
    the box score, exactly as a bettor conditions on inactives published before
    kickoff. We never use whether/how they scored as an input.

Outputs: metrics to stdout, metrics.json, and predictions.csv.
"""
from __future__ import annotations
import os, json, math
from collections import defaultdict
import numpy as np
import pandas as pd

from model import (PlayerState, TeamState, LeaguePriors, predict_team,
                   confidence, MIN_TOUCHES)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PRIOR_SEASON = 2021
SCORE_SEASONS = {2022, 2023, 2024}


# --------------------------------------------------------------------------- #
def load():
    pg = pd.read_csv(os.path.join(DATA, "player_games.csv"))
    tg = pd.read_csv(os.path.join(DATA, "team_games.csv"))
    pg["player_id"] = pg["player_id"].astype(str)
    # one boxscore row per (game, player); sort games chronologically
    order = tg[["game_id", "season", "week", "game_type", "gameday"]].drop_duplicates()
    order = order.sort_values(["gameday", "game_id"]).reset_index(drop=True)
    return pg, tg, order


def league_priors(pg, tg):
    p = pg[pg.season == PRIOR_SEASON]
    t = tg[tg.season == PRIOR_SEASON]
    return LeaguePriors(
        rush_td_per_carry=p.rush_td.sum() / max(p.carries.sum(), 1),
        rec_td_per_target=p.rec_td.sum() / max(p.targets.sum(), 1),
        team_rush_td=t.rush_td.mean(),
        team_rec_td=t.rec_td.mean(),
    )


# ------------------------------- metrics ----------------------------------- #
def auc(y, p):
    y = np.asarray(y); p = np.asarray(p)
    n1, n0 = y.sum(), (1 - y).sum()
    if n1 == 0 or n0 == 0:
        return float("nan")
    order = p.argsort()
    ranks = np.empty(len(p)); ranks[order] = np.arange(1, len(p) + 1)
    # average ranks for ties
    _, inv, cnt = np.unique(p, return_inverse=True, return_counts=True)
    csum = np.cumsum(cnt); start = csum - cnt
    avg = (start + csum + 1) / 2.0
    ranks = avg[inv]
    return (ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def brier(y, p):
    y = np.asarray(y); p = np.asarray(p)
    return float(np.mean((p - y) ** 2))


def logloss(y, p, eps=1e-12):
    y = np.asarray(y); p = np.clip(np.asarray(p), eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def calibration(y, p, bins=10):
    y = np.asarray(y); p = np.asarray(p)
    edges = np.linspace(0, 1, bins + 1)
    rows, ece = [], 0.0
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        m = (p >= lo) & (p < hi) if i < bins - 1 else (p >= lo) & (p <= hi)
        if m.sum() == 0:
            continue
        mp, ma, n = p[m].mean(), y[m].mean(), int(m.sum())
        rows.append((lo, hi, n, mp, ma))
        ece += n / len(y) * abs(mp - ma)
    return rows, ece


# ------------------------------ walk forward ------------------------------- #
def run(score_seasons=SCORE_SEASONS, do_report=True, verbose=True, collect_features=False):
    from model import team_expected_tds
    pg, tg, order = load()
    pri = league_priors(pg, tg)
    feat_rows = []
    if verbose:
        print(f"League priors (from {PRIOR_SEASON}): "
              f"rushTD/carry={pri.rush_td_per_carry:.4f}  recTD/target={pri.rec_td_per_target:.4f}  "
              f"teamRushTD/g={pri.team_rush_td:.3f}  teamRecTD/g={pri.team_rec_td:.3f}")

    players: dict[str, PlayerState] = {}
    teams: dict[str, TeamState] = {}
    # fast lookups
    pg_by_game = {gid: df for gid, df in pg.groupby("game_id")}
    tg_by_game = {gid: df for gid, df in tg.groupby("game_id")}

    records = []          # per predicted player-game
    game_rows = []        # per game (for pick metrics)

    # group games by day so same-day games never inform each other
    for day, day_df in order.groupby("gameday", sort=True):
        day_games = list(day_df["game_id"])
        # ---- 1) PREDICT every scored game on this day from current state ----
        for gid in day_games:
            tinfo = tg_by_game[gid]
            season = int(tinfo.season.iloc[0]); week = int(tinfo.week.iloc[0])
            if season not in score_seasons:
                continue
            box = pg_by_game.get(gid)
            if box is None:
                continue
            two = list(tinfo.itertuples())
            game_preds = []
            ctx = {}   # player_id -> feature context (for the bake-off feature matrix)
            for trow in two:
                team, opp = trow.team, trow.opp
                off_state = teams.get(team) or TeamState(team)
                def_state = teams.get(opp) or TeamState(opp)
                # active players for this team = those in the box score with prior history
                roster = []
                present = box[box.team == team]
                for r in present.itertuples():
                    st = players.get(str(r.player_id))
                    if st is not None:
                        roster.append(st)
                preds = predict_team(off_state, def_state, roster, opp, pri)
                game_preds.extend(preds)
                if collect_features:
                    ter, tec = team_expected_tds(off_state, def_state, pri)
                    tpc = sum(p.proj_carries() for p in roster) or 1e-9
                    tpt = sum(p.proj_targets() for p in roster) or 1e-9
                    home = gid.split("_")[-1]      # game_id = SEASON_WEEK_AWAY_HOME
                    for p in roster:
                        ctx[p.player_id] = dict(
                            st=p, off=off_state, deff=def_state, ter=ter, tec=tec,
                            tpc=tpc, tpt=tpt, is_home=int(team == home),
                            team=team, opp=opp)   # CURRENT game team, not stale state

            if not game_preds:
                continue
            # attach actual outcome (offensive TD from the box score) + confidence
            box_idx = {str(r.player_id): r for r in box.itertuples()}
            ranked = sorted(game_preds, key=lambda x: x.p_td, reverse=True)
            for pr in game_preds:
                r = box_idx.get(pr.player_id)
                scored = int((r.rush_td + r.rec_td) > 0) if r is not None else 0
                records.append({
                    "game_id": gid, "season": season, "week": week,
                    "player_id": pr.player_id, "player": pr.player, "team": pr.team,
                    "opp": pr.opp, "p_td": pr.p_td, "lam": pr.lam,
                    "conf": confidence(pr, ranked), "proj_touch": pr.proj_carries + pr.proj_targets,
                    "games_hist": pr.games, "scored": scored,
                })
                if collect_features and pr.player_id in ctx:
                    c = ctx[pr.player_id]; p = c["st"]
                    feat_rows.append({
                        "game_id": gid, "season": season, "week": week,
                        "player_id": pr.player_id, "player": pr.player,
                        "team": c["team"], "opp": c["opp"], "scored": scored,
                        # --- usage ---
                        "proj_carries": p.proj_carries(), "proj_targets": p.proj_targets(),
                        "proj_rush_yds": p.proj_rush_yds(), "proj_rec_yds": p.proj_rec_yds(),
                        "proj_touches": p.proj_carries() + p.proj_targets(),
                        "carry_share": p.proj_carries() / c["tpc"],
                        "target_share": p.proj_targets() / c["tpt"],
                        # --- efficiency / form ---
                        "rush_td_rate": p.rush_td_rate(pri), "rec_td_rate": p.rec_td_rate(pri),
                        "anytime_rate": p.anytime_rate(), "ewma_scored": p.ewma_scored,
                        "games_hist": p.games,
                        # --- team / matchup ---
                        "team_off_rush": c["off"].off_rating(pri, "rush"),
                        "team_off_rec": c["off"].off_rating(pri, "rec"),
                        "opp_def_rush": c["deff"].def_rating(pri, "rush"),
                        "opp_def_rec": c["deff"].def_rating(pri, "rec"),
                        "team_exp_rush_td": c["ter"], "team_exp_rec_td": c["tec"],
                        "is_home": c["is_home"],
                        # --- incumbent model output (so ML can refine it) ---
                        "poisson_p": pr.p_td, "poisson_lam": pr.lam,
                        "poisson_lam_rush": pr.lam_rush, "poisson_lam_rec": pr.lam_rec,
                    })
            # ---- game-level pick metrics ----
            actual_scorers = {str(r.player_id) for r in box.itertuples()
                              if (r.rush_td + r.rec_td) > 0}
            predicted_ids = {p.player_id for p in game_preds}
            top1 = ranked[0]
            top2 = ranked[:2]
            # baseline: highest projected touches
            vol_top1 = max(game_preds, key=lambda x: x.proj_carries + x.proj_targets)
            game_rows.append({
                "game_id": gid, "season": season, "week": week,
                "top1_id": top1.player_id, "top1_p": top1.p_td,
                "top1_conf": confidence(top1, ranked),
                "top1_hit": int(top1.player_id in actual_scorers),
                "top2_hit": int(any(p.player_id in actual_scorers for p in top2)),
                "vol_top1_hit": int(vol_top1.player_id in actual_scorers),
                "n_scorers": len(actual_scorers),
                "n_scorers_covered": len(actual_scorers & predicted_ids),
                "recall_at2": (len(actual_scorers & {p.player_id for p in top2}) /
                               len(actual_scorers)) if actual_scorers else float("nan"),
                "recall_at3": (len(actual_scorers & {p.player_id for p in ranked[:3]}) /
                               len(actual_scorers)) if actual_scorers else float("nan"),
            })

        # ---- 2) INGEST this day's games to update state (after predicting) ----
        for gid in day_games:
            box = pg_by_game.get(gid); tinfo = tg_by_game.get(gid)
            if box is None or tinfo is None:
                continue
            for r in box.itertuples():
                pid = str(r.player_id)
                st = players.get(pid) or PlayerState(pid, r.player, r.team)
                st.player = r.player
                st.update(r.carries, r.targets, r.rush_td, r.rec_td, r.team,
                          rush_yds=r.rush_yds, rec_yds=r.rec_yds)
                players[pid] = st
            for trow in tinfo.itertuples():
                team, opp = trow.team, trow.opp
                ts = teams.get(team) or TeamState(team)
                ts.update_off(trow.rush_td, trow.rec_td)
                teams[team] = ts
                ds = teams.get(opp) or TeamState(opp)
                # opponent's defense allowed this team's rush/rec TDs
                ds.update_def(trow.rush_td, trow.rec_td)
                teams[opp] = ds

    rec, games = pd.DataFrame(records), pd.DataFrame(game_rows)
    if collect_features:
        return rec, games, pd.DataFrame(feat_rows)
    if do_report:
        return report(rec, games, pri)
    return rec, games


# ------------------------------- reporting --------------------------------- #
def report(rec: pd.DataFrame, games: pd.DataFrame, pri):
    out = {}
    y, p = rec.scored.values, rec.p_td.values
    base = y.mean()
    out["n_player_games"] = int(len(rec))
    out["n_games"] = int(len(games))
    out["base_rate"] = float(base)

    print("\n" + "=" * 70)
    print(f"BACKTEST  seasons={sorted(SCORE_SEASONS)}  "
          f"player-game predictions={len(rec):,}  games={len(games):,}")
    print("=" * 70)

    # ---- player-level discrimination / calibration ----
    print("\n[Player-level probability quality]  (all ranked players, per game)")
    model_brier, model_ll, model_auc = brier(y, p), logloss(y, p), auc(y, p)
    base_brier, base_ll = brier(y, np.full_like(p, base)), logloss(y, np.full_like(p, base))
    print(f"  anytime-TD base rate among ranked players : {base:.3f}")
    print(f"  Brier   model={model_brier:.4f}   base(const)={base_brier:.4f}   "
          f"skill={1-model_brier/base_brier:+.1%}")
    print(f"  LogLoss model={model_ll:.4f}   base(const)={base_ll:.4f}   "
          f"skill={1-model_ll/base_ll:+.1%}")
    print(f"  ROC AUC model={model_auc:.4f}   (0.5 = no skill)")
    out.update(model_brier=model_brier, model_logloss=model_ll, model_auc=model_auc,
               base_brier=base_brier, base_logloss=base_ll)

    rows, ece = calibration(y, p)
    print(f"\n[Calibration]  ECE={ece:.4f}")
    print("  bin            n     pred    actual")
    for lo, hi, n, mp, ma in rows:
        print(f"  {lo:.1f}-{hi:.1f}   {n:6d}   {mp:.3f}   {ma:.3f}   {'#'*int(ma*40)}")
    out["ece"] = ece
    out["calibration"] = [dict(lo=lo, hi=hi, n=n, pred=mp, actual=ma) for lo, hi, n, mp, ma in rows]

    # ---- game-level pick accuracy ----
    print("\n[Pick accuracy]  (rank players across BOTH teams)")
    t1 = games.top1_hit.mean(); t2 = games.top2_hit.mean(); vol = games.vol_top1_hit.mean()
    print(f"  Top-1 pick scored a TD           : {t1:.1%}   "
          f"(volume-only baseline {vol:.1%};  lift {t1-vol:+.1%})")
    print(f"  Top-2: at least one scored       : {t2:.1%}")
    print(f"  Top-1 lift over avg ranked player: {t1/base:.2f}x")
    cov = games.n_scorers_covered.sum() / games.n_scorers.sum()
    print(f"  Recall@2 (mean over games)       : {games.recall_at2.mean():.1%}")
    print(f"  Recall@3 (mean over games)       : {games.recall_at3.mean():.1%}")
    print(f"  Coverage of actual TD scorers    : {cov:.1%} "
          f"(rest = debuts / non-offensive TDs)")
    out.update(top1_hit=float(t1), top2_hit=float(t2), vol_top1_hit=float(vol),
               top1_lift=float(t1/base), recall_at2=float(games.recall_at2.mean()),
               recall_at3=float(games.recall_at3.mean()), scorer_coverage=float(cov))

    # ---- confidence validation ----
    print("\n[Confidence validation]  top-1 hit rate by confidence bucket")
    gq = games.copy()
    gq["cbin"] = pd.cut(gq.top1_conf, [0, 40, 55, 70, 100], include_lowest=True)
    cv = []
    for b, sub in gq.groupby("cbin", observed=True):
        print(f"  conf {str(b):12s}  n={len(sub):4d}   top-1 hit={sub.top1_hit.mean():.1%}   "
              f"avg p={sub.top1_p.mean():.3f}")
        cv.append(dict(bucket=str(b), n=int(len(sub)), hit=float(sub.top1_hit.mean())))
    out["confidence_buckets"] = cv

    # ---- likelihood decile check on the actual pick prob ----
    print("\n[Top-1 likelihood vs realized]  does a higher stated likelihood pay off?")
    gp = games.copy()
    gp["pbin"] = pd.qcut(gp.top1_p, 4, duplicates="drop")
    for b, sub in gp.groupby("pbin", observed=True):
        print(f"  stated p {str(b):16s} n={len(sub):4d}  realized hit={sub.top1_hit.mean():.1%}")

    # ---- per-season split ----
    print("\n[By season]")
    for s, sub in games.groupby("season"):
        print(f"  {s}: games={len(sub):4d}  top1={sub.top1_hit.mean():.1%}  "
              f"top2={sub.top2_hit.mean():.1%}  vol={sub.vol_top1_hit.mean():.1%}")

    rec.to_csv(os.path.join(HERE, "predictions.csv"), index=False)
    games.to_csv(os.path.join(HERE, "game_picks.csv"), index=False)
    with open(os.path.join(HERE, "metrics.json"), "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved predictions.csv, game_picks.csv, metrics.json to {HERE}")
    return out, rec, games


if __name__ == "__main__":
    run()
