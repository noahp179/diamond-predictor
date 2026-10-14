"""
Walk-forward inputs for every starter in every match, for the three methods.

For each match of 2022-23 .. 2026-27 (five leagues + the Champions League) and
each player who STARTED it, everything below is computed from matches played on
EARLIER calendar days only ("the morning of the match"):

model  -- the site's shipped per-league logistic "goal1" market
          (src/lib/soccer-props-model.json), with the features built exactly as
          the live site builds them (src/lib/soccer-props.server.ts):
            * season form = this season's rows of the league before the match
              day; while that is < 600 player rows, last season's rows are
              prepended (the live early-season rule)
            * prior-season totals from last season's rows
            * player position / formation place = the LAST seen (live), not
              this match's slot
            * gates: MIN_APPS 3, start rate >= 0.5, both teams >= 3 games, the
              player's latest team is this team  -> column `gate_live`
          Domestic leagues only (there is no Champions League props model).

sim    -- inputs of the simulator's closed form P = 1 - E[(1 - s*m)^G]:
            * team expected goals: the cross-league Elo of research/ucl
              (common.replay, tuned_params.json) mapped to Poisson goal rates by
              a per-league Poisson GLM on the rating gap fitted on the five
              PREVIOUS seasons of that league, plus a Dixon-Coles rho fitted on
              the same matches. Champions League: the walk-forward mapping of
              research/ucl/backtest_ucl.py (2022-25) and the shipped
              src/lib/ucl-model.json mapping for 2026-27 (out of sample).
              G's distribution is the team's marginal of the DC score matrix.
            * s_site: the site's scorer share (ship_ucl.write_scorers +
              ucl.server.ts uclSquad): recency-weighted non-own goals for this
              club in ALL competitions in research/ucl/data/events.csv, 400-day
              window, half-life 180 d, shrunk to position priors
              F .10 / M .035 / D .012 / G 0 (unknown .02) with k = 6, then
              normalised over the squad to sum to 1 - 0.028 (own goals).
              The live squad is ESPN's current roster; the backtest proxy is
              every player named in a match-day squad of the club in the 120
              days before the match plus today's match-day squad.
            * s_on: the same recency weights, but the player's goals per TEAM
              GOAL SCORED WHILE HE WAS ON THE PITCH (domestic league + UCL
              matches in data/, where minutes are known), shrunk with k = 6
              toward a position prior measured on 2021-22..2023-24.
            * m_start: expected share of the match's goal intensity he is on
              the pitch given he starts = recency-weighted mean over his past
              starts, shrunk (k = 2 starts) toward the position average.

extra  -- other as-of inputs used by the fitted model of our own (penalty
          share, career goals per 90, shots per 90, team/opponent xG, ...).

Writes data/candidates.csv.gz (one row per starter per match) and
data/parity_sample.json (inputs for parity_props.ts, which checks this file's
port of the live feature code against the site's TypeScript).

Usage: python3 features.py          (after fetch.py and build.py)
"""

import json
import math
import os
import sys
from bisect import bisect_left
from collections import defaultdict

import numpy as np
import pandas as pd

sys.dont_write_bytecode = True  # never write __pycache__ into research/ucl
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(HERE, "data")
UCL_DIR = os.path.join(ROOT, "research", "ucl")
sys.path.insert(0, UCL_DIR)
import backtest_ucl as ucl_bt  # noqa: E402
import common as ucl_common  # noqa: E402

PROPS = json.load(open(os.path.join(ROOT, "src", "lib", "soccer-props-model.json")))
UCL_MODEL = json.load(open(os.path.join(ROOT, "src", "lib", "ucl-model.json")))
TUNED = json.load(open(os.path.join(UCL_DIR, "results", "tuned_params.json")))["params"]

DOMESTIC = {"eng.1": "epl", "esp.1": "laliga", "ger.1": "bundesliga", "ita.1": "seriea", "fra.1": "ligue1"}
SEASONS = [2022, 2023, 2024, 2025, 2026]

# ---- site constants (src/lib/ucl.server.ts, research/ucl/sim_ucl.py)
POS_PRIOR = {"F": 0.10, "M": 0.035, "D": 0.012, "G": 0.0}
POS_DEFAULT = 0.02
OWN_GOAL_SHARE = 0.028
SHRINK = 6.0
HALF_LIFE = 180.0
WINDOW = 400
SQUAD_DAYS = 120

# ---- live props constants (src/lib/soccer-props.server.ts)
LG = dict(sh=1.02, sot=0.34, goal=0.11, asst=0.08, card=0.15, foul=0.84)
K_APP, K_G, WIN6, APPS_CAP = 12.0, 10.0, 6, 38
FW = {"F", "CF", "LW", "RW", "ST", "SS"}
MF = {"M", "CM", "AM", "DM", "LM", "RM"}
DF = {"D", "CB", "LB", "RB", "WB"}
MARKET_PRIOR = dict(sh1=0.55, sh2=0.28, sh3=0.13, sot1=0.25, sot2=0.08, goal1=0.10, asst1=0.07,
                    ga1=0.16, card1=0.15, foul2=0.25)


def slot_letter(slot):
    """ESPN slot code ('CD-L', 'AM-R', 'CF', 'G', 'SUB') -> F / M / D / G / ''."""
    s = slot.upper() if isinstance(slot, str) else ""
    if s in ("", "SUB"):
        return ""
    base = s.split("-")[0]
    if base in ("G", "GK"):
        return "G"
    if base in ("CD", "CB", "LB", "RB", "LWB", "RWB", "WB", "SW", "D", "LCB", "RCB"):
        return "D"
    if base in ("CF", "F", "ST", "LF", "RF", "LW", "RW", "SS", "FW", "RCF", "LCF"):
        return "F"
    if base in ("AM", "CM", "DM", "LM", "RM", "M", "LAM", "RAM", "CAM", "CDM", "RCM", "LCM"):
        return "M"
    return ""


def day_num(dates):
    return (pd.to_datetime(pd.Series(dates)).values.astype("datetime64[D]").astype(np.int64)
            - np.datetime64("2013-01-01", "D").astype(np.int64))


# ============================================================== team xG

def team_goal_rates(my_matches):
    """Pre-match (lambda_home, lambda_away, rho) for every match in data/matches.csv."""
    m = ucl_common.load_matches()
    rh, ra, final_rating, _ = ucl_common.pre_match_ratings(m, TUNED)
    X = ucl_bt.feats(rh, ra, m.neutral.values, m.ucl.values)
    have90 = m.hg90.notna().values
    hg90 = m.hg90.fillna(0).values.astype(int)
    ag90 = m.ag90.fillna(0).values.astype(int)
    out = {}
    fits = {}
    for comp in DOMESTIC:
        for S in SEASONS + [2021]:
            tr = (m.comp.values == comp) & m.season.between(S - 5, S - 1).values & have90
            te = (m.comp.values == comp) & (m.season.values == S)
            if te.sum() == 0:
                continue
            gb = ucl_bt.fit_goals(X[tr], hg90[tr], ag90[tr], ucl_terms=False)
            lh_tr, la_tr = ucl_bt.goal_rates(gb, X[tr])
            rho = ucl_bt.fit_rho(lh_tr, la_tr, hg90[tr], ag90[tr])
            lh, la = ucl_bt.goal_rates(gb, X[te])
            fits[f"{comp}:{S}"] = dict(home=list(map(float, gb[0])), away=list(map(float, gb[1])), rho=rho,
                                       n=int(tr.sum()))
            for i, a, b in zip(m.id.values[te], lh, la):
                out[i] = (float(a), float(b), rho)
    # Champions League: walk-forward as in research/ucl/backtest_ucl.py
    for S in SEASONS + [2021]:
        te = m.ucl.values & (m.season.values == S)
        if te.sum() == 0:
            continue
        if S <= 2025:
            tr = m.europe.values & m.season.between(2014, S - 1).values & have90
            gb = ucl_bt.fit_goals(X[tr], hg90[tr], ag90[tr])
            lh_tr, la_tr = ucl_bt.goal_rates(gb, X[tr])
            rho = ucl_bt.fit_rho(lh_tr, la_tr, hg90[tr], ag90[tr])
        else:  # 2026-27: the shipped mapping (fitted through 2025-26) is out of sample
            gb = (np.array(UCL_MODEL["goals"]["home"]), np.array(UCL_MODEL["goals"]["away"]))
            rho = float(UCL_MODEL["goals"]["rho"])
        lh, la = ucl_bt.goal_rates(gb, X[te])
        fits[f"uefa.champions:{S}"] = dict(home=list(map(float, gb[0])), away=list(map(float, gb[1])), rho=rho)
        for i, a, b in zip(m.id.values[te], lh, la):
            out[i] = (float(a), float(b), rho)
    # Matches after research/ucl/data's last day (the 2026-10-13 Champions League
    # round): every earlier match is already in the replay, so the final ratings
    # ARE the morning-of ratings. Priced with the shipped 2026-27 mapping.
    last_day = m.date.max()[:10]
    late = my_matches[~my_matches.matchId.isin(set(m.id)) & (my_matches.date > last_day)]
    for r in late.itertuples():
        h, a = final_rating.get(r.home_id), final_rating.get(r.away_id)
        if h is None or a is None:
            continue
        x = ucl_bt.feats(np.array([h]), np.array([a]), np.array([bool(r.neutral)]),
                         np.array([r.comp == "uefa.champions"]))
        if r.comp == "uefa.champions":
            gb = (np.array(UCL_MODEL["goals"]["home"]), np.array(UCL_MODEL["goals"]["away"]))
            rho = float(UCL_MODEL["goals"]["rho"])
        else:
            f = fits[f"{r.comp}:{r.season}"]
            gb, rho = (np.array(f["home"]), np.array(f["away"])), f["rho"]
        lh, la = ucl_bt.goal_rates(gb, x)
        out[r.matchId] = (float(lh[0]), float(la[0]), rho)
    print(f"priced from final ratings (after research/ucl data cutoff {last_day}): {len(late)}")
    # sanity: compare with research/ucl/results/backtest_matches.csv
    bt = pd.read_csv(os.path.join(UCL_DIR, "results", "backtest_matches.csv"), dtype={"id": str})
    bt = bt[bt.season.isin([2022, 2023, 2024, 2025])]
    diffs = [abs(out[i][0] - h) + abs(out[i][1] - a) for i, h, a in zip(bt.id, bt.xg_home, bt.xg_away) if i in out]
    print(f"UCL xG vs research/ucl backtest_matches.csv: n={len(diffs)} max abs diff {max(diffs):.2e}")
    return out, fits, m


def goal_dist(lh, la, rho):
    P = ucl_common.dc_matrix(lh, la, rho)
    return P.sum(1), P.sum(0)


# ======================================================= site scorer shares

class SiteShares:
    """ship_ucl.write_scorers + ucl.server.ts uclSquad, as of any date."""

    def __init__(self, um):
        ev = pd.read_csv(os.path.join(UCL_DIR, "data", "events.csv"),
                         dtype={"match_id": str, "team_id": str, "player_id": str})
        ev = ev[(ev.kind == "goal") & ~ev.own.astype(bool)]
        when = pd.to_datetime(um.date, utc=True)
        self.when = dict(zip(um.id, when))
        self.club_matches = defaultdict(list)
        for mid, h, a, w in zip(um.id, um.home_id, um.away_id, when):
            self.club_matches[h].append((w, mid))
            self.club_matches[a].append((w, mid))
        for k in self.club_matches:
            self.club_matches[k].sort()
        self.club_times = {k: [w for w, _ in v] for k, v in self.club_matches.items()}
        self.goals = defaultdict(list)  # (club, match) -> [(player, pen)]
        for mid, tid, pid, pen in zip(ev.match_id, ev.team_id, ev.player_id, ev.pen.astype(bool)):
            self.goals[(tid, mid)].append((pid, bool(pen)))
        self.cache = {}

    def club_goals(self, club, date):
        key = (club, date)
        if key in self.cache:
            return self.cache[key]
        t0 = pd.Timestamp(date, tz="UTC")
        times = self.club_times.get(club, [])
        lo = bisect_left(times, t0 - pd.Timedelta(days=WINDOW))
        hi = bisect_left(times, t0)
        team_w, team_pen, by_player, pen_player = 0.0, 0.0, defaultdict(float), defaultdict(float)
        n_matches = 0
        for w_t, mid in self.club_matches.get(club, [])[lo:hi]:
            if not (w_t > t0 - pd.Timedelta(days=WINDOW)):
                continue
            n_matches += 1
            wt = math.exp(-((t0 - w_t).days) / HALF_LIFE)
            for pid, pen in self.goals.get((club, mid), []):
                team_w += wt
                by_player[pid] += wt
                if pen:
                    team_pen += wt
                    pen_player[pid] += wt
        res = (team_w, by_player, team_pen, pen_player, n_matches)
        self.cache[key] = res
        return res

    def shares(self, club, date, squad):
        """squad: {player_id: position letter}. Returns {pid: share}, raw goals, team goals."""
        team_w, by_player, _, _, _ = self.club_goals(club, date)
        raw = {pid: (by_player.get(pid, 0.0) + SHRINK * POS_PRIOR.get(pos, POS_DEFAULT)) / (team_w + SHRINK)
               for pid, pos in squad.items()}
        tot = sum(raw.values()) or 1.0
        return {pid: v / tot * (1 - OWN_GOAL_SHARE) for pid, v in raw.items()}


# ============================================================ live props port

def new_player():
    return dict(name="", teamId="", pos="", formationPlace=0.0, app=0, start=0, mins=0.0, sh=0.0, sot=0.0,
                goal=0.0, asst=0.0, card=0.0, foul=0.0, hits=dict.fromkeys(MARKET_PRIOR, 0), window=[])


def new_team():
    return dict(gm=0, sh=0.0, goal=0.0, foul=0.0, shA=0.0, goalA=0.0)


def market_hits(r):
    sh, sot, goal, asst, card, foul = r["sh"], r["sot"], r["goal"], r["asst"], r["card"], r["foul"]
    return dict(sh1=sh >= 1, sh2=sh >= 2, sh3=sh >= 3, sot1=sot >= 1, sot2=sot >= 2, goal1=goal >= 1,
                asst1=asst >= 1, ga1=goal + asst >= 1, card1=card >= 1, foul2=foul >= 2)


class Fold:
    """foldSeason() of soccer-props.server.ts, incrementally, match by match."""

    def __init__(self):
        self.players = {}
        self.teams = {}
        self.nrows = 0

    def add_match(self, rows):
        for r in rows:
            p = self.players.get(r["playerId"])
            if p is None:
                p = new_player()
                self.players[r["playerId"]] = p
            p["name"] = r["name"] or p["name"]
            p["teamId"] = r["teamId"] or p["teamId"]
            p["pos"] = r["pos"] or p["pos"]
            p["formationPlace"] = r["formationPlace"] or p["formationPlace"]
            p["app"] += 1
            p["start"] += r["starter"]
            p["mins"] += r["mins"]
            for k in ("sh", "sot", "goal", "asst", "card", "foul"):
                p[k] += r[k]
            for k, v in market_hits(r).items():
                p["hits"][k] += int(v)
            p["window"].append((r["sh"], r["sot"], r["goal"]))
            if len(p["window"]) > WIN6:
                p["window"].pop(0)
        sides = {}
        for r in rows:
            s = sides.get(r["teamId"])
            if s is None:
                s = dict(opp=r["oppId"], sh=0.0, goal=0.0, foul=0.0)
                sides[r["teamId"]] = s
            s["sh"] += r["sh"]
            s["goal"] += r["goal"]
            s["foul"] += r["foul"]
        for tid, s in sides.items():
            t = self.teams.setdefault(tid, new_team())
            t["gm"] += 1
            t["sh"] += s["sh"]
            t["goal"] += s["goal"]
            t["foul"] += s["foul"]
            o = self.teams.setdefault(s["opp"], new_team())
            o["shA"] += s["sh"]
            o["goalA"] += s["goal"]
        self.nrows += len(rows)

    def copy(self):
        import copy
        return copy.deepcopy(self)


def shrunk(num, den, prior, k):
    return (num + k * prior) / (den + k)


def features_for(p, is_home, team, opp, py):
    app = p["app"]
    w = p["window"]
    wg = len(w)
    f = dict(
        sh_pa=shrunk(p["sh"], app, LG["sh"], K_APP),
        sot_pa=shrunk(p["sot"], app, LG["sot"], K_APP),
        goal_pa=shrunk(p["goal"], app, LG["goal"], K_APP),
        asst_pa=shrunk(p["asst"], app, LG["asst"], K_APP),
        card_pa=shrunk(p["card"], app, LG["card"], K_APP),
        foul_pa=shrunk(p["foul"], app, LG["foul"], K_APP),
        conv_rate=shrunk(p["goal"], max(p["sh"], 0), 0.11, 8.0),
        w_sh_pa=shrunk(sum(x[0] for x in w), wg, LG["sh"], 4.0),
        w_sot_pa=shrunk(sum(x[1] for x in w), wg, LG["sot"], 4.0),
        w_goal_pa=shrunk(sum(x[2] for x in w), wg, LG["goal"], 4.0),
        w_apps=wg,
        py_sh_pa=shrunk(py["sh"], py["pa"], LG["sh"], K_APP) if py else LG["sh"],
        py_goal_pa=shrunk(py["goal"], py["pa"], LG["goal"], K_APP) if py else LG["goal"],
        py_apps=min(py["pa"], APPS_CAP) if py else 0,
        py_known=1 if py else 0,
        apps=min(app, APPS_CAP),
        start_rate=p["start"] / app,
        mins_avg=p["mins"] / app,
        is_home=is_home,
        pos_fw=1 if p["pos"] in FW else 0,
        pos_mf=1 if p["pos"] in MF else 0,
        pos_df=1 if p["pos"] in DF else 0,
        pos_gk=1 if p["pos"] == "G" else 0,
        formation_place=p["formationPlace"],
        team_sh_pg=team["sh"] / team["gm"],
        team_goals_pg=team["goal"] / team["gm"],
        opp_sh_allowed=opp["shA"] / opp["gm"],
        opp_goals_allowed=opp["goalA"] / opp["gm"],
        opp_fouls_pg=opp["foul"] / opp["gm"],
    )
    for k, prior in MARKET_PRIOR.items():
        f[f"own_{k}"] = shrunk(p["hits"][k], app, prior, K_G)
    return f


def score_market(mk, f):
    z = mk["intercept"]
    for i, name in enumerate(mk["features"]):
        v = f.get(name, 0)
        z += ((v - mk["mean"][i]) / (mk["std"][i] or 1)) * mk["coef"][i]
    raw = 1 / (1 + math.exp(-z))
    c = min(max(raw, 1e-9), 1 - 1e-9)
    lg = math.log(c / (1 - c))
    return 1 / (1 + math.exp(-(mk["plattA"] * lg + mk["plattB"]))), raw


def live_rows(pm):
    """Player rows in the live site's shape (parseSummary)."""
    mins = np.where(pm.starter == 1, np.where(pm.subbed_out == 1, 65.0, 90.0),
                    np.where(pm.subbed_in == 1, 25.0, 0.0))
    df = pd.DataFrame(dict(
        matchId=pm.matchId.astype(str), date=pm.date, playerId=pm.player_id.astype(str), name=pm.name.fillna(""),
        teamId=pm.team_id.astype(str), oppId=pm.opp_id.astype(str), isHome=pm.is_home, pos=pm.pos.fillna(""),
        starter=pm.starter, formationPlace=pm.formation_place.fillna(0), mins=mins,
        sh=pm.totalShots, sot=pm.shotsOnTarget, goal=pm.totalGoals, asst=pm.goalAssists,
        card=pm.yellowCards + pm.redCards, foul=pm.foulsCommitted, season=pm.season, comp=pm.comp))
    return df


def model_predictions(pm, parity_dates):
    """{(matchId, playerId): dict(model_p, gate flags, features)} for domestic starters."""
    out = {}
    parity = []
    lr_all = live_rows(pm[pm.comp.isin(DOMESTIC)])
    for comp, slug in DOMESTIC.items():
        mk = PROPS[slug]["markets"]["goal1"]
        L = lr_all[lr_all.comp == comp]
        for S in SEASONS:
            last = L[L.season == S - 1].sort_values(["date", "matchId"], kind="stable")
            this = L[L.season == S].sort_values(["date", "matchId"], kind="stable")
            if this.empty:
                continue
            py = {}
            for r in last.itertuples():
                q = py.setdefault(r.playerId, dict(pa=0, sh=0.0, goal=0.0))
                q["pa"] += 1
                q["sh"] += r.sh
                q["goal"] += r.goal
            both = Fold()
            for _, g in last.groupby("matchId", sort=False):
                both.add_match(g.to_dict("records"))
            only = Fold()
            this_rows = 0
            starters = this[this.starter == 1]
            for date, day in this.groupby("date", sort=True):
                state = both if this_rows < 600 else only
                for r in starters[starters.date == date].itertuples():
                    p = state.players.get(r.playerId)
                    team = state.teams.get(r.teamId)
                    opp = state.teams.get(r.oppId)
                    rec = dict(gate_team=int(bool(team and opp and team["gm"] >= 3 and opp["gm"] >= 3)),
                               gate_player=0, early_rule=int(this_rows < 600))
                    if p is not None:
                        rec["gate_player"] = int(p["app"] >= 3 and p["start"] / p["app"] >= 0.5
                                                 and p["teamId"] == r.teamId)
                        rec["live_apps"] = p["app"]
                        rec["live_start_rate"] = p["start"] / p["app"]
                    if p is not None and team and opp and team["gm"] > 0 and opp["gm"] > 0:
                        f = features_for(p, r.isHome, team, opp, py.get(r.playerId))
                        prob, raw = score_market(mk, f)
                        rec["model_p"] = prob
                        rec["model_raw"] = raw
                        for k in mk["features"]:
                            rec["f_" + k] = f[k]
                    out[(r.matchId, r.playerId)] = rec
                if (comp, date) in parity_dates:
                    rows_before = (pd.concat([last, this[this.date < date]]) if this_rows < 600
                                   else this[this.date < date])
                    cands = [dict(matchId=r.matchId, playerId=r.playerId, teamId=r.teamId, oppId=r.oppId,
                                  isHome=int(r.isHome), p=out[(r.matchId, r.playerId)].get("model_p"))
                             for r in starters[starters.date == date].itertuples()]
                    parity.append(dict(league=slug, date=date,
                                       rows=rows_before.drop(columns=["season", "comp"]).to_dict("records"),
                                       last=last.drop(columns=["season", "comp"]).to_dict("records"),
                                       candidates=cands))
                for _, g in day.groupby("matchId", sort=True):
                    recs = g.to_dict("records")
                    if this_rows < 600:
                        both.add_match(recs)
                    only.add_match(recs)
                    this_rows += len(recs)
        print(f"  model features: {comp} done", flush=True)
    return out, parity


# ======================================================= player history sums

class History:
    """Recency-weighted (half-life 180 d) sums over a player's matches in data/,
    window (D-400, D), computed with prefix sums of exp(day/180)."""

    def __init__(self, pm, key_cols, value_cols, mask=None):
        df = pm if mask is None else pm[mask]
        df = df.sort_values("dnum", kind="stable")
        self.index = {}
        for key, g in df.groupby(key_cols, sort=False):
            d = g.dnum.values
            e = np.exp(d / HALF_LIFE)
            sums = {c: np.concatenate([[0.0], np.cumsum(e * g[c].values.astype(float))]) for c in value_cols}
            sums["_w"] = np.concatenate([[0.0], np.cumsum(e)])
            sums["_n"] = np.arange(len(d) + 1, dtype=float)
            self.index[key] = (d, sums)

    def get(self, key, dnum):
        hit = self.index.get(key)
        if hit is None:
            return None
        d, sums = hit
        lo = np.searchsorted(d, dnum - WINDOW + 1, "left")    # d > dnum - 400
        hi = np.searchsorted(d, dnum, "left")                 # d < dnum
        if hi <= lo:
            return None
        f = math.exp(-dnum / HALF_LIFE)
        return {c: (s[hi] - s[lo]) * (f if c != "_n" else 1.0) for c, s in sums.items()}


def main():
    pm = pd.read_csv(os.path.join(DATA, "player_matches.csv.gz"), keep_default_na=False, na_values=[""],
                     dtype={"matchId": str, "team_id": str, "opp_id": str, "player_id": str})
    md = pd.read_csv(os.path.join(DATA, "matches.csv"), dtype={"matchId": str, "home_id": str, "away_id": str})
    pm["dnum"] = day_num(pm.date)
    pm["letter"] = [slot_letter(s) for s in pm.pos]
    print(f"player rows {len(pm):,}, matches {len(md):,}")

    # ---------------- team goal rates
    rates, fits, um = team_goal_rates(md)
    miss = md[~md.matchId.isin(rates) & md.season.isin(SEASONS)]
    print(f"matches without a goal rate: {len(miss)} ({miss.comp.value_counts().to_dict()})")

    # ---------------- positions (as of each date): modal starting slot letter so far
    st = pm[(pm.starter == 1) & (pm.letter != "")].sort_values(["dnum", "matchId"])
    pos_hist = defaultdict(list)  # player -> [(dnum, letter)]
    for pid, dn, le in zip(st.player_id, st.dnum, st.letter):
        pos_hist[pid].append((dn, le))

    def pos_asof(pid, dnum, today=""):
        h = pos_hist.get(pid, [])
        cnt = defaultdict(int)
        for dn, le in h:
            if dn >= dnum:
                break
            cnt[le] += 1
        if today:
            cnt[today] += 1
        return max(cnt.items(), key=lambda kv: (kv[1], kv[0]))[0] if cnt else ""

    # ---------------- position priors for the exposure-based share and m (pre-2024 data only)
    base = pm[(pm.season <= 2023) & (pm.mins > 0)].copy()
    modal = base[base.starter == 1].groupby("player_id").letter.agg(lambda s: s[s != ""].mode().iat[0]
                                                                    if (s != "").any() else "")
    base["mlet"] = base.player_id.map(modal).fillna("")
    prior_on = (base.groupby("mlet").goals90.sum() / base.groupby("mlet").team_goals_on.sum()).to_dict()
    sb = base[base.starter == 1]
    mbar = sb.groupby("mlet").expo.mean().to_dict()
    mbar_all = float(sb.expo.mean())
    per90_prior = (base.groupby("mlet").goals90.sum() / (base.groupby("mlet").mins.sum() / 90)).to_dict()
    print("prior_on (goals per on-pitch team goal):", {k: round(v, 4) for k, v in prior_on.items()})
    print("mean starter exposure:", {k: round(v, 3) for k, v in mbar.items()}, round(mbar_all, 3))
    print("goals per 90 prior:", {k: round(v, 4) for k, v in per90_prior.items()})

    # ---------------- history sums
    pm["is_start"] = pm.starter
    pm["expo_start"] = pm.expo * pm.starter
    pm["mins90"] = pm.mins / 90.0
    pm["played"] = (pm.mins > 0).astype(int)
    hist_player = History(pm, "player_id",
                          ["goals90", "pens90", "mins90", "totalShots", "shotsOnTarget", "is_start",
                           "expo_start", "played"])
    hist_club = History(pm, ["player_id", "team_id"], ["goals90", "team_goals_on", "expo", "played", "is_start"])

    # ---------------- squads (named in a match-day squad of the club in the last 120 days)
    named = pm[["team_id", "player_id", "dnum"]].drop_duplicates()
    squad_idx = defaultdict(list)
    for tid, g in named.sort_values("dnum").groupby("team_id"):
        squad_idx[tid] = (g.dnum.values, g.player_id.values)

    shares = SiteShares(um)

    # ---------------- model (live port) for domestic starters
    par_dates = {("eng.1", "2025-12-26"), ("ita.1", "2025-08-24"), ("ger.1", "2026-03-14"),
                 ("esp.1", "2026-09-20"), ("fra.1", "2025-10-05")}
    model, parity = model_predictions(pm, par_dates)
    json.dump(parity, open(os.path.join(DATA, "parity_sample.json"), "w"))

    # ---------------- candidates
    starters = pm[(pm.starter == 1) & pm.season.isin(SEASONS)]
    by_match = {mid: g for mid, g in pm[pm.season.isin(SEASONS)].groupby("matchId")}
    mrow = md.set_index("matchId")
    rows = []
    share_cache = {}
    for k, r in enumerate(starters.itertuples()):
        mid, pid, tid, oid = r.matchId, r.player_id, r.team_id, r.opp_id
        mt = mrow.loc[mid]
        rate = rates.get(mid)
        rec = dict(matchId=mid, comp=r.comp, league=r.league, season=r.season, date=r.date, team_id=tid,
                   opp_id=oid, player_id=pid, name=r.name, slot=r.pos, is_home=r.is_home,
                   formation_place=r.formation_place, mins=r.mins, expo=r.expo, subbed_out=r.subbed_out,
                   goals90=r.goals90, y=int(r.goals90 > 0), espn_goal1=int(r.totalGoals >= 1), og=r.og,
                   et=int(mt.et))
        # ---- team goal distribution
        if rate is not None:
            lh, la, rho = rate
            gh, ga = goal_dist(lh, la, rho)
            lam_t, lam_o = (lh, la) if r.is_home else (la, lh)
            dist = gh if r.is_home else ga
            rec.update(lam_team=lam_t, lam_opp=lam_o, rho=rho, p_team_scores=float(1 - dist[0]))
        else:
            dist = None
        # ---- site share (squad = named in the last 120 days + today's squad)
        key = (tid, r.date, mid)
        if key not in share_cache:
            dn, pids = squad_idx.get(tid, (np.array([]), np.array([])))
            lo = np.searchsorted(dn, r.dnum - SQUAD_DAYS, "left")
            hi = np.searchsorted(dn, r.dnum, "left")
            sq_ids = set(pids[lo:hi]) | set(by_match[mid][by_match[mid].team_id == tid].player_id)
            today = by_match[mid].set_index("player_id")
            squad = {}
            for q in sq_ids:
                t_slot = ""
                if q in today.index and today.loc[q, "team_id"] == tid and today.loc[q, "starter"] == 1:
                    t_slot = slot_letter(today.loc[q, "pos"])
                squad[q] = pos_asof(q, r.dnum, t_slot)
            share_cache[key] = (shares.shares(tid, r.date, squad), squad, len(sq_ids))
        sh_map, squad, nsq = share_cache[key]
        team_w, by_player, team_pen, pen_player, n_club = shares.club_goals(tid, r.date)
        s_site = sh_map.get(pid, 0.0)
        letter = squad.get(pid, "")
        rec.update(s_site=s_site, raw_goals_w=by_player.get(pid, 0.0), team_goals_w=team_w, squad_n=nsq,
                   club_matches_400=n_club, pos_letter=letter,
                   pen_w=pen_player.get(pid, 0.0), team_pen_w=team_pen,
                   pen_share=pen_player.get(pid, 0.0) / (team_pen + 0.5))
        # ---- exposure-based share and m
        hc = hist_club.get((pid, tid), r.dnum) or {}
        hp = hist_player.get(pid, r.dnum) or {}
        p_on = prior_on.get(letter, prior_on.get("", 0.05))
        g_on, t_on = hc.get("goals90", 0.0), hc.get("team_goals_on", 0.0)
        s_on = (g_on + SHRINK * p_on) / (t_on + SHRINK)
        ws, es = hp.get("is_start", 0.0), hp.get("expo_start", 0.0)
        m_prior = mbar.get(letter, mbar_all)
        m_start = (es + 2.0 * m_prior) / (ws + 2.0)
        g90w, m90w = hp.get("goals90", 0.0), hp.get("mins90", 0.0)
        pr90 = per90_prior.get(letter, per90_prior.get("", 0.1))
        rec.update(s_on=s_on, goals_on_w=g_on, team_goals_on_w=t_on, m_start=m_start, starts_w=ws,
                   starts_n=hp.get("_n", 0.0), played_w=hp.get("played", 0.0),
                   g90_rate=(g90w + 3.0 * pr90) / (m90w + 3.0), mins90_w=m90w,
                   sh90_rate=(hp.get("totalShots", 0.0) + 3.0 * 1.0) / (m90w + 3.0),
                   sot90_rate=(hp.get("shotsOnTarget", 0.0) + 3.0 * 0.35) / (m90w + 3.0),
                   pens_w=hp.get("pens90", 0.0), club_played_w=hc.get("played", 0.0),
                   club_expo_w=hc.get("expo", 0.0))
        # ---- sim probabilities (closed form over the DC marginal)
        if dist is not None:
            g = np.arange(len(dist))
            for name, s in (("sim_site", s_site), ("sim_site_m", s_site * m_start), ("sim_on", s_on * m_start)):
                s = min(max(s, 0.0), 0.999)
                rec[name] = float(np.sum(dist * (1 - (1 - s) ** g)))
        # ---- model (domestic)
        rec.update(model.get((mid, pid), {}))
        rows.append(rec)
        if (k + 1) % 20000 == 0:
            print(f"  candidates {k + 1:,}/{len(starters):,}", flush=True)

    C = pd.DataFrame(rows)
    # Lineup-aware variant of the site's shares: keep the site's RELATIVE shares
    # but rescale the announced XI so its shares sum to the fraction of a team's
    # goals that starters actually score (measured on 2021-22..2023-24 only).
    tg = base.groupby(["matchId", "team_id"]).goals90.sum()
    og_for = base.groupby(["matchId", "opp_id"]).og.sum()
    sg = base[base.starter == 1].groupby(["matchId", "team_id"]).goals90.sum()
    xi_target = float(sg.sum() / (tg.sum() + og_for.sum()))
    print(f"starters' share of all team goals (incl. own goals for), 2021-23: {xi_target:.4f}")
    xi_sum = C.groupby(["matchId", "team_id"]).s_site.transform("sum")
    C["s_xi"] = C.s_site * xi_target / xi_sum
    sims = []
    for r in C[["matchId", "lam_team", "lam_opp", "rho", "is_home", "s_xi"]].itertuples():
        if r.matchId not in rates:
            sims.append(np.nan)
            continue
        lh, la, rho = rates[r.matchId]
        gh, ga = goal_dist(lh, la, rho)
        dist = gh if r.is_home else ga
        g = np.arange(len(dist))
        sims.append(float(np.sum(dist * (1 - (1 - min(r.s_xi, 0.999)) ** g))))
    C["sim_xi"] = sims
    C.to_csv(os.path.join(DATA, "candidates.csv.gz"), index=False, compression="gzip")
    json.dump(dict(goal_fits=fits, prior_on=prior_on, m_bar=mbar, m_bar_all=mbar_all, per90_prior=per90_prior,
                   squad_days=SQUAD_DAYS, xi_target=xi_target),
              open(os.path.join(DATA, "feature_constants.json"), "w"), indent=1)
    print(f"candidates: {len(C):,}")
    print(C.groupby(["comp", "season"]).agg(n=("y", "size"), y=("y", "mean"), sim=("sim_site", "mean"),
                                            model=("model_p", "mean"), gate=("gate_player", "mean")).round(4))


if __name__ == "__main__":
    main()
