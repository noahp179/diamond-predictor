"""
Candidate features for a dedicated 2+ total-bases model.

The Player Props model already prices 2+ TB as one of sixteen markets, from 34
features. This asks a narrower question — what else, in the data this repo
*already downloads*, moves the needle on this one market?

Seven blocks are built here, none of which the shipped model has. Each was
picked because there is a mechanism, not because it was available:

  pen      the opposing bullpen. A starter is ~15 of 27 outs; roughly two of a
           hitter's four plate appearances come against relievers, and the
           shipped model cannot see them at all.
  def      the opponent's total bases allowed per plate appearance — team
           defence and pitching staff in one number, rather than runs allowed.
  parktb   an empirical park index for *total bases* rather than runs. Coors
           and Fenway inflate doubles far more than they inflate runs.
  weather  temperature, wind speed and direction, roof. Balls carry in warm
           air and die into the wind; this is the classic "obvious" edge.
  known    the part of the weather a bettor actually knows before first pitch.
           StatsAPI publishes `weather` only once a game is under way — it is
           {} for every scheduled game — so the live app can never see the
           `weather` block above. This block is its servable stand-in: the
           park's own average temperature for this month of the year, whether
           the roof is closed, and whether it is a day game. All three are
           knowable from the schedule alone, which is the only reason they are
           allowed to ship.
  ump      the home-plate umpire's total-bases index. Wide zones mean deeper
           counts and better contact.
  form15   a 15-day window, half the length of the shipped 30-day one, for
           hitters who got hot last week.
  rest     days since the hitter's last game, and games in the last seven.

Everything is built by a strictly chronological walk: a row for game G only
ever sees games that finished before G, and every index is shrunk to the
league average so a park with 200 plate appearances behind it does not swing
a projection.

Input:  ../mlb-props/data/{batter_games,pitcher_games,game_context}.csv
Output: data/extra_features.csv — keyed (gamePk, batter_id), merged onto the
        shipped feature table by bakeoff_tb2.py.
"""

import os
from collections import defaultdict, deque

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
os.makedirs(DATA, exist_ok=True)

LG_TB_PA = 0.350
LG_ER_OUT = 0.163
LG_K_BF = 0.223
LG_H_BF = 0.216
LG_HR_BF = 0.032
LG_XBH_PA = 0.082
K_BF = 300.0      # bullpen per-batter-faced rates
K_OUT = 250.0     # bullpen per-out rates
K_DEF = 4000.0    # team defence per-PA rates (a team faces ~38 PA a game)
K_PARK = 8000.0   # park index (~2 seasons of one park)
K_UMP = 3000.0    # umpire index
WINDOW15 = 15

EXTRA_BLOCKS = {
    "pen": ["pen_er_out", "pen_k_bf", "pen_h_bf", "pen_hr_bf", "pen_known"],
    "def": ["def_tb_pa", "def_xbh_pa", "def_known"],
    "parktb": ["park_tb"],
    "weather": ["temp", "wind_mph", "wind_out", "wind_in", "is_dome", "is_day"],
    "known": ["temp_norm", "is_dome", "is_day"],
    "ump": ["ump_tb"],
    "form15": ["w15_tb_pa", "w15_h_pa", "w15_pa_pg", "w15_g", "own15_tb2"],
    "rest": ["bat_rest", "bat_g7"],
}
EXTRA_FEATURES = list(dict.fromkeys(f for b in EXTRA_BLOCKS.values() for f in b))


def shrunk(num, den, prior, k):
    return (num + k * prior) / (den + k)


def day_num(dates):
    d = pd.to_datetime(dates)
    return ((d - pd.Timestamp("2024-01-01")).dt.days).astype(int)


class Window:
    """Trailing-N-day sums."""

    def __init__(self, keys, days):
        self.keys, self.days = keys, days
        self.q = deque()
        self.tot = dict.fromkeys(keys, 0.0)
        self.g = 0

    def prune(self, day):
        while self.q and self.q[0][0] < day - self.days:
            _, rec = self.q.popleft()
            for k in self.keys:
                self.tot[k] -= rec[k]
            self.g -= 1

    def add(self, day, rec):
        self.q.append((day, rec))
        for k in self.keys:
            self.tot[k] += rec[k]
        self.g += 1


def parse_wind(row):
    """'Out To CF' blows balls out; 'In From LF' knocks them down."""
    d = str(row.wind_dir or "")
    mph = float(row.wind_mph or 0)
    out = mph if d.startswith("Out To") else 0.0
    inn = mph if d.startswith("In From") else 0.0
    return out, inn


def build():
    bg = pd.read_csv(os.path.join(PROPS, "batter_games.csv"))
    pg = pd.read_csv(os.path.join(PROPS, "pitcher_games.csv"))
    ctx = pd.read_csv(os.path.join(PROPS, "game_context.csv"))

    bg["day"] = day_num(bg.date)
    bg = bg.sort_values(["day", "gamePk"]).reset_index(drop=True)
    bg["xbh"] = bg.d2 + bg.d3 + bg.hr
    bg["y_tb2"] = (bg.tb >= 2).astype(int)

    ctx = ctx.set_index("gamePk")
    ctx_temp = ctx.temp.to_dict()
    ctx_wind = {r.Index: parse_wind(r) for r in ctx.itertuples()}
    ctx_cond = ctx.condition.to_dict()
    ctx_dn = ctx.day_night.to_dict()
    ctx_ump = ctx.hp_umpire.to_dict()
    league_temp = float(ctx.temp.replace(0, np.nan).mean())

    pen_by_game = {
        g: d for g, d in pg[pg.is_starter == 0].groupby("gamePk")
    }

    PEN = defaultdict(lambda: dict(bf=0.0, outs=0.0, er=0.0, k=0.0, h=0.0, hr=0.0))
    DEF = defaultdict(lambda: dict(tb=0.0, pa=0.0, xbh=0.0))
    PARK = defaultdict(lambda: dict(tb=0.0, pa=0.0))
    PARKMONTH = defaultdict(lambda: dict(t=0.0, n=0.0))   # (venue, month) -> temps
    PARKTEMP = defaultdict(lambda: dict(t=0.0, n=0.0))    # venue -> temps
    UMP = defaultdict(lambda: dict(tb=0.0, pa=0.0))
    LEAGUE = dict(tb=0.0, pa=0.0)
    W15 = defaultdict(lambda: Window(["pa", "h", "tb", "g", "g_tb2"], WINDOW15))
    LAST = {}
    RECENT = defaultdict(deque)

    rows = []
    for gpk, gdf in bg.groupby("gamePk", sort=False):
        day = int(gdf.day.iloc[0])
        season = int(gdf.season.iloc[0])
        venue = gdf.venue.iloc[0]

        lg_tb_pa = (LEAGUE["tb"] / LEAGUE["pa"]) if LEAGUE["pa"] > 20000 else LG_TB_PA
        # Shrunk to the league rate, so a park with no history sits at exactly 1.0
        # and one with two seasons behind it is trusted about half way.
        pk = PARK[venue]
        park_tb = ((pk["tb"] + K_PARK * lg_tb_pa) / (pk["pa"] + K_PARK)) / lg_tb_pa

        ump = ctx_ump.get(gpk)
        u = UMP[ump] if ump else None
        ump_tb = (((u["tb"] + K_UMP * lg_tb_pa) / (u["pa"] + K_UMP)) / lg_tb_pa) if u else 1.0

        temp = ctx_temp.get(gpk, league_temp)
        if not temp or temp <= 0:
            temp = league_temp
        w_out, w_in = ctx_wind.get(gpk, (0.0, 0.0))
        cond = str(ctx_cond.get(gpk, ""))
        is_dome = 1.0 if cond in ("Dome", "Roof Closed") else 0.0
        is_day = 1.0 if str(ctx_dn.get(gpk, "")) == "day" else 0.0
        # The servable stand-in for temperature: what this park has averaged in
        # this month of the year, backed off to the park's own average and then
        # to the league. Known from the schedule; no forecast required.
        month = int(str(gdf.date.iloc[0])[5:7])
        pm, pt = PARKMONTH[(venue, month)], PARKTEMP[venue]
        temp_norm = ((pm["t"] + 6 * ((pt["t"] + 30 * league_temp) / (pt["n"] + 30)))
                     / (pm["n"] + 6))

        for r in gdf.itertuples():
            if not (1 <= r.slot <= 9):
                continue
            w = W15[r.batter_id]
            w.prune(day)
            pen = PEN[(season, r.opp_team)]
            dfn = DEF[(season, r.opp_team)]
            recent = RECENT[r.batter_id]
            while recent and recent[0] < day - 7:
                recent.popleft()
            penk = pen["outs"] >= 1
            defk = dfn["pa"] >= 1
            wp = w.tot["pa"]

            rows.append(dict(
                gamePk=gpk,
                batter_id=r.batter_id,
                pen_er_out=shrunk(pen["er"], pen["outs"], LG_ER_OUT, K_OUT) if penk else LG_ER_OUT,
                pen_k_bf=shrunk(pen["k"], pen["bf"], LG_K_BF, K_BF) if penk else LG_K_BF,
                pen_h_bf=shrunk(pen["h"], pen["bf"], LG_H_BF, K_BF) if penk else LG_H_BF,
                pen_hr_bf=shrunk(pen["hr"], pen["bf"], LG_HR_BF, K_BF) if penk else LG_HR_BF,
                pen_known=1.0 if penk else 0.0,
                def_tb_pa=shrunk(dfn["tb"], dfn["pa"], LG_TB_PA, K_DEF) if defk else LG_TB_PA,
                def_xbh_pa=shrunk(dfn["xbh"], dfn["pa"], LG_XBH_PA, K_DEF) if defk else LG_XBH_PA,
                def_known=1.0 if defk else 0.0,
                park_tb=park_tb,
                temp=temp,
                wind_mph=float(w_out + w_in),
                wind_out=w_out,
                wind_in=w_in,
                is_dome=is_dome,
                is_day=is_day,
                temp_norm=temp_norm,
                ump_tb=ump_tb,
                w15_tb_pa=shrunk(w.tot["tb"], wp, LG_TB_PA, 40),
                w15_h_pa=shrunk(w.tot["h"], wp, 0.216, 40),
                w15_pa_pg=(wp / w.g) if w.g else 3.9,
                w15_g=min(w.g, 15),
                own15_tb2=shrunk(w.tot["g_tb2"], w.g, 0.36, 6),
                bat_rest=min(day - LAST.get(r.batter_id, day - 1), 6),
                bat_g7=len(recent),
            ))

        # ---- fold the finished game into every running total ----
        by_team = gdf.groupby("team_id")[["tb", "pa", "xbh"]].sum()
        for tid, tot in by_team.iterrows():
            opp = [t for t in by_team.index if t != tid]
            if opp:
                d = DEF[(season, opp[0])]
                d["tb"] += tot.tb
                d["pa"] += tot.pa
                d["xbh"] += tot.xbh
        gtb, gpa = float(gdf.tb.sum()), float(gdf.pa.sum())
        if temp and temp > 0:
            PARKMONTH[(venue, month)]["t"] += temp
            PARKMONTH[(venue, month)]["n"] += 1
            PARKTEMP[venue]["t"] += temp
            PARKTEMP[venue]["n"] += 1
        PARK[venue]["tb"] += gtb
        PARK[venue]["pa"] += gpa
        LEAGUE["tb"] += gtb
        LEAGUE["pa"] += gpa
        if ump:
            UMP[ump]["tb"] += gtb
            UMP[ump]["pa"] += gpa

        pdf = pen_by_game.get(gpk)
        if pdf is not None:
            for p in pdf.itertuples():
                s = PEN[(season, p.team_id)]
                s["bf"] += p.bf
                s["outs"] += p.outs
                s["er"] += p.er
                s["k"] += p.k
                s["h"] += p.h_allowed
                s["hr"] += p.hr_allowed

        for r in gdf.itertuples():
            W15[r.batter_id].add(day, {
                "pa": r.pa, "h": r.h, "tb": r.tb, "g": 1, "g_tb2": r.y_tb2,
            })
            LAST[r.batter_id] = day
            RECENT[r.batter_id].append(day)

    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(DATA, "extra_features.csv"), index=False)
    print(f"extra rows: {len(df):,}  columns: {len(EXTRA_FEATURES)}")
    print(df[EXTRA_FEATURES].describe().T[["mean", "std", "min", "max"]].round(3).to_string())
    return df


if __name__ == "__main__":
    build()
