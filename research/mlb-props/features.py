"""
Leak-free feature construction for the MLB player-prop models.

Every feature is built from a strictly chronological walk over completed games,
so a row for game G only ever sees box scores from games that finished before G.
Just as important, every feature is one the live TypeScript pipeline can pull
from MLB StatsAPI aggregate endpoints in a handful of calls, so training and
serving compute the *same* numbers:

  season-to-date rates   <- /stats?stats=season&group=hitting|pitching
  last-30-day rates      <- /stats?stats=byDateRange&startDate=..&endDate=..
  prior-season rates     <- /stats?stats=season&season=<Y-1>
  team offense/defense   <- /teams/stats?stats=season&group=hitting|pitching
  lineup slot / starter  <- /schedule?hydrate=lineups,probablePitcher
  park factor            <- static table (shared with src/lib/park-factors.ts)

Batter rows are starters only (lineup slots 1-9) — that is what props are
offered on and what the app can see from a posted lineup. Pitcher rows are
starting pitchers only.
"""

import os
from collections import defaultdict, deque

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# Park run index, 100 = league average. Mirrors src/lib/park-factors.ts.
PARK_FACTORS = {
    "Coors Field": 112, "Fenway Park": 106, "Great American Ball Park": 105,
    "Globe Life Field": 104, "Yankee Stadium": 103, "Wrigley Field": 102,
    "Citizens Bank Park": 102, "Chase Field": 102, "Truist Park": 101,
    "Rogers Centre": 101, "Kauffman Stadium": 101, "Minute Maid Park": 100,
    "Daikin Park": 100, "Nationals Park": 100, "Target Field": 100,
    "American Family Field": 100, "loanDepot park": 99, "Citi Field": 99,
    "Progressive Field": 99, "Comerica Park": 98, "PNC Park": 98,
    "Angel Stadium": 98, "Busch Stadium": 97, "Dodger Stadium": 97,
    "Oracle Park": 95, "T-Mobile Park": 95, "Petco Park": 95,
    "Oakland Coliseum": 95, "Sutter Health Park": 100, "Tropicana Field": 96,
    "George M. Steinbrenner Field": 100, "Steinbrenner Field": 100,
    "Camden Yards": 99, "Oriole Park at Camden Yards": 99,
    "Guaranteed Rate Field": 101, "Rate Field": 101,
}

# League priors used for shrinkage (per plate appearance / per batter faced).
LG = {
    "h_pa": 0.216, "tb_pa": 0.350, "hr_pa": 0.032, "rbi_pa": 0.104,
    "r_pa": 0.108, "bb_pa": 0.085, "k_pa": 0.223, "sb_pa": 0.013,
    "p_k_bf": 0.223, "p_h_bf": 0.216, "p_bb_bf": 0.085, "p_hr_bf": 0.032,
}
K_PA = 250.0    # shrinkage weight for batter per-PA rates
K_BF = 300.0    # shrinkage weight for pitcher per-BF rates
K_G = 25.0      # shrinkage weight for per-game (prop hit) rates
WINDOW_DAYS = 30

# Binary prop markets. name -> (row -> outcome, league per-game base rate prior)
# NB: "1+ total bases" is the same event as "1+ hits" (every total base comes
# from a hit), so the ladder starts at 2+ on the total-bases side.
BATTER_MARKETS = {
    "h1": (lambda r: int(r.h >= 1), 0.62),
    "h2": (lambda r: int(r.h >= 2), 0.23),
    "h3": (lambda r: int(r.h >= 3), 0.047),
    "h4": (lambda r: int(r.h >= 4), 0.006),
    "tb2": (lambda r: int(r.tb >= 2), 0.36),
    "tb3": (lambda r: int(r.tb >= 3), 0.21),
    "tb4": (lambda r: int(r.tb >= 4), 0.145),
    "tb5": (lambda r: int(r.tb >= 5), 0.07),
    "hr1": (lambda r: int(r.hr >= 1), 0.12),
    "rbi1": (lambda r: int(r.rbi >= 1), 0.33),
    "r1": (lambda r: int(r.r >= 1), 0.35),
    "sb1": (lambda r: int(r.sb >= 1), 0.05),
}
PITCHER_MARKETS = {
    "k5": (lambda r: int(r.k >= 5), 0.50),
    "k6": (lambda r: int(r.k >= 6), 0.35),
    "k7": (lambda r: int(r.k >= 7), 0.22),
    "outs16": (lambda r: int(r.outs >= 16), 0.45),  # 5.1+ innings
}


def shrunk(num, den, prior, k):
    return (num + k * prior) / (den + k)


def park(venue):
    return PARK_FACTORS.get(venue, 100) / 100.0


# --------------------------------------------------------------------------- #
# rolling window helper: totals over the trailing WINDOW_DAYS calendar days
# --------------------------------------------------------------------------- #
class Window:
    """Trailing-N-day sums of a stat dict, matching StatsAPI byDateRange."""

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


# --------------------------------------------------------------------------- #
# batters
# --------------------------------------------------------------------------- #
BAT_KEYS = (["pa", "ab", "h", "tb", "hr", "rbi", "r", "sb", "bb", "k", "g"]
            + [f"g_{m}" for m in BATTER_MARKETS])

BATTER_FEATURES = [
    # season-to-date skill
    "h_pa", "tb_pa", "hr_pa", "rbi_pa", "r_pa", "bb_pa", "k_pa", "sb_pa", "iso",
    # trailing 30 days
    "w_h_pa", "w_tb_pa", "w_hr_pa", "w_pa_pg", "w_g",
    # prior season
    "py_h_pa", "py_tb_pa", "py_hr_pa", "py_pa", "py_known",
    # opportunity / context
    "slot", "pa_pg", "gp", "is_home", "park",
    # team + opponent
    "team_r_pg", "opp_r_allowed_pg",
    # opposing starter (season-to-date, shrunk)
    "sp_k_bf", "sp_h_bf", "sp_hr_bf", "sp_bb_bf", "sp_bf_start", "sp_known",
]
# Per-market "own rate" features appended to the generic block (a player's own
# shrunk per-game hit rate for THIS market, season and trailing 30 days).
OWN = ["own_rate", "own_w_rate"]


def build_batters():
    bg = pd.read_csv(os.path.join(DATA, "batter_games.csv"))
    pg = pd.read_csv(os.path.join(DATA, "pitcher_games.csv"))
    bg = bg.copy()
    bg["day"] = day_num(bg.date)
    pg["day"] = day_num(pg.date)
    bg = bg.sort_values(["day", "gamePk"]).reset_index(drop=True)

    for m, (fn, _) in BATTER_MARKETS.items():
        bg[f"y_{m}"] = [fn(r) for r in bg.itertuples()]

    # prior-season totals per batter
    py = (bg.groupby(["season", "batter_id"])[["pa", "h", "tb", "hr"]].sum()
          .reset_index())
    py_map = {(int(r.season) + 1, int(r.batter_id)): r for r in py.itertuples()}

    # pitcher season-to-date state (for the opposing starter's features)
    P = defaultdict(lambda: dict(bf=0.0, k=0.0, h=0.0, bb=0.0, hr=0.0, gs=0.0))
    pit_by_game = {g: d for g, d in pg.groupby("gamePk")}

    # team season-to-date runs scored / allowed
    T = defaultdict(lambda: dict(g=0.0, r=0.0, ra=0.0))

    B = defaultdict(lambda: dict.fromkeys(BAT_KEYS, 0.0))
    W = defaultdict(lambda: Window(BAT_KEYS))

    rows = []
    for gpk, gdf in bg.groupby("gamePk", sort=False):
        day = int(gdf.day.iloc[0])
        season = int(gdf.season.iloc[0])
        venue = gdf.venue.iloc[0]
        pf = park(venue)

        # ---- emit features for every starter in this game (pre-game state) ----
        # Cumulative state below counts every appearance (bench bats included),
        # matching what a player's StatsAPI game log returns live; only lineup
        # starters get a row, because those are the ones props are offered on.
        for r in gdf.itertuples():
            if not (1 <= r.slot <= 9):
                continue
            b = B[r.batter_id]
            w = W[r.batter_id]
            w.prune(day)
            sp = P.get(r.opp_sp) if r.opp_sp == r.opp_sp else None  # NaN-safe
            t = T[(season, r.team_id)]
            o = T[(season, r.opp_team)]
            if b["g"] < 1 or t["g"] < 1 or o["g"] < 1:
                continue

            pa, g = b["pa"], b["g"]
            wp, wg = w.tot["pa"], max(w.g, 0)
            pyr = py_map.get((season, int(r.batter_id)))
            spk = sp is not None and sp["bf"] >= 1

            feat = {
                "h_pa": shrunk(b["h"], pa, LG["h_pa"], K_PA),
                "tb_pa": shrunk(b["tb"], pa, LG["tb_pa"], K_PA),
                "hr_pa": shrunk(b["hr"], pa, LG["hr_pa"], K_PA),
                "rbi_pa": shrunk(b["rbi"], pa, LG["rbi_pa"], K_PA),
                "r_pa": shrunk(b["r"], pa, LG["r_pa"], K_PA),
                "bb_pa": shrunk(b["bb"], pa, LG["bb_pa"], K_PA),
                "k_pa": shrunk(b["k"], pa, LG["k_pa"], K_PA),
                "sb_pa": shrunk(b["sb"], pa, LG["sb_pa"], K_PA),
                "iso": shrunk(b["tb"] - b["h"], b["ab"], 0.145, K_PA),
                "w_h_pa": shrunk(w.tot["h"], wp, LG["h_pa"], 80),
                "w_tb_pa": shrunk(w.tot["tb"], wp, LG["tb_pa"], 80),
                "w_hr_pa": shrunk(w.tot["hr"], wp, LG["hr_pa"], 80),
                "w_pa_pg": wp / wg if wg else 3.9,
                "w_g": min(wg, 30),
                "py_h_pa": shrunk(pyr.h, pyr.pa, LG["h_pa"], K_PA) if pyr is not None else LG["h_pa"],
                "py_tb_pa": shrunk(pyr.tb, pyr.pa, LG["tb_pa"], K_PA) if pyr is not None else LG["tb_pa"],
                "py_hr_pa": shrunk(pyr.hr, pyr.pa, LG["hr_pa"], K_PA) if pyr is not None else LG["hr_pa"],
                "py_pa": min(pyr.pa, 700) if pyr is not None else 0.0,
                "py_known": 1.0 if pyr is not None else 0.0,
                "slot": r.slot,
                "pa_pg": pa / g,
                "gp": min(g, 162),
                "is_home": r.is_home,
                "park": pf,
                "team_r_pg": t["r"] / t["g"],
                "opp_r_allowed_pg": o["ra"] / o["g"],
                "sp_k_bf": shrunk(sp["k"], sp["bf"], LG["p_k_bf"], K_BF) if spk else LG["p_k_bf"],
                "sp_h_bf": shrunk(sp["h"], sp["bf"], LG["p_h_bf"], K_BF) if spk else LG["p_h_bf"],
                "sp_hr_bf": shrunk(sp["hr"], sp["bf"], LG["p_hr_bf"], K_BF) if spk else LG["p_hr_bf"],
                "sp_bb_bf": shrunk(sp["bb"], sp["bf"], LG["p_bb_bf"], K_BF) if spk else LG["p_bb_bf"],
                "sp_bf_start": (sp["bf"] / sp["gs"]) if spk and sp["gs"] else 21.0,
                "sp_known": 1.0 if spk else 0.0,
            }
            for m, (_, prior) in BATTER_MARKETS.items():
                feat[f"own_{m}"] = shrunk(b[f"g_{m}"], g, prior, K_G)
                feat[f"ownw_{m}"] = shrunk(w.tot[f"g_{m}"], wg, prior, 12)
                feat[f"y_{m}"] = getattr(r, f"y_{m}")
            feat.update(gamePk=gpk, date=r.date, season=season,
                        batter_id=r.batter_id, name=r.name, team_id=r.team_id)
            rows.append(feat)

        # ---- now fold this game into the cumulative state ----
        for r in gdf.itertuples():
            b, w = B[r.batter_id], W[r.batter_id]
            rec = {
                "pa": r.pa, "ab": r.ab, "h": r.h, "tb": r.tb, "hr": r.hr,
                "rbi": r.rbi, "r": r.r, "sb": r.sb, "bb": r.bb, "k": r.k, "g": 1,
            }
            for m in BATTER_MARKETS:
                rec[f"g_{m}"] = getattr(r, f"y_{m}")
            for kk in BAT_KEYS:
                b[kk] += rec[kk]
            w.add(day, rec)

        # team runs scored / allowed from the box score
        by_team = gdf.groupby("team_id").r.sum()
        ids = list(by_team.index)
        if len(ids) == 2:
            a, c = ids
            for me, other in ((a, c), (c, a)):
                st = T[(season, me)]
                st["g"] += 1
                st["r"] += by_team[me]
                st["ra"] += by_team[other]

        # pitcher season-to-date (used as the opposing-starter block)
        pdf = pit_by_game.get(gpk)
        if pdf is not None:
            for r in pdf.itertuples():
                st = P[r.pitcher_id]
                st["bf"] += r.bf
                st["k"] += r.k
                st["h"] += r.h_allowed
                st["bb"] += r.bb_allowed
                st["hr"] += r.hr_allowed
                st["gs"] += r.is_starter

    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# starting pitchers
# --------------------------------------------------------------------------- #
PIT_KEYS = ["bf", "k", "outs", "h", "bb", "hr", "er", "gs",
            "g_k5", "g_k6", "g_k7", "g_outs16"]

PITCHER_FEATURES = [
    "k_bf", "h_bf", "bb_bf", "hr_bf", "bf_start", "outs_start", "k_start",
    "w_k_bf", "w_bf_start", "w_k_start", "w_gs",
    "py_k_bf", "py_bf_start", "py_known",
    "gs", "days_rest", "is_home", "park",
    "opp_k_pa", "opp_h_pa", "opp_r_pg", "team_r_pg",
]


def build_pitchers():
    pg = pd.read_csv(os.path.join(DATA, "pitcher_games.csv"))
    bg = pd.read_csv(os.path.join(DATA, "batter_games.csv"))
    pg["day"] = day_num(pg.date)
    bg["day"] = day_num(bg.date)
    pg = pg.sort_values(["day", "gamePk"]).reset_index(drop=True)

    for m, (fn, _) in PITCHER_MARKETS.items():
        pg[f"y_{m}"] = [fn(r) for r in pg.itertuples()]

    py = (pg[pg.is_starter == 1].groupby(["season", "pitcher_id"])
          .agg(bf=("bf", "sum"), k=("k", "sum"), gs=("is_starter", "sum"))
          .reset_index())
    py_map = {(int(r.season) + 1, int(r.pitcher_id)): r for r in py.itertuples()}

    # team batting (K rate, hit rate, runs) season-to-date, from batter games
    TB = defaultdict(lambda: dict(pa=0.0, k=0.0, h=0.0, r=0.0, g=0.0))
    bat_by_game = {g: d for g, d in bg.groupby("gamePk")}

    P = defaultdict(lambda: dict.fromkeys(PIT_KEYS, 0.0))
    W = defaultdict(lambda: Window(PIT_KEYS))
    last_start = {}

    rows = []
    for gpk, gdf in pg.groupby("gamePk", sort=False):
        day = int(gdf.day.iloc[0])
        season = int(gdf.season.iloc[0])
        pf = park(gdf.venue.iloc[0])

        for r in gdf[gdf.is_starter == 1].itertuples():
            p, w = P[r.pitcher_id], W[r.pitcher_id]
            w.prune(day)
            opp = TB[(season, r.opp_team)]
            mine = TB[(season, r.team_id)]
            if p["gs"] < 1 or opp["g"] < 1 or mine["g"] < 1:
                continue
            bf, gs = p["bf"], p["gs"]
            wbf, wgs = w.tot["bf"], max(w.g, 0)
            pyr = py_map.get((season, int(r.pitcher_id)))
            feat = {
                "k_bf": shrunk(p["k"], bf, LG["p_k_bf"], K_BF),
                "h_bf": shrunk(p["h"], bf, LG["p_h_bf"], K_BF),
                "bb_bf": shrunk(p["bb"], bf, LG["p_bb_bf"], K_BF),
                "hr_bf": shrunk(p["hr"], bf, LG["p_hr_bf"], K_BF),
                "bf_start": bf / gs,
                "outs_start": p["outs"] / gs,
                "k_start": p["k"] / gs,
                "w_k_bf": shrunk(w.tot["k"], wbf, LG["p_k_bf"], 120),
                "w_bf_start": wbf / wgs if wgs else 21.0,
                "w_k_start": w.tot["k"] / wgs if wgs else 5.0,
                "w_gs": min(wgs, 8),
                "py_k_bf": shrunk(pyr.k, pyr.bf, LG["p_k_bf"], K_BF) if pyr is not None else LG["p_k_bf"],
                "py_bf_start": (pyr.bf / pyr.gs) if pyr is not None and pyr.gs else 21.0,
                "py_known": 1.0 if pyr is not None else 0.0,
                "gs": min(gs, 34),
                "days_rest": min(day - last_start.get(r.pitcher_id, day - 5), 12),
                "is_home": r.is_home,
                "park": pf,
                "opp_k_pa": shrunk(opp["k"], opp["pa"], LG["k_pa"], 400),
                "opp_h_pa": shrunk(opp["h"], opp["pa"], LG["h_pa"], 400),
                "opp_r_pg": opp["r"] / opp["g"],
                "team_r_pg": mine["r"] / mine["g"],
            }
            for m in PITCHER_MARKETS:
                prior = PITCHER_MARKETS[m][1]
                feat[f"own_{m}"] = shrunk(p[f"g_{m}"], gs, prior, 12)
                feat[f"ownw_{m}"] = shrunk(w.tot[f"g_{m}"], wgs, prior, 5)
                feat[f"y_{m}"] = getattr(r, f"y_{m}")
            feat.update(gamePk=gpk, date=r.date, season=season,
                        pitcher_id=r.pitcher_id, name=r.name, team_id=r.team_id)
            rows.append(feat)

        for r in gdf.itertuples():
            p, w = P[r.pitcher_id], W[r.pitcher_id]
            rec = {"bf": r.bf, "k": r.k, "outs": r.outs, "h": r.h_allowed,
                   "bb": r.bb_allowed, "hr": r.hr_allowed, "er": r.er,
                   "gs": r.is_starter}
            for m in PITCHER_MARKETS:
                rec[f"g_{m}"] = getattr(r, f"y_{m}") if r.is_starter else 0
            for kk in PIT_KEYS:
                p[kk] += rec[kk]
            w.add(day, rec)
            if r.is_starter:
                last_start[r.pitcher_id] = day

        bdf = bat_by_game.get(gpk)
        if bdf is not None:
            for tid, tdf in bdf.groupby("team_id"):
                st = TB[(season, tid)]
                st["pa"] += tdf.pa.sum()
                st["k"] += tdf.k.sum()
                st["h"] += tdf.h.sum()
                st["r"] += tdf.r.sum()
                st["g"] += 1

    return pd.DataFrame(rows)


if __name__ == "__main__":
    b = build_batters()
    b.to_csv(os.path.join(DATA, "batter_features.csv"), index=False)
    print(f"batter rows: {len(b):,}  seasons={sorted(b.season.unique())}")
    print({m: round(b[f'y_{m}'].mean(), 3) for m in BATTER_MARKETS})
    p = build_pitchers()
    p.to_csv(os.path.join(DATA, "pitcher_features.csv"), index=False)
    print(f"pitcher rows: {len(p):,}")
    print({m: round(p[f'y_{m}'].mean(), 3) for m in PITCHER_MARKETS})
