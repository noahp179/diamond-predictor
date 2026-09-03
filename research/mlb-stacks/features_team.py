"""
Leak-free features for the team run-scoring model.

Same discipline as research/mlb-props/features.py: a strictly chronological
walk, so a row for game G only ever sees box scores from games that had already
finished, and every feature is one the live TypeScript pipeline can rebuild from
StatsAPI aggregate endpoints:

  team offence season-to-date   <- /teams/stats?stats=season&group=hitting
  team offence last 30 days     <- /teams/stats?stats=byDateRange&group=hitting
  opponent runs allowed         <- /teams/stats?stats=season&group=pitching
  opposing starter              <- /people?hydrate=stats(season,pitching)
  opponent bullpen              <- team pitching minus its starters
  slate / venue / probables     <- /schedule?hydrate=probablePitcher

Inputs:
  data/team_games.csv                  (fetch_teams.py)
  ../mlb-props/data/batter_games.csv   (mlb-props/fetch_props.py)
  ../mlb-props/data/pitcher_games.csv  (mlb-props/fetch_props.py)

Output:
  data/team_features.csv  - one row per team-game, features + runs + markets
"""

import os
import sys
from collections import defaultdict, deque

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS_DATA = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
from features import PARK_FACTORS, shrunk  # noqa: E402  (shared, single source)

WINDOW_DAYS = 30

# League priors for shrinkage. Team run rate is per game; the rest match the
# per-PA / per-BF priors the player-prop models use.
LG = {
    "r_pg": 4.42,
    "tb_pa": 0.350, "h_pa": 0.216, "hr_pa": 0.032, "bb_pa": 0.085, "k_pa": 0.223,
    "p_k_bf": 0.223, "p_h_bf": 0.216, "p_bb_bf": 0.085, "p_hr_bf": 0.032,
    "p_er_out": 0.163,   # 4.40 ERA over 27 outs
}
K_G = 20.0      # team per-game run rates (games)
K_PA = 1500.0   # team per-PA rates (~40 games of team PA)
K_BF = 300.0    # starting pitcher per-BF rates
K_OUT = 250.0   # bullpen per-out rates

# The markets. A "team total" line is offered at 3.5 / 4.5 / 5.5 runs, so the
# over is exactly runs >= 4 / 5 / 6.
TEAM_MARKETS = {
    "r4": (lambda r: int(r >= 4), 0.55),
    "r5": (lambda r: int(r >= 5), 0.42),
    "r6": (lambda r: int(r >= 6), 0.31),
}

TEAM_FEATURES = [
    # own offence, season to date
    "r_pg", "tb_pa", "h_pa", "hr_pa", "bb_pa", "k_pa", "iso",
    # own offence, trailing 30 days
    "w_r_pg", "w_tb_pa", "w_g",
    # own offence, prior season
    "py_r_pg", "py_tb_pa", "py_known",
    # opponent run prevention
    "opp_ra_pg", "opp_w_ra_pg", "opp_py_ra_pg",
    # opposing starter
    "sp_k_bf", "sp_h_bf", "sp_hr_bf", "sp_bb_bf", "sp_er_out", "sp_bf_start",
    "sp_known",
    # opponent bullpen (what the other ~12 outs look like)
    "pen_er_out", "pen_k_bf", "pen_known",
    # context
    "park", "is_home", "rest_days", "g7",
]


class Window:
    """Trailing-N-day sums, matching a StatsAPI byDateRange pull."""

    def __init__(self, keys):
        self.keys = keys
        self.q = deque()
        self.tot = dict.fromkeys(keys, 0.0)
        self.g = 0

    def prune(self, day):
        cutoff = day - WINDOW_DAYS
        while self.q and self.q[0][0] < cutoff:
            _, rec = self.q.popleft()
            for k in self.keys:
                self.tot[k] -= rec[k]
            self.g -= 1

    def add(self, day, rec):
        self.q.append((day, rec))
        for k in self.keys:
            self.tot[k] += rec[k]
        self.g += 1


def day_num(dates):
    d = pd.to_datetime(dates)
    return ((d - pd.Timestamp("2024-01-01")).dt.days).astype(int)


def park(venue):
    return PARK_FACTORS.get(venue, 100) / 100.0


BAT_KEYS = ["pa", "ab", "h", "tb", "hr", "bb", "k", "r", "g"]


def build():
    tg = pd.read_csv(os.path.join(DATA, "team_games.csv"))
    bg = pd.read_csv(os.path.join(PROPS_DATA, "batter_games.csv"))
    pg = pd.read_csv(os.path.join(PROPS_DATA, "pitcher_games.csv"))

    tg["day"] = day_num(tg.date)
    tg = tg.sort_values(["day", "gamePk", "is_home"]).reset_index(drop=True)

    # team-game batting totals (every batter, bench included — that is what the
    # team season line on StatsAPI reports)
    bat = (
        bg.groupby(["gamePk", "team_id"])[["pa", "ab", "h", "tb", "hr", "bb", "k"]]
        .sum()
        .to_dict("index")
    )
    # team-game pitching totals, split starter / bullpen
    pg["is_starter"] = pg.is_starter.astype(int)
    pit_team = (
        pg[pg.is_starter == 0]
        .groupby(["gamePk", "team_id"])[["bf", "outs", "er", "k"]]
        .sum()
        .to_dict("index")
    )
    pit_by_game = {g: d for g, d in pg.groupby("gamePk")}

    # prior-season team lines
    py_runs = tg.groupby(["season", "team_id"]).runs.agg(["sum", "count"])
    py_bat = bg.groupby(["season", "team_id"])[["pa", "tb"]].sum()
    py_allowed = tg.groupby(["season", "team_id"]).opp_runs.agg(["sum", "count"])
    py_map = {}
    for (s, t), row in py_runs.iterrows():
        nxt = (s + 1, t)
        b = py_bat.loc[(s, t)] if (s, t) in py_bat.index else None
        a = py_allowed.loc[(s, t)]
        py_map[nxt] = dict(
            r_pg=row["sum"] / max(row["count"], 1),
            ra_pg=a["sum"] / max(a["count"], 1),
            tb_pa=(b["tb"] / b["pa"]) if b is not None and b["pa"] else LG["tb_pa"],
        )

    T = defaultdict(lambda: dict.fromkeys(BAT_KEYS + ["ra"], 0.0))
    W = defaultdict(lambda: Window(BAT_KEYS + ["ra"]))
    PEN = defaultdict(lambda: dict(bf=0.0, outs=0.0, er=0.0, k=0.0))
    SP = defaultdict(lambda: dict(bf=0.0, k=0.0, h=0.0, bb=0.0, hr=0.0, er=0.0,
                                  outs=0.0, gs=0.0))
    LAST = {}                      # team -> day of previous game
    RECENT = defaultdict(deque)    # team -> days of recent games

    rows = []
    for gpk, gdf in tg.groupby("gamePk", sort=False):
        day = int(gdf.day.iloc[0])
        season = int(gdf.season.iloc[0])
        pf = park(gdf.venue.iloc[0])

        # ---- emit one row per team, from pre-game state only ----
        for r in gdf.itertuples():
            key, okey = (season, r.team_id), (season, r.opp_team)
            t, o = T[key], T[okey]
            w, ow = W[key], W[okey]
            w.prune(day)
            ow.prune(day)
            if t["g"] < 1 or o["g"] < 1:
                continue
            sp = SP.get(r.opp_sp) if r.opp_sp == r.opp_sp else None
            spk = sp is not None and sp["bf"] >= 1
            pen = PEN[okey]
            penk = pen["outs"] >= 1
            py = py_map.get((season, r.team_id))
            pyo = py_map.get((season, r.opp_team))

            recent = RECENT[r.team_id]
            while recent and recent[0] < day - 7:
                recent.popleft()

            feat = {
                "r_pg": shrunk(t["r"], t["g"], LG["r_pg"], K_G),
                "tb_pa": shrunk(t["tb"], t["pa"], LG["tb_pa"], K_PA),
                "h_pa": shrunk(t["h"], t["pa"], LG["h_pa"], K_PA),
                "hr_pa": shrunk(t["hr"], t["pa"], LG["hr_pa"], K_PA),
                "bb_pa": shrunk(t["bb"], t["pa"], LG["bb_pa"], K_PA),
                "k_pa": shrunk(t["k"], t["pa"], LG["k_pa"], K_PA),
                "iso": shrunk(t["tb"] - t["h"], t["ab"], 0.150, K_PA),
                "w_r_pg": shrunk(w.tot["r"], w.g, LG["r_pg"], 8),
                "w_tb_pa": shrunk(w.tot["tb"], w.tot["pa"], LG["tb_pa"], 400),
                "w_g": min(w.g, 30),
                "py_r_pg": py["r_pg"] if py else LG["r_pg"],
                "py_tb_pa": py["tb_pa"] if py else LG["tb_pa"],
                "py_known": 1.0 if py else 0.0,
                "opp_ra_pg": shrunk(o["ra"], o["g"], LG["r_pg"], K_G),
                "opp_w_ra_pg": shrunk(ow.tot["ra"], ow.g, LG["r_pg"], 8),
                "opp_py_ra_pg": pyo["ra_pg"] if pyo else LG["r_pg"],
                "sp_k_bf": shrunk(sp["k"], sp["bf"], LG["p_k_bf"], K_BF) if spk else LG["p_k_bf"],
                "sp_h_bf": shrunk(sp["h"], sp["bf"], LG["p_h_bf"], K_BF) if spk else LG["p_h_bf"],
                "sp_hr_bf": shrunk(sp["hr"], sp["bf"], LG["p_hr_bf"], K_BF) if spk else LG["p_hr_bf"],
                "sp_bb_bf": shrunk(sp["bb"], sp["bf"], LG["p_bb_bf"], K_BF) if spk else LG["p_bb_bf"],
                "sp_er_out": shrunk(sp["er"], sp["outs"], LG["p_er_out"], K_OUT) if spk else LG["p_er_out"],
                "sp_bf_start": (sp["bf"] / sp["gs"]) if spk and sp["gs"] else 21.0,
                "sp_known": 1.0 if spk else 0.0,
                "pen_er_out": shrunk(pen["er"], pen["outs"], LG["p_er_out"], K_OUT) if penk else LG["p_er_out"],
                "pen_k_bf": shrunk(pen["k"], pen["bf"], LG["p_k_bf"], K_BF) if penk else LG["p_k_bf"],
                "pen_known": 1.0 if penk else 0.0,
                "park": pf,
                "is_home": r.is_home,
                "rest_days": min(day - LAST.get(r.team_id, day - 1), 6),
                "g7": len(recent),
            }
            for m, (fn, _) in TEAM_MARKETS.items():
                feat[f"y_{m}"] = fn(r.runs)
            feat.update(
                gamePk=gpk, date=r.date, season=season, team_id=r.team_id,
                team=r.team, opp_team=r.opp_team, opp_sp=r.opp_sp,
                runs=r.runs, opp_runs=r.opp_runs, venue=gdf.venue.iloc[0],
            )
            rows.append(feat)

        # ---- fold this game into the running state ----
        for r in gdf.itertuples():
            key = (season, r.team_id)
            b = bat.get((gpk, r.team_id), {})
            rec = {k: float(b.get(k, 0.0)) for k in ("pa", "ab", "h", "tb", "hr", "bb", "k")}
            rec["r"] = float(r.runs)
            rec["ra"] = float(r.opp_runs)
            rec["g"] = 1.0
            for k in BAT_KEYS + ["ra"]:
                T[key][k] += rec[k]
            W[key].add(day, rec)

            pt = pit_team.get((gpk, r.team_id))
            if pt:
                p = PEN[key]
                p["bf"] += pt["bf"]; p["outs"] += pt["outs"]
                p["er"] += pt["er"]; p["k"] += pt["k"]

            LAST[r.team_id] = day
            RECENT[r.team_id].append(day)

        # Every appearance goes into the pitcher's line, and only starts count
        # as starts — that is exactly what /people?hydrate=stats(season) returns
        # live, so the feature the app computes is the feature fitted here.
        pdf = pit_by_game.get(gpk)
        if pdf is not None:
            for r in pdf.itertuples():
                s = SP[r.pitcher_id]
                s["bf"] += r.bf; s["k"] += r.k; s["h"] += r.h_allowed
                s["bb"] += r.bb_allowed; s["hr"] += r.hr_allowed; s["er"] += r.er
                s["outs"] += r.outs; s["gs"] += int(r.is_starter)

    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(DATA, "team_features.csv"), index=False)
    print(f"team rows: {len(df):,}")
    print(df.groupby("season").agg(n=("runs", "size"), runs=("runs", "mean"),
                                   r5=("y_r5", "mean")))
    return df


if __name__ == "__main__":
    build()
