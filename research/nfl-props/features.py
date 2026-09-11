"""
Feature construction for the NFL player-prop models.

One rule governs everything here: a feature may only use games that finished
STRICTLY BEFORE the game being predicted. Rows are walked in date order and a
player's history is sliced at their own index, so there is no way for a game to
see itself.

Windows are TRAILING GAMES, not season-to-date, and they cross the season
boundary. That is the deliberate choice of this module. Season-to-date is empty
in Week 1 — the exact hole that left the touchdown board blank on opening night
— whereas "the last eight games" is always defined, and in Week 1 it is simply
last season's last eight. `season_gp` says how many of the window's games are
from this season, so the model can learn how much to discount a stale one.

The window is anchored to the TEAM's last W_LONG games, and a player's history
is his appearances inside it. Anchoring to the player's own last eight
appearances is the more natural reading, but it is unbounded — a back who
missed six weeks would need fourteen games fetched to fill it, and the live
server cannot pull an unbounded number of box scores per team. Anchoring to the
team also makes `hist_g` do real work: eight appearances in the team's last
eight is a workhorse, three is a man who has been hurt.

The same windows are recomputed live in src/lib/nfl-props.server.ts. If you
change a definition here, change it there, and regenerate the selftest vectors
in the exported model so the two stay provably in step.
"""
import os, csv
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

W_SHORT = 3      # "recent form" window, in games
W_LONG = 8       # "a season of football" window, in games

# Shrinkage: a rate is pulled toward the league mean until the denominator earns
# its own_l number. K is roughly "how many attempts before we half-believe you".
LG = {"ypc": 4.30, "ypr": 11.0, "catch": 0.645, "ypa": 7.00, "cmp": 0.645}
K = {"ypc": 40, "ypr": 20, "catch": 15, "ypa": 60, "cmp": 60, "own_l": 6}

DEFAULT_TOTAL = 44.5


def shrink(num, den, prior, k):
    return (num + k * prior) / (den + k) if (den + k) > 0 else prior


# --------------------------------------------------------------- the markets
# kind decides which feature set a market is priced with; `pred` is the event.
MARKETS = {
    "rec3":     ("skill", "3+ receptions",       lambda r: r["rec"] >= 3),
    "rec5":     ("skill", "5+ receptions",       lambda r: r["rec"] >= 5),
    "rec7":     ("skill", "7+ receptions",       lambda r: r["rec"] >= 7),
    "recy40":   ("skill", "40+ receiving yards", lambda r: r["cy"] >= 40),
    "recy60":   ("skill", "60+ receiving yards", lambda r: r["cy"] >= 60),
    "recy80":   ("skill", "80+ receiving yards", lambda r: r["cy"] >= 80),
    "rushy40":  ("skill", "40+ rushing yards",   lambda r: r["ry"] >= 40),
    "rushy60":  ("skill", "60+ rushing yards",   lambda r: r["ry"] >= 60),
    "rushy80":  ("skill", "80+ rushing yards",   lambda r: r["ry"] >= 80),
    "scrim60":  ("skill", "60+ scrimmage yards", lambda r: r["ry"] + r["cy"] >= 60),
    "scrim90":  ("skill", "90+ scrimmage yards", lambda r: r["ry"] + r["cy"] >= 90),
    "passy225": ("qb",    "225+ passing yards",  lambda r: r["py"] >= 225),
    "passy275": ("qb",    "275+ passing yards",  lambda r: r["py"] >= 275),
    "passtd2":  ("qb",    "2+ passing TDs",      lambda r: r["ptd"] >= 2),
}

SKILL_FEATURES = [
    "hist_g", "season_gp",
    "car_pg_s", "car_pg_l", "tgt_pg_s", "tgt_pg_l", "rec_pg_l",
    "ry_pg_s", "ry_pg_l", "cy_pg_s", "cy_pg_l", "scrim_pg_l",
    "ypc", "ypr", "catch",
    "carry_share", "target_share",
    "team_plays_pg", "team_pass_rate",
    "opp_rush_ypg", "opp_pass_ypg",
    "is_home", "mkt_total", "mkt_implied_total", "mkt_margin", "mkt_known",
    "own_l", "own_s",
]
QB_FEATURES = [
    "hist_g", "season_gp",
    "patt_pg_s", "patt_pg_l", "py_pg_s", "py_pg_l", "ptd_pg_l", "int_pg_l",
    "ypa", "cmp_pct",
    "team_plays_pg", "team_pass_rate", "opp_pass_ypg",
    "is_home", "mkt_total", "mkt_implied_total", "mkt_margin", "mkt_known",
    "own_l", "own_s",
]
FEATURES = {"skill": SKILL_FEATURES, "qb": QB_FEATURES}

# A row only trains (and only shows) when there is enough usage behind it to be
# talking about a real contributor rather than a special-teamer with one carry.
MIN_SKILL_TOUCHES = 10   # carries + targets over the long window
MIN_QB_ATTEMPTS = 30
MIN_GAMES = 2


# ------------------------------------------------------------------ loading
def _num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def load():
    def rd(name):
        with open(os.path.join(DATA_DIR, name)) as f:
            return list(csv.DictReader(f))

    players, teams, games = rd("player_games.csv"), rd("team_games.csv"), rd("games.csv")
    for r in players:
        for k in ("car", "ry", "rtd", "tgt", "rec", "cy", "ctd", "patt", "cmp", "py", "ptd", "intc"):
            r[k] = _num(r[k])
        r["season"], r["week"], r["is_home"] = int(r["season"]), int(r["week"]), int(r["is_home"])
    for r in teams:
        for k in ("car", "ry", "tgt", "rec", "cy", "patt", "py", "rtd", "ctd", "pts"):
            r[k] = _num(r[k])
        r["season"], r["week"] = int(r["season"]), int(r["week"])
    for r in games:
        r["season"], r["week"] = int(r["season"]), int(r["week"])
        r["total"] = _num(r["total"], 0.0)
        r["home_spread"] = _num(r["home_spread"], 0.0)
    return players, teams, games


def _sum(rows, keys):
    out = {k: 0.0 for k in keys}
    for r in rows:
        for k in keys:
            out[k] += r[k]
    return out


P_KEYS = ("car", "ry", "tgt", "rec", "cy", "patt", "cmp", "py", "ptd", "intc")
T_KEYS = ("car", "ry", "tgt", "rec", "cy", "patt", "py")


def market_ctx(game, is_home):
    """Total, the team's implied total and its expected margin, from the line."""
    known = 1.0 if game["total"] else 0.0
    total = game["total"] if known else DEFAULT_TOTAL
    hs = game["home_spread"] if known else 0.0
    implied = total / 2 - hs / 2 if is_home else total / 2 + hs / 2
    margin = -hs if is_home else hs
    return total, implied, margin, known


def skill_vector(h_s, h_l, team_window, opp_window, is_home, ctx, season_gp, own_l, own_s):
    g_s, g_l = max(len(h_s), 1), max(len(h_l), 1)
    s_s, s_l = _sum(h_s, P_KEYS), _sum(h_l, P_KEYS)
    t_l = _sum(team_window, T_KEYS)
    t_g = max(len(team_window), 1)
    o_l = _sum(opp_window, T_KEYS)
    o_g = max(len(opp_window), 1)
    total, implied, margin, known = ctx
    team_plays = t_l["car"] + t_l["patt"]
    return [
        min(len(h_l), W_LONG), min(season_gp, W_LONG),
        s_s["car"] / g_s, s_l["car"] / g_l, s_s["tgt"] / g_s, s_l["tgt"] / g_l, s_l["rec"] / g_l,
        s_s["ry"] / g_s, s_l["ry"] / g_l, s_s["cy"] / g_s, s_l["cy"] / g_l,
        (s_l["ry"] + s_l["cy"]) / g_l,
        shrink(s_l["ry"], s_l["car"], LG["ypc"], K["ypc"]),
        shrink(s_l["cy"], s_l["rec"], LG["ypr"], K["ypr"]),
        shrink(s_l["rec"], s_l["tgt"], LG["catch"], K["catch"]),
        s_l["car"] / t_l["car"] if t_l["car"] else 0.0,
        s_l["tgt"] / t_l["tgt"] if t_l["tgt"] else 0.0,
        team_plays / t_g, t_l["patt"] / team_plays if team_plays else 0.55,
        o_l["ry"] / o_g, o_l["py"] / o_g,
        float(is_home), total, implied, margin, known,
        own_l, own_s,
    ]


def qb_vector(h_s, h_l, team_window, opp_window, is_home, ctx, season_gp, own_l, own_s):
    g_s, g_l = max(len(h_s), 1), max(len(h_l), 1)
    s_s, s_l = _sum(h_s, P_KEYS), _sum(h_l, P_KEYS)
    t_l = _sum(team_window, T_KEYS)
    t_g = max(len(team_window), 1)
    o_l = _sum(opp_window, T_KEYS)
    o_g = max(len(opp_window), 1)
    total, implied, margin, known = ctx
    team_plays = t_l["car"] + t_l["patt"]
    return [
        min(len(h_l), W_LONG), min(season_gp, W_LONG),
        s_s["patt"] / g_s, s_l["patt"] / g_l, s_s["py"] / g_s, s_l["py"] / g_l,
        s_l["ptd"] / g_l, s_l["intc"] / g_l,
        shrink(s_l["py"], s_l["patt"], LG["ypa"], K["ypa"]),
        shrink(s_l["cmp"], s_l["patt"], LG["cmp"], K["cmp"]),
        team_plays / t_g, t_l["patt"] / team_plays if team_plays else 0.55,
        o_l["py"] / o_g,
        float(is_home), total, implied, margin, known,
        own_l, own_s,
    ]


def build(base_rates=None):
    """Every usable (player, game) row, with both label set and feature vector.

    `base_rates` is the prior each market's own-rate feature shrinks toward. On
    the first pass it is unknown, so call once with None to measure it from the
    data, then again with the measured rates — that is what train.py does.
    """
    players, teams, games = load()
    game_by_id = {g["eid"]: g for g in games}

    by_player = defaultdict(list)
    for r in sorted(players, key=lambda r: (r["date"], r["eid"])):
        by_player[r["player_id"]].append(r)
    by_team = defaultdict(list)
    team_by_key = {}
    for r in sorted(teams, key=lambda r: (r["date"], r["eid"])):
        by_team[r["team"]].append(r)
        team_by_key[(r["eid"], r["team"])] = r
    # What a defence gave up = what its opponent put up in the same game.
    allowed = defaultdict(list)
    for r in sorted(teams, key=lambda r: (r["date"], r["eid"])):
        opp_row = team_by_key.get((r["eid"], r["opp"]))
        if opp_row:
            allowed[r["team"]].append(opp_row)

    team_index = {t: {r["eid"]: i for i, r in enumerate(rows)} for t, rows in by_team.items()}
    rates = base_rates or {k: 0.2 for k in MARKETS}
    out = []

    for pid, rows in by_player.items():
        for i, r in enumerate(rows):
            g = game_by_id.get(r["eid"])
            if not g:
                continue
            ti = team_index.get(r["team"], {}).get(r["eid"])
            oi = team_index.get(r["opp"], {}).get(r["eid"])
            if ti is None or oi is None:
                continue
            team_window = by_team[r["team"]][max(0, ti - W_LONG):ti]
            opp_window = allowed[r["opp"]][max(0, oi - W_LONG):oi]
            if not team_window or not opp_window:
                continue

            # The player's appearances inside the team's window, long and short.
            long_ids = {w["eid"] for w in team_window}
            short_ids = {w["eid"] for w in by_team[r["team"]][max(0, ti - W_SHORT):ti]}
            hist = rows[:i]
            h_l = [h for h in hist if h["eid"] in long_ids]
            h_s = [h for h in hist if h["eid"] in short_ids]
            if len(h_l) < MIN_GAMES:
                continue
            s_l = _sum(h_l, P_KEYS)
            season_gp = sum(1 for w in team_window if w["season"] == r["season"])
            ctx = market_ctx(g, r["is_home"])
            kinds = set()
            if s_l["car"] + s_l["tgt"] >= MIN_SKILL_TOUCHES:
                kinds.add("skill")
            if s_l["patt"] >= MIN_QB_ATTEMPTS:
                kinds.add("qb")
            if not kinds:
                continue

            row = {"eid": r["eid"], "season": r["season"], "week": r["week"], "date": r["date"],
                   "player_id": pid, "player": r["player"], "team": r["team"], "opp": r["opp"],
                   "kinds": kinds, "x": {}, "y": {}, "histG": len(h_l)}
            for key, (kind, _label, pred) in MARKETS.items():
                if kind not in kinds:
                    continue
                own_l = shrink(sum(1 for h in h_l if pred(h)), len(h_l), rates[key], K["own_l"])
                own_s = shrink(sum(1 for h in h_s if pred(h)), len(h_s), rates[key], K["own_l"])
                vec = (skill_vector if kind == "skill" else qb_vector)(
                    h_s, h_l, team_window, opp_window, r["is_home"], ctx,
                    season_gp, own_l, own_s)
                row["x"][key] = vec
                row["y"][key] = int(pred(r))
            out.append(row)

    out.sort(key=lambda r: (r["date"], r["eid"], r["player_id"]))
    return out
