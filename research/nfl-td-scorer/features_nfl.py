"""
Point-in-time features for the NFL touchdown bakeoff.

Mirrors `aggregateTeam` and `featureVector` in src/lib/nfl-td.server.ts line for
line, because the whole point of the exercise is to compare ALGORITHMS on the
features the shipped model actually sees. A feature table that drifted from the
live one would make every comparison below a comparison of two things at once.

Three details carried over exactly:

  the usage window   below six games this season, the window is topped up with
                     the TAIL of last season — the last (6 - played) games, not
                     a scaled blend. College needed the scaled version because
                     its live feed gives season totals; the NFL module rebuilds
                     from box scores and has the game log, so it takes real
                     games and this does too.

  player games       `gp` is games the PLAYER touched the ball in, not his
                     team's games. The NFL board can see that and college's
                     cannot, so unlike CFB-ANALYSIS.md §3 there is no
                     serve-parity compromise to make here.

  targets            NFL box scores carry receivingTargets. Target share is a
                     share of intent; college only has receptions, which is
                     intent plus outcome. That is why the two models have
                     different feature lists.

The shrinkage constants come from the shipped model file so the fitted model and
the challengers are standing on identical ground.
"""
import os, json
import numpy as np
import pandas as pd
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MODEL = os.path.abspath(os.path.join(HERE, "td-model.json"))

_m = json.load(open(MODEL))
C = _m["constants"]
K_RUSH, K_REC, K_ANY = C["K_RUSH"], C["K_REC"], C["K_ANY"]
LG_RUSH, LG_REC, LG_ANY = C["LG_RUSH"], C["LG_REC"], C["LG_ANY"]
USAGE_WINDOW = 6

FEATURES = _m["features"]  # the shipped 18, in the shipped order


def _blank_player():
    return {"gp": 0, "cgp": 0, "car": 0.0, "tgt": 0.0, "ry": 0.0, "cy": 0.0,
            "rtd": 0.0, "ctd": 0.0, "scg": 0.0}


def _blank_team():
    return {"gp": 0, "carried": 0, "car": 0.0, "tgt": 0.0, "rtd": 0.0, "ctd": 0.0,
            "dRtd": 0.0, "dCtd": 0.0}


def _accumulate(agg_p, agg_t, rows, team_row):
    """Fold one team-game into the running totals."""
    agg_t["gp"] += 1
    agg_t["rtd"] += team_row["team_rush_td"]
    agg_t["ctd"] += team_row["team_rec_td"]
    agg_t["dRtd"] += team_row["opp_rush_td"]
    agg_t["dCtd"] += team_row["opp_rec_td"]
    for r in rows:
        agg_t["car"] += r["car"]
        agg_t["tgt"] += r["tgt"]
        a = agg_p[r["player_id"]]
        a["gp"] += 1
        a["car"] += r["car"]
        a["tgt"] += r["tgt"]
        a["ry"] += r["rush_yds"]
        a["cy"] += r["rec_yds"]
        a["rtd"] += r["rush_td"]
        a["ctd"] += r["rec_td"]
        a["scg"] += 1 if r["scored"] else 0


def build():
    games = pd.read_csv(os.path.join(DATA, "nfl_games.csv"), dtype={"game_id": str})
    pg = pd.read_csv(os.path.join(DATA, "nfl_player_games.csv"), dtype={"game_id": str,
                                                                        "player_id": str})
    games = games.sort_values(["date", "game_id"])
    by_game_team = {}
    for (gid, team), grp in pg.groupby(["game_id", "team"]):
        by_game_team[(gid, team)] = grp.to_dict("records")

    rows = []
    for season, sgames in games.groupby("season", sort=True):
        # Per-team game LOG for this season and the one before, so the window
        # can take real games rather than a scaled share.
        prev_log = defaultdict(list)   # team -> [(date, game_id)] last season
        prev = games[games.season == season - 1].sort_values(["date", "game_id"])
        for _, g in prev.iterrows():
            for side in ("home", "away"):
                prev_log[g[side]].append((g["date"], g["game_id"]))

        cur_log = defaultdict(list)
        for _, g in sgames.sort_values(["date", "game_id"]).iterrows():
            gid = g["game_id"]
            for side, opp_side, is_home in (("home", "away", 1), ("away", "home", 0)):
                team, opp = g[side], g[opp_side]
                mine_games = list(cur_log[team])
                opp_games = list(cur_log[opp])
                # top up from the tail of last season when this season is thin
                mine_carry = (prev_log[team][-(USAGE_WINDOW - len(mine_games)):]
                              if len(mine_games) < USAGE_WINDOW else [])
                opp_carry = (prev_log[opp][-(USAGE_WINDOW - len(opp_games)):]
                             if len(opp_games) < USAGE_WINDOW else [])
                mine_all = mine_carry + mine_games
                opp_all = opp_carry + opp_games
                if not mine_all or not opp_all:
                    continue

                P, T = defaultdict(_blank_player), _blank_team()
                for i, (_, past) in enumerate(mine_all):
                    r = by_game_team.get((past, team))
                    if not r:
                        continue
                    _accumulate(P, T, r, r[0])
                    if i < len(mine_carry):
                        T["carried"] += 1
                        for x in r:
                            P[x["player_id"]]["cgp"] += 1
                OP, OT = defaultdict(_blank_player), _blank_team()
                for _, past in opp_all:
                    r = by_game_team.get((past, opp))
                    if not r:
                        continue
                    _accumulate(OP, OT, r, r[0])
                if T["gp"] < 1 or OT["gp"] < 1:
                    continue

                total = g["total"]
                home_spread = g["home_spread"]
                implied = (total / 2 - home_spread / 2) if is_home else (total / 2 + home_spread / 2)
                margin = -home_spread if is_home else home_spread

                for r in by_game_team.get((gid, team), []):
                    p = P.get(r["player_id"])
                    if not p or p["gp"] < 1 or (p["car"] + p["tgt"]) < 1:
                        continue
                    rows.append({
                        "season": season, "week": g["week"], "date": g["date"],
                        "game_id": gid, "team": team, "opp": opp,
                        "player_id": r["player_id"], "player": r["player"],
                        "carry_share": p["car"] / T["car"] if T["car"] else 0.0,
                        "target_share": p["tgt"] / T["tgt"] if T["tgt"] else 0.0,
                        "cpg": p["car"] / p["gp"],
                        "tpg": p["tgt"] / p["gp"],
                        "rush_ypg": p["ry"] / p["gp"],
                        "rec_ypg": p["cy"] / p["gp"],
                        "rush_td_rate": (p["rtd"] + K_RUSH * LG_RUSH) / (p["car"] + K_RUSH),
                        "rec_td_rate": (p["ctd"] + K_REC * LG_REC) / (p["tgt"] + K_REC),
                        "anytime_rate": (p["scg"] + K_ANY * LG_ANY) / (p["gp"] + K_ANY),
                        "gp": min(p["gp"], 17),
                        "team_rush_tdpg": T["rtd"] / T["gp"],
                        "team_rec_tdpg": T["ctd"] / T["gp"],
                        "opp_rush_td_allowed_pg": OT["dRtd"] / OT["gp"],
                        "opp_rec_td_allowed_pg": OT["dCtd"] / OT["gp"],
                        "is_home": is_home,
                        "mkt_implied_total": implied,
                        "mkt_total": total,
                        "mkt_team_margin": margin,
                        "carried": p["cgp"],
                        "td_count": r["rush_td"] + r["rec_td"],
                        "scored": int(r["scored"]),
                    })
            cur_log[g["home"]].append((g["date"], gid))
            cur_log[g["away"]].append((g["date"], gid))

    df = pd.DataFrame(rows)
    print(f"built {len(df):,} rows across {df.game_id.nunique():,} games, "
          f"{df.scored.mean()*100:.1f}% scored")
    return df


if __name__ == "__main__":
    df = build()
    df.to_csv(os.path.join(DATA, "nfl_features.csv"), index=False)
    print("wrote data/nfl_features.csv")
