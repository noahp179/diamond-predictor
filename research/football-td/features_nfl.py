"""
Point-in-time NFL features, exactly as research/nfl-td-scorer/features_nfl.py
builds them, plus the rows that pipeline leaves out.

    python3 research/football-td/features_nfl.py   # after fetch_nfl.py

Reads data/nfl_games.csv + data/nfl_player_games.csv (fetch_nfl.py) and the
shipped shrinkage constants from research/nfl-td-scorer/td-model.json (read
only). Writes data/nfl_features_all.csv.

ROW KINDS (column `kind`)
  candidate   the original pipeline's rows, built line for line and IN THE SAME
              ORDER (the ranker's pair sampling depends on row order). A player
              is a candidate when he recorded >=1 carry or target in THIS game
              for this team AND has >=1 game of usage in the team's window
              (this season to date, topped up with the tail of last season
              below six games). Every quoted metric is computed on these rows.
  no_history  recorded a carry/target in this game but the model could not
              price him (no usage in the window, or the side had no history).
              prob is blank. Kept so TDs the model never saw are visible.
  no_touch    had usage for this team earlier THIS season but recorded no carry
              or target in this game (inactive, injured, released, traded, or
              simply unused). The model can price him and does; scored = 0 by
              construction. NOT in the quoted metrics. `games_since_touch`
              (team games since his last carry/target for this team; 0 = the
              previous game) lets a consumer approximate an active-roster filter.
"""
import os, json
import numpy as np
import pandas as pd
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MODEL = os.path.abspath(os.path.join(HERE, "..", "nfl-td-scorer", "td-model.json"))

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


def _feat(p, T, OT, is_home, implied, total, margin):
    return {
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
    }


def build():
    games = pd.read_csv(os.path.join(DATA, "nfl_games.csv"), dtype={"game_id": str})
    pg = pd.read_csv(os.path.join(DATA, "nfl_player_games.csv"), dtype={"game_id": str,
                                                                        "player_id": str,
                                                                        "espn_team_id": str})
    games = games.sort_values(["date", "game_id"])
    by_game_team = {}
    for (gid, team), grp in pg.groupby(["game_id", "team"]):
        by_game_team[(gid, team)] = grp.to_dict("records")

    rows, extra = [], []
    for season, sgames in games.groupby("season", sort=True):
        prev_log = defaultdict(list)
        prev = games[games.season == season - 1].sort_values(["date", "game_id"])
        for _, g in prev.iterrows():
            for side in ("home", "away"):
                prev_log[g[side]].append((g["date"], g["game_id"]))

        cur_log = defaultdict(list)
        for _, g in sgames.sort_values(["date", "game_id"]).iterrows():
            gid = g["game_id"]
            for side, opp_side, is_home in (("home", "away", 1), ("away", "home", 0)):
                team, opp = g[side], g[opp_side]
                base = {"season": season, "week": g["week"], "date": g["date"],
                        "game_id": gid, "team": team, "opp": opp, "is_home": is_home,
                        "game_type": g.get("game_type", "")}
                box_rows = by_game_team.get((gid, team), [])

                def unpriced(reason, skip=()):
                    for r in box_rows:
                        if r["player_id"] in skip:
                            continue
                        extra.append({**base, "kind": "no_history", "unpriced_reason": reason,
                                      "player_id": r["player_id"], "player": r["player"],
                                      "espn_team_id": r.get("espn_team_id", ""),
                                      "car_g": r["car"], "tgt_g": r["tgt"],
                                      "rush_td_g": r["rush_td"], "rec_td_g": r["rec_td"],
                                      "td_count": r["rush_td"] + r["rec_td"],
                                      "scored": int(r["scored"])})

                mine_games = list(cur_log[team])
                opp_games = list(cur_log[opp])
                mine_carry = (prev_log[team][-(USAGE_WINDOW - len(mine_games)):]
                              if len(mine_games) < USAGE_WINDOW else [])
                opp_carry = (prev_log[opp][-(USAGE_WINDOW - len(opp_games)):]
                             if len(opp_games) < USAGE_WINDOW else [])
                mine_all = mine_carry + mine_games
                opp_all = opp_carry + opp_games
                if not mine_all or not opp_all:
                    unpriced("no_team_history")
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
                    unpriced("no_team_history")
                    continue

                total = g["total"]
                home_spread = g["home_spread"]
                implied = (total / 2 - home_spread / 2) if is_home else (total / 2 + home_spread / 2)
                margin = -home_spread if is_home else home_spread

                seen = set()
                skipped = set()
                for r in box_rows:
                    seen.add(r["player_id"])
                    p = P.get(r["player_id"])
                    if not p or p["gp"] < 1 or (p["car"] + p["tgt"]) < 1:
                        skipped.add(r["player_id"])
                        continue
                    rows.append({
                        "season": season, "week": g["week"], "date": g["date"],
                        "game_id": gid, "team": team, "opp": opp,
                        "player_id": r["player_id"], "player": r["player"],
                        **_feat(p, T, OT, is_home, implied, total, margin),
                        "carried": p["cgp"],
                        "td_count": r["rush_td"] + r["rec_td"],
                        "scored": int(r["scored"]),
                        # extras (not used by the model)
                        "kind": "candidate", "game_type": base["game_type"],
                        "espn_team_id": r.get("espn_team_id", ""),
                        "car_g": r["car"], "tgt_g": r["tgt"],
                        "rush_td_g": r["rush_td"], "rec_td_g": r["rec_td"],
                    })
                if skipped:
                    for r in box_rows:
                        if r["player_id"] in skipped:
                            extra.append({**base, "kind": "no_history",
                                          "unpriced_reason": "no_prior_usage",
                                          "player_id": r["player_id"], "player": r["player"],
                                          "espn_team_id": r.get("espn_team_id", ""),
                                          "car_g": r["car"], "tgt_g": r["tgt"],
                                          "rush_td_g": r["rush_td"], "rec_td_g": r["rec_td"],
                                          "td_count": r["rush_td"] + r["rec_td"],
                                          "scored": int(r["scored"])})

                # no_touch: used by this team earlier THIS season, no touch today
                last_touch, names = {}, {}
                for k, (_, past) in enumerate(mine_games):
                    for x in by_game_team.get((past, team), []):
                        last_touch[x["player_id"]] = k
                        names[x["player_id"]] = x["player"]
                for pid, k in last_touch.items():
                    if pid in seen:
                        continue
                    p = P.get(pid)
                    if not p or p["gp"] < 1 or (p["car"] + p["tgt"]) < 1:
                        continue
                    extra.append({**base, "kind": "no_touch", "player_id": pid,
                                  "player": names[pid],
                                  **_feat(p, T, OT, is_home, implied, total, margin),
                                  "carried": p["cgp"],
                                  "games_since_touch": len(mine_games) - 1 - k,
                                  "car_g": 0, "tgt_g": 0, "rush_td_g": 0, "rec_td_g": 0,
                                  "td_count": 0, "scored": 0})
            cur_log[g["home"]].append((g["date"], gid))
            cur_log[g["away"]].append((g["date"], gid))

    df = pd.DataFrame(rows)
    ex = pd.DataFrame(extra)
    print(f"built {len(df):,} candidate rows across {df.game_id.nunique():,} games, "
          f"{df.scored.mean()*100:.1f}% scored; {len(ex):,} extra rows "
          f"({ex.kind.value_counts().to_dict() if len(ex) else {}})")
    return df, ex


if __name__ == "__main__":
    df, ex = build()
    out = pd.concat([df, ex], ignore_index=True, sort=False)
    out.to_csv(os.path.join(DATA, "nfl_features_all.csv"), index=False)
    print("wrote data/nfl_features_all.csv (candidate rows first, in the original order)")
