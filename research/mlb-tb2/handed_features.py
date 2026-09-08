"""
The staff a hitter actually faces: starter, bullpen, and handedness.

TWO-BASES.md tested a bullpen block and a platoon block and dropped both. Each
was built the flat way — the bullpen's season ERA, the hitter's own rate against
left-handers — and each moved AUC by less than a thousandth, the platoon block
into the red. This is the same two ideas built the way the game is actually
played, so that "it does not help" means something stronger than "the first
version did not help".

Three things the dropped blocks never had:

  who throws the pitch. The shipped model sees the starter's overall strikeout
  rate and the hitter's overall bases per plate appearance. Neither is split by
  hand, so a left-handed starter with a 30-point platoon gap and one with none
  are the same number to it. This builds the *starter's own* split — bases,
  hits, home runs and strikeouts allowed per plate appearance to batters of the
  hand this hitter swings from tonight — and the gap between it and his overall
  rate, which is the size of his platoon tilt rather than its direction.

  how many trips are actually against him. A starter is not 27 outs. Given the
  batters he has been facing lately and where this hitter bats, the number of
  his plate appearances that come against the starter is roughly
      floor((bf - slot) / 9) + 1
  and the rest come against relief. A leadoff hitter facing a starter who goes
  five sees him three times and the bullpen twice; the nine hole sees him twice
  and the bullpen twice. That share is what decides how much the bullpen ought
  to matter, and it is knowable before first pitch.

  the bullpen's own hand. A pen that throws 40% of its batters faced left is a
  different opponent to a left-handed hitter than to a right-handed one, and
  the shipped bullpen block — ERA, K rate, hit rate, home-run rate, all pooled
  — cannot express that.

Blocks built here (all on top of the shipped 2+ bases feature set):

  sphand   the starting pitcher's platoon split, from this hitter's side of it
  penhand  the bullpen's platoon split, and how left-handed the pen is
  expo     how many plate appearances are against the starter, and against relief
  blend    one exposure-weighted staff rate: the two split rates above, mixed in
           the proportion this hitter will actually face them

Attribution. Box scores do not say which pitcher a plate appearance came
against, so a game's opposing batters are split between the starter and the
relievers by lineup position: the starter's `bf` batters faced are the first bf
turns through the order, so slot i is charged to him
floor((bf - i)/9) + 1 times and to the pen for whatever is left of that hitter's
plate appearances. It is an approximation — pinch hitters, a starter pulled
mid-inning, a lineup that turned over irregularly — but it is right for the
large majority of turns and far closer than charging every batter to the
starter, which is what a pooled rate does.

Everything is built by the same strictly chronological walk as the rest of the
repo: a row for game G only sees games that finished before G, every rate is
shrunk to the league mean, and switch hitters are given the hand they would
actually bat from against tonight's starter.

Input:  ../mlb-props/data/{batter_games,pitcher_games,player_hands}.csv
Output: data/handed_features.csv, keyed (gamePk, batter_id)
"""

import os
from collections import defaultdict

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
os.makedirs(DATA, exist_ok=True)

# League per-plate-appearance rates, used as the shrinkage prior.
LG_TB_PA = 0.350
LG_H_PA = 0.216
LG_HR_PA = 0.032
LG_K_PA = 0.223

K_SP = 250.0    # a starter's own split: ~one season of one hand
K_PEN = 900.0   # a bullpen's split: it accumulates far faster
LG_BF = 22.0    # a starter's batters faced, before he has started a game

HANDED_BLOCKS = {
    "sphand": ["sp_tb_pa_h", "sp_h_pa_h", "sp_hr_pa_h", "sp_k_pa_h",
               "sp_split_gap", "sp_hand_pa", "sp_hand_known"],
    "penhand": ["pen_tb_pa_h", "pen_hr_pa_h", "pen_k_pa_h", "pen_split_gap",
                "pen_lhp_share", "pen_edge_share", "pen_hand_known"],
    "expo": ["sp_pa_exp", "pen_pa_exp", "pen_share", "sp_bf_trend"],
    "blend": ["staff_tb_pa", "staff_hr_pa", "staff_k_pa"],
}
HANDED_FEATURES = list(dict.fromkeys(f for b in HANDED_BLOCKS.values() for f in b))


def shrunk(num, den, prior, k):
    return (num + k * prior) / (den + k)


def eff_hand(bats, throws):
    """The hand a hitter actually swings from tonight. A switch hitter bats
    opposite the pitcher; an unknown pitcher leaves him right-handed, which is
    what a switch hitter faces most of the time."""
    if bats == "S":
        return "R" if throws == "L" else "L"
    return bats if bats in ("L", "R") else "R"


def sp_turns(bf, slot):
    """How many of this slot's plate appearances came against the starter, if
    he faced `bf` batters starting from the top of the order."""
    if bf <= 0 or not (1 <= slot <= 9):
        return 0.0
    return float(max(0, (int(bf) - int(slot)) // 9 + 1))


def build():
    bg = pd.read_csv(os.path.join(PROPS, "batter_games.csv"))
    pg = pd.read_csv(os.path.join(PROPS, "pitcher_games.csv"))
    hands = pd.read_csv(os.path.join(PROPS, "player_hands.csv"))

    BATS = dict(zip(hands.player_id, hands.bats))
    THROWS = dict(zip(hands.player_id, hands.throws))

    bg = bg.sort_values(["date", "gamePk"]).reset_index(drop=True)
    bg["xbh"] = bg.d2 + bg.d3 + bg.hr

    # Per game: the starter each team used, his batters faced, and the pen's.
    starters = pg[pg.is_starter == 1]
    sp_bf_game = {(r.gamePk, r.team_id): float(r.bf) for r in starters.itertuples()}
    sp_id_game = {(r.gamePk, r.team_id): int(r.pitcher_id) for r in starters.itertuples()}
    pen_rows = pg[pg.is_starter == 0]
    pen_by_game = {g: d for g, d in pen_rows.groupby(["gamePk", "team_id"])}

    # ---- running totals, all strictly chronological ----
    # SP[pid][hand] -> what this starter has allowed to that hand
    SP = defaultdict(lambda: defaultdict(lambda: dict(pa=0.0, tb=0.0, h=0.0, hr=0.0, k=0.0)))
    # PEN[(season, team)][hand] -> the same for everyone who was not the starter
    PEN = defaultdict(lambda: defaultdict(lambda: dict(pa=0.0, tb=0.0, h=0.0, hr=0.0, k=0.0)))
    # how left-handed a bullpen is, by batters faced
    PENH = defaultdict(lambda: dict(bf=0.0, lhp_bf=0.0))
    SPBF = defaultdict(lambda: dict(bf=0.0, g=0.0))   # a starter's workload

    rows = []
    for gpk, gdf in bg.groupby("gamePk", sort=False):
        season = int(gdf.season.iloc[0])
        for r in gdf.itertuples():
            if not (1 <= r.slot <= 9):
                continue
            sp_id = int(r.opp_sp) if not pd.isna(r.opp_sp) else 0
            throws = THROWS.get(sp_id, "R")
            hand = eff_hand(BATS.get(r.batter_id, "R"), throws)

            s_all = SP[sp_id]
            s = s_all[hand]
            spa = s["pa"]
            sp_known = 1.0 if spa >= 25 else 0.0
            sp_tb = shrunk(s["tb"], spa, LG_TB_PA, K_SP)
            # his overall rate, both hands, for the size of the platoon tilt
            tot_pa = sum(v["pa"] for v in s_all.values())
            tot_tb = sum(v["tb"] for v in s_all.values())
            sp_tb_all = shrunk(tot_tb, tot_pa, LG_TB_PA, K_SP)

            p = PEN[(season, r.opp_team)][hand]
            ppa = p["pa"]
            pen_known = 1.0 if ppa >= 100 else 0.0
            pen_tb = shrunk(p["tb"], ppa, LG_TB_PA, K_PEN)
            pen_all = PEN[(season, r.opp_team)]
            pt_pa = sum(v["pa"] for v in pen_all.values())
            pt_tb = sum(v["tb"] for v in pen_all.values())
            pen_tb_all = shrunk(pt_tb, pt_pa, LG_TB_PA, K_PEN)

            ph = PENH[(season, r.opp_team)]
            lhp_share = (ph["lhp_bf"] / ph["bf"]) if ph["bf"] > 200 else 0.28
            # the share of the pen that has the platoon advantage on him
            edge_share = lhp_share if hand == "L" else (1.0 - lhp_share)

            # expected exposure, from what this starter has been going lately
            w = SPBF[sp_id]
            bf_trend = (w["bf"] / w["g"]) if w["g"] >= 3 else LG_BF
            sp_pa = min(sp_turns(bf_trend, r.slot), 4.0)
            pa_exp = 4.6 - 0.09 * r.slot          # roughly what a slot gets
            pen_pa = max(pa_exp - sp_pa, 0.0)
            pen_share = pen_pa / pa_exp if pa_exp > 0 else 0.5

            rows.append(dict(
                gamePk=gpk,
                batter_id=r.batter_id,
                sp_tb_pa_h=sp_tb,
                sp_h_pa_h=shrunk(s["h"], spa, LG_H_PA, K_SP),
                sp_hr_pa_h=shrunk(s["hr"], spa, LG_HR_PA, K_SP),
                sp_k_pa_h=shrunk(s["k"], spa, LG_K_PA, K_SP),
                sp_split_gap=sp_tb - sp_tb_all,
                sp_hand_pa=min(spa, 500.0),
                sp_hand_known=sp_known,
                pen_tb_pa_h=pen_tb,
                pen_hr_pa_h=shrunk(p["hr"], ppa, LG_HR_PA, K_PEN),
                pen_k_pa_h=shrunk(p["k"], ppa, LG_K_PA, K_PEN),
                pen_split_gap=pen_tb - pen_tb_all,
                pen_lhp_share=lhp_share,
                pen_edge_share=edge_share,
                pen_hand_known=pen_known,
                sp_pa_exp=sp_pa,
                pen_pa_exp=pen_pa,
                pen_share=pen_share,
                sp_bf_trend=bf_trend,
                staff_tb_pa=(1 - pen_share) * sp_tb + pen_share * pen_tb,
                staff_hr_pa=((1 - pen_share) * shrunk(s["hr"], spa, LG_HR_PA, K_SP)
                             + pen_share * shrunk(p["hr"], ppa, LG_HR_PA, K_PEN)),
                staff_k_pa=((1 - pen_share) * shrunk(s["k"], spa, LG_K_PA, K_SP)
                            + pen_share * shrunk(p["k"], ppa, LG_K_PA, K_PEN)),
            ))

        # ---- fold the finished game in, charged by lineup position ----
        for r in gdf.itertuples():
            if r.pa <= 0:
                continue
            sp_id = sp_id_game.get((gpk, r.opp_team))
            if sp_id is None:
                continue
            throws = THROWS.get(sp_id, "R")
            hand = eff_hand(BATS.get(r.batter_id, "R"), throws)
            bf = sp_bf_game.get((gpk, r.opp_team), 0.0)
            vs_sp = min(sp_turns(bf, r.slot), float(r.pa))
            frac = vs_sp / float(r.pa)
            for store, f in ((SP[sp_id][hand], frac),
                             (PEN[(season, r.opp_team)][hand], 1.0 - frac)):
                if f <= 0:
                    continue
                store["pa"] += f * r.pa
                store["tb"] += f * r.tb
                store["h"] += f * r.h
                store["hr"] += f * r.hr
                store["k"] += f * r.k

        for tid in gdf.opp_team.unique():
            pdf = pen_by_game.get((gpk, tid))
            if pdf is None:
                continue
            for q in pdf.itertuples():
                ph = PENH[(season, int(tid))]
                ph["bf"] += float(q.bf)
                if THROWS.get(int(q.pitcher_id)) == "L":
                    ph["lhp_bf"] += float(q.bf)

        for (g, tid), bfv in ((k, v) for k, v in sp_bf_game.items() if k[0] == gpk):
            w = SPBF[sp_id_game[(g, tid)]]
            w["bf"] += bfv
            w["g"] += 1.0

    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(DATA, "handed_features.csv"), index=False)
    print(f"handed rows: {len(df):,}  columns: {len(HANDED_FEATURES)}")
    print(df[HANDED_FEATURES].describe().T[["mean", "std", "min", "max"]].round(4).to_string())
    return df


if __name__ == "__main__":
    build()
