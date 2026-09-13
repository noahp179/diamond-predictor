"""
Point-in-time features for the college anytime-TD model.

One row per (game, player) for every player who touched the ball, built only
from games played STRICTLY BEFORE that game's date. Nothing in a row can have
been unknown at kickoff — that is the whole discipline of the exercise, and the
reason the numbers in CFB-ANALYSIS.md are worth reading.

The feature list mirrors the NFL model (research/nfl-td-scorer) with three
changes college forces:

  receptions, not targets   ESPN publishes no college target data, so every
                           receiving share here is a share of catches.

  no market features        The NFL model uses the book's implied team total.
                           ESPN drops college lines once a game is final, so
                           that feature cannot be backtested — it is replaced
                           by `proj_team_pts`, the same idea built from scoring
                           history (this offence's points per game averaged
                           with this defence's points allowed).

  an Elo term              `elo_margin` — the projected points margin from the
                           tuned margin-of-victory Elo (elo_backtest.py), which
                           is the model's own read on game shape. Replayed
                           point-in-time exactly like everything else.

THE RULE THIS FILE OBEYS
------------------------
A feature is only allowed here if the live board can compute the same number
the same way. That is stricter than "no leakage", and it costs something real —
two features below are deliberately cruder than the box scores would allow:

  per-game rates use the TEAM's games, not the player's. ESPN's roster feed —
  the only source fast enough to price a 70-game Saturday — gives season totals
  with no games-played count. So a player who missed two games is divided by
  his team's games here too, because that is what serving will do.

  `anytime_rate` counts touchdowns capped at one per team game, rather than
  games scored in. Same reason: totals, not a game log. It overstates a
  two-touchdown afternoon, and it overstates it identically in training and in
  production, which is the property that matters.

Fitting on the clean version and serving the crude one would make every number
in CFB-ANALYSIS.md a description of a model that never runs. Measured on the
players who actually get picked, that gap was worth 0.13 of anytime_rate —
0.47 against 0.60 — which is not a rounding error.
"""
import os, json, math
import pandas as pd
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# Shrinkage constants: how many league-average touches to blend into a rate
# before trusting the player's own. College samples are shorter than the NFL's
# (12 games, not 17) and the tails are wilder, so these matter more here.
K_RUSH, K_REC, K_ANY = 25.0, 20.0, 4.0

# Games of usage a player needs behind them. Below this, last season's tail is
# pulled in — Week 1 otherwise has nothing at all to read.
USAGE_WINDOW = 5

# Everything the feature table carries.
ALL_FEATURES = [
    "carry_share", "rec_share", "cpg", "rpg", "rush_ypg", "rec_ypg",
    "rush_td_rate", "rec_td_rate", "anytime_rate", "gp",
    "team_rush_tdpg", "team_rec_tdpg",
    "opp_rush_td_allowed_pg", "opp_rec_td_allowed_pg",
    "is_home", "proj_team_pts", "proj_total", "elo_margin",
]

# What the shipped model uses. The two opponent touchdowns-allowed terms are
# left out, and that is a measured decision, not a shortcut: ablate.py refits
# without them and held-out AUC moves from 0.6928 to 0.6927, with the board's
# hit rate and picks-per-game unchanged to the decimal. They are redundant with
# `proj_team_pts`, which already carries how many points this opponent gives up.
#
# They are also the only two features the live board could not afford. Every
# other feature comes from one roster call per team plus the season scoreboards
# the Elo replay already reads — about ten seconds for a 70-game Saturday.
# Touchdowns allowed would mean refetching every box score every opponent has
# played, which is a research-scale job, not a page load. Paying a minute of
# latency for the fourth decimal of AUC is not a trade worth making.
EXPENSIVE = ["opp_rush_td_allowed_pg", "opp_rec_td_allowed_pg"]
FEATURES = [f for f in ALL_FEATURES if f not in EXPENSIVE]


def league_rates(pg):
    """League-average TD per carry / per reception / per game, for shrinkage."""
    return {
        "LG_RUSH": pg["rush_td"].sum() / max(1, pg["car"].sum()),
        "LG_REC": pg["rec_td"].sum() / max(1, pg["rec"].sum()),
        "LG_ANY": pg["scored"].mean(),
    }


def build(seasons=None):
    games = pd.read_csv(os.path.join(DATA, "games.csv"))
    team = pd.read_csv(os.path.join(DATA, "team_games.csv"))
    pg = pd.read_csv(os.path.join(DATA, "player_games.csv"))
    if seasons:
        games = games[games.season.isin(seasons)]
        team = team[team.season.isin(seasons)]
        pg = pg[pg.season.isin(seasons)]
    lg = league_rates(pg)
    print(f"league rates: {lg}")

    # Elo replayed alongside, so `elo_margin` is point-in-time too.
    import elo_backtest as E
    by_season, fbs = E.load()
    elo = E.Elo(40, 55, 0.60)  # tuned in elo_backtest.py
    elo_seasons = sorted(by_season)
    # Warm two seasons before the first one we build features for.
    first_feature_season = min(seasons) if seasons else min(elo_seasons)

    games = games.sort_values(["date", "game_id"])
    team_by_game = {g: df for g, df in team.groupby("game_id")}
    pg_by_game = {g: df for g, df in pg.groupby("game_id")}

    # running season-to-date state
    # No per-player `gp`: the live feed cannot see it, so neither can this.
    P = defaultdict(lambda: dict(
        car=0., rec=0., ry=0., cy=0., rtd=0., ctd=0.))
    T = defaultdict(lambda: dict(
        gp=0, car=0., rec=0., rtd=0., ctd=0., dRtd=0., dCtd=0., pts=0., papg=0.))
    # last season's tail, for the early-season top-up
    prev_P, prev_T = {}, {}

    rows = []
    cur_season = None
    for season, sgames in games.groupby("season", sort=True):
        # roll the season: last year's totals become the carry-in pool
        prev_P, prev_T = dict(P), dict(T)
        P.clear(); T.clear()

        # advance Elo through every season up to this one
        if cur_season is None:
            for s in elo_seasons:
                if s >= season:
                    break
                if s > min(elo_seasons):
                    elo.carry_season()
                for g in by_season[s]:
                    if g["home"]["score"] == g["away"]["score"]:
                        continue
                    elo.update(E.team_key(g["home"], fbs), E.team_key(g["away"], fbs),
                               g["home"]["score"], g["away"]["score"], g["neutral"])
            elo.carry_season()
        else:
            elo.carry_season()
        cur_season = season
        elo_games = {g["id"]: g for g in by_season.get(season, [])}

        for _, g in sgames.sort_values(["date", "game_id"]).iterrows():
            gid = int(g.game_id)
            tg = team_by_game.get(gid)
            pgg = pg_by_game.get(gid)
            eg = elo_games.get(gid)
            if tg is None or pgg is None or eg is None or len(tg) != 2:
                continue

            sides = {r.team: r for r in tg.itertuples()}
            names = list(sides)
            if len(names) != 2:
                continue
            hk = E.team_key(eg["home"], fbs)
            ak = E.team_key(eg["away"], fbs)

            for tname in names:
                oname = [n for n in names if n != tname][0]
                side = sides[tname]
                is_home = int(side.is_home)
                mine = T[tname]
                opp = T[oname]
                # Too little this season? Borrow a scaled slice of last season.
                # One fraction is computed for the team and reused for every one
                # of its players, so a team and its roster always describe the
                # same stretch of football.
                frac = carry_fraction(mine, prev_T.get(tname))
                mine_src = blend(mine, prev_T.get(tname), frac)
                opp_src = blend(opp, prev_T.get(oname),
                                carry_fraction(opp, prev_T.get(oname)))
                if mine_src["gp"] < 1 or opp_src["gp"] < 1:
                    continue
                gp = mine_src["gp"]

                # game environment, the stand-in for a market total
                team_ppg = mine_src["pts"] / mine_src["gp"]
                team_papg = mine_src["papg"] / mine_src["gp"]
                opp_ppg = opp_src["pts"] / opp_src["gp"]
                opp_papg = opp_src["papg"] / opp_src["gp"]
                proj_team = (team_ppg + opp_papg) / 2
                proj_opp = (opp_ppg + team_papg) / 2
                my_key, their_key = (hk, ak) if is_home else (ak, hk)
                elo_margin = (elo.rating(my_key) - elo.rating(their_key)
                              + (0 if eg["neutral"] else (55 if is_home else -55))) / 25.0

                for pr in pgg[pgg.team == tname].itertuples():
                    pid = str(pr.player_id)
                    src = blend(P[pid], prev_P.get(pid), frac)
                    if (src["car"] + src["rec"]) < 1:
                        continue
                    rows.append({
                        "season": season, "date": g.date, "game_id": gid,
                        "team": tname, "opp": oname,
                        "player_id": pid, "player": pr.player,
                        "carry_share": src["car"] / mine_src["car"] if mine_src["car"] else 0.,
                        "rec_share": src["rec"] / mine_src["rec"] if mine_src["rec"] else 0.,
                        "cpg": src["car"] / gp,
                        "rpg": src["rec"] / gp,
                        "rush_ypg": src["ry"] / gp,
                        "rec_ypg": src["cy"] / gp,
                        "rush_td_rate": (src["rtd"] + K_RUSH * lg["LG_RUSH"]) / (src["car"] + K_RUSH),
                        "rec_td_rate": (src["ctd"] + K_REC * lg["LG_REC"]) / (src["rec"] + K_REC),
                        # capped at one a game — see THE RULE THIS FILE OBEYS
                        "anytime_rate": (min(src["rtd"] + src["ctd"], gp) + K_ANY * lg["LG_ANY"])
                                        / (gp + K_ANY),
                        "gp": min(gp, 15),
                        "team_rush_tdpg": mine_src["rtd"] / gp,
                        "team_rec_tdpg": mine_src["ctd"] / gp,
                        "opp_rush_td_allowed_pg": opp_src["dRtd"] / opp_src["gp"],
                        "opp_rec_td_allowed_pg": opp_src["dCtd"] / opp_src["gp"],
                        "is_home": is_home,
                        "proj_team_pts": proj_team,
                        "proj_total": proj_team + proj_opp,
                        "elo_margin": elo_margin,
                        "carried": int(frac > 0),
                        "carried_games": gp - mine["gp"],
                        "scored": int(pr.scored),
                    })

            # --- now the game is in the past: fold it into the running state
            for tname in names:
                oname = [n for n in names if n != tname][0]
                side, other = sides[tname], sides[oname]
                t = T[tname]
                t["gp"] += 1
                t["rtd"] += side.rush_td
                t["ctd"] += side.rec_td
                t["dRtd"] += other.rush_td
                t["dCtd"] += other.rec_td
                t["pts"] += side.points
                t["papg"] += side.opp_points
                for pr in pgg[pgg.team == tname].itertuples():
                    a = P[str(pr.player_id)]
                    a["car"] += pr.car
                    a["rec"] += pr.rec
                    a["ry"] += pr.rush_yds
                    a["cy"] += pr.rec_yds
                    a["rtd"] += pr.rush_td
                    a["ctd"] += pr.rec_td
                    t["car"] += pr.car
                    t["rec"] += pr.rec

            if eg["home"]["score"] != eg["away"]["score"]:
                elo.update(hk, ak, eg["home"]["score"], eg["away"]["score"], eg["neutral"])

    df = pd.DataFrame(rows)
    print(f"built {len(df):,} rows, {df.scored.mean()*100:.1f}% scored")
    return df, lg


def carry_fraction(team_cur, team_prev):
    """How much of last season a team still needs in order to be readable.

    Week 1 has nothing at all to read, and a board that goes blank on the
    biggest Saturday of the year is not a board. So a team short of
    USAGE_WINDOW games borrows the shortfall from last season, scaled: three
    games in, it takes two games' worth of last year, not all thirteen. The
    borrowed share shrinks weekly and is gone by week five, where this season
    can stand on its own.

    The fraction belongs to the team, not the player, because the whole roster
    has to describe the same stretch of football — otherwise a player's share
    of team carries is a share of a different season's offence.
    """
    if not team_prev or team_prev["gp"] < 1:
        return 0.0
    need = USAGE_WINDOW - team_cur["gp"]
    return min(1.0, need / team_prev["gp"]) if need > 0 else 0.0


def blend(cur, prev, frac):
    """This season's totals plus `frac` of last season's."""
    if frac <= 0 or not prev:
        return dict(cur)
    return {k: cur[k] + prev.get(k, 0) * frac for k in cur}


if __name__ == "__main__":
    df, lg = build()
    df.to_csv(os.path.join(DATA, "features.csv"), index=False)
    json.dump(lg, open(os.path.join(DATA, "league_rates.json"), "w"), indent=1)
    print("wrote data/features.csv")
