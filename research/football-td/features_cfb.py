"""
Point-in-time college features, exactly as research/cfb/features.py builds
them (with the Elo replay of research/cfb/elo_backtest.py copied in), plus the
rows that pipeline leaves out.

    python3 research/football-td/features_cfb.py   # after fetch_cfb.py

Reads data/games.csv, data/team_games.csv, data/player_games.csv and
data/cache/sched_{season}.json (fetch_cfb.py). Writes data/cfb_features_all.csv.

TWO THINGS ARE FROZEN AT THE EXPORT, SO THE FEATURES ARE PREFIX-STABLE
  league rates   features.py recomputes LG_RUSH / LG_REC / LG_ANY from every
                 player-game on disk. The shipped forest's constants (its JSON
                 `constants`) are used instead; the recomputed values on the
                 export-time data are printed as a check.
  FBS set        elo_backtest.load() calls a team FBS when it averages >= 4
                 scoreboard appearances per loaded season — a count that drifts
                 as 2026 fills in (2025 FBS newcomers sit right at the line).
                 It is computed on schedules truncated at the export's data
                 cutoff (FBS_CUTOFF), which is what the shipped pipeline saw.
With both frozen, a game's features depend only on games before it, so the
2026 games played after the export are priced exactly as the shipped pipeline
would have priced them.

ROW KINDS (column `kind`) — same meaning as features_nfl.py
  candidate   the original rows, same order: >=1 carry or reception in THIS
              game AND >=1 touch of season-to-date usage (this season, plus a
              team-level scaled share of last season below 5 team games).
  no_history  touched the ball in this game but could not be priced.
  no_touch    touched the ball for this team earlier THIS season, no carry or
              reception today; priced, scored = 0, not in the quoted metrics.
"""
import os, sys, json, math
import pandas as pd
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "cache")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SHIPPED = json.load(open(os.path.join(ROOT, "src", "lib", "cfb-td-forest.json")))

K_RUSH, K_REC, K_ANY = 25.0, 20.0, 4.0
USAGE_WINDOW = 5
ALL_FEATURES = [
    "carry_share", "rec_share", "cpg", "rpg", "rush_ypg", "rec_ypg",
    "rush_td_rate", "rec_td_rate", "anytime_rate", "gp",
    "team_rush_tdpg", "team_rec_tdpg",
    "opp_rush_td_allowed_pg", "opp_rec_td_allowed_pg",
    "is_home", "proj_team_pts", "proj_total", "elo_margin",
]
EXPENSIVE = ["opp_rush_td_allowed_pg", "opp_rec_td_allowed_pg"]
FEATURES = [f for f in ALL_FEATURES if f not in EXPENSIVE]
assert FEATURES == SHIPPED["features"]

# Data cutoff of the export (research/cfb data as of commit 379dd9c,
# 2026-09-17): set by matching the quoted 1,130 games / 21,503 rows.
FBS_CUTOFF = os.environ.get("CFB_FBS_CUTOFF", "2026-09-13")

# ------------------------------------------------- elo (from elo_backtest.py)
SEASONS = [2021, 2022, 2023, 2024, 2025, 2026]
ELO_MEAN = 1505.0
ELO_INIT = 1300.0
FCS = "__FCS__"


def elo_load(fbs_cutoff=None):
    by_season = {}
    fbs = set()
    for s in SEASONS:
        fp = os.path.join(CACHE, f"sched_{s}.json")
        if not os.path.exists(fp):
            continue
        games = [g for g in json.load(open(fp))
                 if g["completed"] and g["home"]["score"] is not None
                 and g["away"]["score"] is not None]
        games.sort(key=lambda g: (g["date"], g["id"]))
        by_season[s] = games
    counts = defaultdict(int)
    for s, games in by_season.items():
        for g in games:
            if fbs_cutoff and g["date"] > fbs_cutoff:
                continue
            counts[g["home"]["id"]] += 1
            counts[g["away"]["id"]] += 1
    per_season = len(by_season) or 1
    for tid, n in counts.items():
        if n / per_season >= 4:
            fbs.add(tid)
    return by_season, fbs


class Elo:
    def __init__(self, k, hfa, carry):
        self.k, self.hfa, self.carry = k, hfa, carry
        self.r = {}

    def rating(self, t):
        return self.r.get(t, ELO_INIT)

    def carry_season(self):
        for t, v in list(self.r.items()):
            self.r[t] = ELO_MEAN + self.carry * (v - ELO_MEAN)

    def prob(self, home, away, neutral):
        d = self.rating(home) - self.rating(away) + (0 if neutral else self.hfa)
        return 1.0 / (1.0 + 10 ** (-d / 400.0))

    def update(self, home, away, hs, as_, neutral):
        p = self.prob(home, away, neutral)
        result = 1.0 if hs > as_ else 0.0
        d = self.rating(home) - self.rating(away) + (0 if neutral else self.hfa)
        winner_diff = (1 if result == 1 else -1) * d
        mult = math.log(abs(hs - as_) + 1) * (2.2 / (winner_diff * 0.001 + 2.2))
        if not math.isfinite(mult) or mult < 0:
            mult = 1.0
        delta = self.k * mult * (result - p)
        self.r[home] = self.rating(home) + delta
        self.r[away] = self.rating(away) - delta


def team_key(side, fbs):
    return side["id"] if side["id"] in fbs else FCS


# ------------------------------------------------------- features.py
def league_rates(pg):
    return {
        "LG_RUSH": pg["rush_td"].sum() / max(1, pg["car"].sum()),
        "LG_REC": pg["rec_td"].sum() / max(1, pg["rec"].sum()),
        "LG_ANY": pg["scored"].mean(),
    }


def carry_fraction(team_cur, team_prev):
    if not team_prev or team_prev["gp"] < 1:
        return 0.0
    need = USAGE_WINDOW - team_cur["gp"]
    return min(1.0, need / team_prev["gp"]) if need > 0 else 0.0


def blend(cur, prev, frac):
    if frac <= 0 or not prev:
        return dict(cur)
    return {k: cur[k] + prev.get(k, 0) * frac for k in cur}


def build(lg=None, fbs_cutoff=FBS_CUTOFF):
    games = pd.read_csv(os.path.join(DATA, "games.csv"))
    team = pd.read_csv(os.path.join(DATA, "team_games.csv"))
    pg = pd.read_csv(os.path.join(DATA, "player_games.csv"))
    lg_data = league_rates(pg[pg.date <= fbs_cutoff]) if fbs_cutoff else league_rates(pg)
    if lg is None:
        lg = lg_data
    print(f"league rates used: {lg}")
    print(f"league rates recomputed from data <= {fbs_cutoff}: {lg_data}")

    by_season, fbs = elo_load(fbs_cutoff)
    print(f"FBS teams (schedules <= {fbs_cutoff}): {len(fbs)}")
    elo = Elo(40, 55, 0.60)
    elo_seasons = sorted(by_season)

    games = games.sort_values(["date", "game_id"])
    team_by_game = {g: df for g, df in team.groupby("game_id")}
    pg_by_game = {g: df for g, df in pg.groupby("game_id")}
    sched = {}
    for s in elo_seasons:
        for g in by_season[s]:
            sched[g["id"]] = g

    P = defaultdict(lambda: dict(car=0., rec=0., ry=0., cy=0., rtd=0., ctd=0.))
    T = defaultdict(lambda: dict(
        gp=0, car=0., rec=0., rtd=0., ctd=0., dRtd=0., dCtd=0., pts=0., papg=0.))
    prev_P, prev_T = {}, {}
    # extras: per-team list of this season's games, and each player's last touch
    team_log = defaultdict(list)
    last_touch = defaultdict(dict)   # team -> pid -> index into team_log[team]
    names = {}

    rows, extra = [], []
    cur_season = None
    for season, sgames in games.groupby("season", sort=True):
        prev_P, prev_T = dict(P), dict(T)
        P.clear(); T.clear()
        team_log.clear(); last_touch.clear()

        if cur_season is None:
            for s in elo_seasons:
                if s >= season:
                    break
                if s > min(elo_seasons):
                    elo.carry_season()
                for g in by_season[s]:
                    if g["home"]["score"] == g["away"]["score"]:
                        continue
                    elo.update(team_key(g["home"], fbs), team_key(g["away"], fbs),
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
            sg = sched.get(gid, {})
            base0 = {"season": season, "date": g.date, "game_id": gid,
                     "week": sg.get("week"), "season_type": sg.get("season_type")}
            if tg is None or pgg is None or eg is None or len(tg) != 2:
                if pgg is not None:
                    for pr in pgg.itertuples():
                        extra.append({**base0, "team": pr.team, "kind": "no_history",
                                      "unpriced_reason": "game_skipped",
                                      "player_id": str(pr.player_id), "player": pr.player,
                                      "team_id": str(pr.team_id), "car_g": pr.car,
                                      "rec_g": pr.rec, "rush_td_g": pr.rush_td,
                                      "rec_td_g": pr.rec_td,
                                      "td_count": pr.rush_td + pr.rec_td,
                                      "scored": int(pr.scored)})
                continue

            sides = {r.team: r for r in tg.itertuples()}
            names_ = list(sides)
            if len(names_) != 2:
                continue
            hk = team_key(eg["home"], fbs)
            ak = team_key(eg["away"], fbs)

            for tname in names_:
                oname = [n for n in names_ if n != tname][0]
                side = sides[tname]
                is_home = int(side.is_home)
                mine = T[tname]
                opp = T[oname]
                base = {**base0, "team": tname, "opp": oname, "is_home": is_home,
                        "team_id": str(side.team_id)}
                box = pgg[pgg.team == tname]

                def unpriced(reason, only=None):
                    for pr in box.itertuples():
                        if only is not None and str(pr.player_id) not in only:
                            continue
                        extra.append({**base, "kind": "no_history", "unpriced_reason": reason,
                                      "player_id": str(pr.player_id), "player": pr.player,
                                      "car_g": pr.car, "rec_g": pr.rec,
                                      "rush_td_g": pr.rush_td, "rec_td_g": pr.rec_td,
                                      "td_count": pr.rush_td + pr.rec_td,
                                      "scored": int(pr.scored)})

                frac = carry_fraction(mine, prev_T.get(tname))
                mine_src = blend(mine, prev_T.get(tname), frac)
                opp_src = blend(opp, prev_T.get(oname),
                                carry_fraction(opp, prev_T.get(oname)))
                if mine_src["gp"] < 1 or opp_src["gp"] < 1:
                    unpriced("no_team_history")
                    continue
                gp = mine_src["gp"]

                team_ppg = mine_src["pts"] / mine_src["gp"]
                team_papg = mine_src["papg"] / mine_src["gp"]
                opp_ppg = opp_src["pts"] / opp_src["gp"]
                opp_papg = opp_src["papg"] / opp_src["gp"]
                proj_team = (team_ppg + opp_papg) / 2
                proj_opp = (opp_ppg + team_papg) / 2
                my_key, their_key = (hk, ak) if is_home else (ak, hk)
                elo_margin = (elo.rating(my_key) - elo.rating(their_key)
                              + (0 if eg["neutral"] else (55 if is_home else -55))) / 25.0

                def feat(src):
                    return {
                        "carry_share": src["car"] / mine_src["car"] if mine_src["car"] else 0.,
                        "rec_share": src["rec"] / mine_src["rec"] if mine_src["rec"] else 0.,
                        "cpg": src["car"] / gp,
                        "rpg": src["rec"] / gp,
                        "rush_ypg": src["ry"] / gp,
                        "rec_ypg": src["cy"] / gp,
                        "rush_td_rate": (src["rtd"] + K_RUSH * lg["LG_RUSH"]) / (src["car"] + K_RUSH),
                        "rec_td_rate": (src["ctd"] + K_REC * lg["LG_REC"]) / (src["rec"] + K_REC),
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
                    }

                seen, skipped = set(), set()
                for pr in box.itertuples():
                    pid = str(pr.player_id)
                    seen.add(pid)
                    src = blend(P[pid], prev_P.get(pid), frac)
                    if (src["car"] + src["rec"]) < 1:
                        skipped.add(pid)
                        continue
                    rows.append({
                        "season": season, "date": g.date, "game_id": gid,
                        "team": tname, "opp": oname,
                        "player_id": pid, "player": pr.player,
                        **feat(src),
                        "scored": int(pr.scored),
                        # extras (not used by the model)
                        "kind": "candidate", "week": base0["week"],
                        "season_type": base0["season_type"], "team_id": base["team_id"],
                        "car_g": pr.car, "rec_g": pr.rec, "rush_td_g": pr.rush_td,
                        "rec_td_g": pr.rec_td, "td_count": pr.rush_td + pr.rec_td,
                    })
                if skipped:
                    unpriced("no_prior_usage", skipped)

                # no_touch: touched the ball for this team earlier this season
                for pid, k in last_touch[tname].items():
                    if pid in seen:
                        continue
                    src = blend(P[pid], prev_P.get(pid), frac)
                    if (src["car"] + src["rec"]) < 1:
                        continue
                    extra.append({**base, "kind": "no_touch", "player_id": pid,
                                  "player": names.get(pid, ""), **feat(src),
                                  "games_since_touch": len(team_log[tname]) - 1 - k,
                                  "car_g": 0, "rec_g": 0, "rush_td_g": 0, "rec_td_g": 0,
                                  "td_count": 0, "scored": 0})

            # --- now the game is in the past: fold it into the running state
            for tname in names_:
                oname = [n for n in names_ if n != tname][0]
                side, other = sides[tname], sides[oname]
                t = T[tname]
                t["gp"] += 1
                t["rtd"] += side.rush_td
                t["ctd"] += side.rec_td
                t["dRtd"] += other.rush_td
                t["dCtd"] += other.rec_td
                t["pts"] += side.points
                t["papg"] += side.opp_points
                team_log[tname].append(gid)
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
                    last_touch[tname][str(pr.player_id)] = len(team_log[tname]) - 1
                    names[str(pr.player_id)] = pr.player

            if eg["home"]["score"] != eg["away"]["score"]:
                elo.update(hk, ak, eg["home"]["score"], eg["away"]["score"], eg["neutral"])

    df = pd.DataFrame(rows)
    ex = pd.DataFrame(extra)
    print(f"built {len(df):,} candidate rows, {df.scored.mean()*100:.1f}% scored; "
          f"{len(ex):,} extra rows ({ex.kind.value_counts().to_dict() if len(ex) else {}})")
    return df, ex, lg, lg_data, fbs


if __name__ == "__main__":
    c = SHIPPED["constants"]
    shipped_lg = {"LG_RUSH": c["LG_RUSH"], "LG_REC": c["LG_REC"], "LG_ANY": c["LG_ANY"]}
    df, ex, lg, lg_data, fbs = build(lg=shipped_lg)
    out = pd.concat([df, ex], ignore_index=True, sort=False)
    out.to_csv(os.path.join(DATA, "cfb_features_all.csv"), index=False)
    json.dump({"used": lg, "recomputed_at_cutoff": lg_data, "fbs_cutoff": FBS_CUTOFF,
               "fbs_teams": sorted(fbs)},
              open(os.path.join(DATA, "cfb_feature_constants.json"), "w"), indent=1)
    print("wrote data/cfb_features_all.csv, data/cfb_feature_constants.json")
