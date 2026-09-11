"""
Does knowing who is out actually improve the prop numbers?

The models are fit on usage a player accumulated while the whole offence was
healthy. When a team's lead back is ruled out, the backup's trailing carries
understate what he is about to get, and the model quietly projects the depth
chart that no longer exists. The app's answer is to renormalize usage over the
players who are actually available. This script measures whether that helps,
because "it obviously should" is not a measurement.

Absence is read from the box score: a player who cleared the usage bar over his
trailing window, was active in his team's recent games, and then recorded no
offensive touch at all, did not play. That is the same fact the live injury
report gives us before kickoff — here it is recovered afterwards so it can be
scored against outcomes.

Reported on the held-out 2025 season, restricted to the games where somebody
who mattered was actually missing, since those are the only games where the
adjustment does anything.

    python3 research/nfl-props/injury_study.py
"""
import os, json
from collections import defaultdict
import numpy as np
from sklearn.metrics import roc_auc_score, log_loss

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "nfl-props-model.json"))
OUT = os.path.join(HERE, "injury_metrics.json")
TRAIN_SEASONS = {2021, 2022, 2023, 2024}
TEST_SEASONS = {2025}

# How far a projection may be scaled up when team-mates are out. A backup does
# inherit the carries, but nobody inherits all of them: game script changes, a
# third back appears, the offence throws more. Uncapped renormalization turns a
# 3-carry-a-game reserve into a bell-cow and prints nonsense.
MAX_BOOST = 1.75  # default; the sweep below picks the shipped value
# Only a player who was part of the recent rotation can be "missing" — a fourth
# receiver who has not played since October is not news.
RECENT_TEAM_GAMES = 3

SKILL = F.SKILL_FEATURES
I_CAR6, I_CAR17 = SKILL.index("car_pg_s"), SKILL.index("car_pg_l")
I_TGT6, I_TGT17 = SKILL.index("tgt_pg_s"), SKILL.index("tgt_pg_l")
I_REC17 = SKILL.index("rec_pg_l")
I_RY6, I_RY17 = SKILL.index("ry_pg_s"), SKILL.index("ry_pg_l")
I_CY6, I_CY17 = SKILL.index("cy_pg_s"), SKILL.index("cy_pg_l")
I_SCRIM = SKILL.index("scrim_pg_l")
I_CSHARE, I_TSHARE = SKILL.index("carry_share"), SKILL.index("target_share")


def infer(m, x):
    z = m["intercept"] + float(np.dot((np.array(x) - np.array(m["mean"])) / np.array(m["std"]),
                                      m["coef"]))
    raw = 1 / (1 + np.exp(-z))
    lg = np.log(raw / (1 - raw))
    return float(1 / (1 + np.exp(-(m["plattA"] * lg + m["plattB"]))))


def boosts(rows_in_game, absent_ids):
    """Per team: how much the available players' carry and target projections
    scale up once the absent players' share is taken off the board."""
    by_team = defaultdict(list)
    for r in rows_in_game:
        by_team[r["team"]].append(r)
    out = {}
    for team, rows in by_team.items():
        tot_car = sum(r["x"]["_car_l"] for r in rows)
        tot_tgt = sum(r["x"]["_tgt_l"] for r in rows)
        av_car = sum(r["x"]["_car_l"] for r in rows if r["player_id"] not in absent_ids)
        av_tgt = sum(r["x"]["_tgt_l"] for r in rows if r["player_id"] not in absent_ids)
        out[team] = (tot_car / av_car if av_car > 0 else 1.0,
                     tot_tgt / av_tgt if av_tgt > 0 else 1.0)
    return out


def adjust(x, bc, bt, alpha=1.0, cap=MAX_BOOST):
    """`alpha` is how completely the freed usage transfers. 1.0 assumes perfect
    substitution — every carry the missing back would have had goes to the men
    left standing, in proportion to what they already do. Anything less says
    some of it evaporates into a changed game plan, which is the thing this
    script is here to measure rather than assume."""
    bc = min(cap, max(1.0, bc)) ** alpha
    bt = min(cap, max(1.0, bt)) ** alpha
    v = list(x)
    for i in (I_CAR6, I_CAR17, I_RY6, I_RY17, I_CSHARE):
        v[i] *= bc
    for i in (I_TGT6, I_TGT17, I_REC17, I_CY6, I_CY17, I_TSHARE):
        v[i] *= bt
    v[I_SCRIM] = v[I_RY17] + v[I_CY17]
    return v


def collect(rows_by_game, absent_by_game, model, key, m, alpha, cap):
    """Predicted probability with and without the adjustment, plus outcomes,
    over every game where somebody was missing."""
    base_p, adj_p, ys = [], [], []
    for eid, rs in rows_by_game.items():
        absent = absent_by_game[eid]
        if not absent:
            continue
        bs = boosts(rs, absent)
        for r in rs:
            if key not in r["x"] or r["player_id"] in absent:
                continue  # an absent player is removed from the board entirely
            bc, bt = bs[r["team"]]
            base_p.append(infer(m, r["x"][key]))
            adj_p.append(infer(m, adjust(r["x"][key], bc, bt, alpha, cap)))
            ys.append(r["y"][key])
    return np.array(base_p), np.array(adj_p), np.array(ys)


def score(rows_by_game, absent_by_game, model, alpha, cap):
    """Mean logloss change across the skill markets. Negative is an improvement."""
    deltas, n = [], 0
    for key, m in model["markets"].items():
        if m["kind"] != "skill":
            continue
        b, a, y = collect(rows_by_game, absent_by_game, model, key, m, alpha, cap)
        if len(y) < 400 or len(set(y)) < 2:
            continue
        deltas.append(log_loss(y, a) - log_loss(y, b))
        n = len(y)
    return (float(np.mean(deltas)) if deltas else 0.0), n


def prepare(seasons, model, rates):
    """Rows for one set of seasons, and who was genuinely missing.

    A player who did not play has no box-score line, so he is invisible to
    features.build(). The candidate set is rebuilt here from the depth chart as
    it stood going in — everyone who played for this team in its last few games
    and cleared the usage bar — and anyone on that list without a line in this
    game did not take the field. Those players get a synthesized row (every
    market a loss, because a man on the inactive list records nothing), which is
    what makes it possible to count the picks the board would have wasted on
    them.
    """
    players, teams, games = F.load()
    game_by_id = {g["eid"]: g for g in games}

    by_player = defaultdict(list)
    for r in sorted(players, key=lambda r: (r["date"], r["eid"])):
        by_player[r["player_id"]].append(r)
    by_team, team_by_key = defaultdict(list), {}
    for r in sorted(teams, key=lambda r: (r["date"], r["eid"])):
        by_team[r["team"]].append(r)
        team_by_key[(r["eid"], r["team"])] = r
    allowed = defaultdict(list)
    for r in sorted(teams, key=lambda r: (r["date"], r["eid"])):
        opp_row = team_by_key.get((r["eid"], r["opp"]))
        if opp_row:
            allowed[r["team"]].append(opp_row)
    team_index = {t: {r["eid"]: i for i, r in enumerate(rows)} for t, rows in by_team.items()}
    player_index = {p: {r["eid"]: i for i, r in enumerate(rows)} for p, rows in by_player.items()}

    appeared = defaultdict(set)
    roster_of = defaultdict(dict)  # (eid, team) -> {player_id: name}
    for p in players:
        appeared[p["eid"]].add(p["player_id"])
        roster_of[(p["eid"], p["team"])][p["player_id"]] = p["player"]

    def make_row(pid, name, team, opp, is_home, eid, season, week, date, played):
        """One feature row, for a player who played or one who did not."""
        g = game_by_id.get(eid)
        ti = team_index.get(team, {}).get(eid)
        oi = team_index.get(opp, {}).get(eid)
        if not g or ti is None or oi is None:
            return None
        team_window = by_team[team][max(0, ti - F.W_LONG):ti]
        opp_window = allowed[opp][max(0, oi - F.W_LONG):oi]
        if not team_window or not opp_window:
            return None
        # Same anchoring as features.py: the player's appearances inside the
        # team's window, so a row here means the same thing a training row did.
        long_ids = {w["eid"] for w in team_window}
        short_ids = {w["eid"] for w in by_team[team][max(0, ti - F.W_SHORT):ti]}
        hist = [h for h in by_player[pid] if h["date"] < date]
        h_l = [h for h in hist if h["eid"] in long_ids]
        h_s = [h for h in hist if h["eid"] in short_ids]
        if len(h_l) < F.MIN_GAMES:
            return None
        s_l = F._sum(h_l, F.P_KEYS)
        if s_l["car"] + s_l["tgt"] < F.MIN_SKILL_TOUCHES:
            return None
        season_gp = sum(1 for w in team_window if w["season"] == season)
        ctx = F.market_ctx(g, is_home)
        row = {"eid": eid, "season": season, "week": week, "date": date, "player_id": pid,
               "player": name, "team": team, "opp": opp, "played": played, "x": {}, "y": {}}
        for key, (kind, _lab, pred) in F.MARKETS.items():
            if kind != "skill":
                continue
            own_l = F.shrink(sum(1 for h in h_l if pred(h)), len(h_l), rates[key], F.K["own_l"])
            own_s = F.shrink(sum(1 for h in h_s if pred(h)), len(h_s), rates[key], F.K["own_l"])
            row["x"][key] = F.skill_vector(h_s, h_l, team_window, opp_window, is_home, ctx,
                                           season_gp, own_l, own_s)
            row["y"][key] = int(pred(played)) if played else 0
        row["x"]["_car_l"] = s_l["car"] / max(len(h_l), 1)
        row["x"]["_tgt_l"] = s_l["tgt"] / max(len(h_l), 1)
        return row

    by_game, absent_by_game = defaultdict(list), {}
    for tr in teams:
        if tr["season"] not in seasons:
            continue
        eid, team, opp = tr["eid"], tr["team"], tr["opp"]
        here = appeared.get(eid, set())
        idx = team_index[team][eid]
        recent = by_team[team][max(0, idx - RECENT_TEAM_GAMES):idx]
        # players who lined up for this team in its last few games
        cands = {}
        for g in recent:
            cands.update(roster_of.get((g["eid"], team), {}))
        absent = set()
        for pid, name in cands.items():
            played = None
            i = player_index.get(pid, {}).get(eid)
            if i is not None and by_player[pid][i]["team"] == team:
                played = by_player[pid][i]
            row = make_row(pid, name, team, opp, tr["is_home"], eid, tr["season"],
                           tr["week"], tr["date"], played)
            if row is None:
                continue
            by_game[eid].append(row)
            if played is None:
                absent.add(pid)
        absent_by_game[eid] = absent_by_game.get(eid, set()) | absent
    for eid in by_game:
        absent_by_game.setdefault(eid, set())
    return by_game, absent_by_game


def main():
    model = json.load(open(MODEL))
    rates = {k: m["base"] for k, m in model["markets"].items()}

    print("building 2021-24 (parameter search) and 2025 (report)")
    tr_games, tr_absent = prepare(TRAIN_SEASONS, model, rates)
    te_games, te_absent = prepare(TEST_SEASONS, model, rates)
    tr_aff = sum(1 for a in tr_absent.values() if a)
    te_aff = sum(1 for a in te_absent.values() if a)
    print(f"  search: {tr_aff}/{len(tr_games)} games with someone missing")
    print(f"  report: {te_aff}/{len(te_games)} games with someone missing")

    print("\nsearching transfer strength on 2021-24 (logloss delta, lower is better)")
    grid = []
    for alpha in (0.0, 0.25, 0.5, 0.75, 1.0):
        for cap in (1.25, 1.5, 1.75, 2.5):
            d, n = score(tr_games, tr_absent, model, alpha, cap)
            grid.append({"alpha": alpha, "cap": cap, "loglossDelta": d})
            print(f"  alpha={alpha:<5} cap={cap:<5} logloss {d:+.5f}")
            if alpha == 0.0:
                break  # alpha 0 is the no-op; the cap cannot matter
    best = min(grid, key=lambda g: g["loglossDelta"])
    print(f"\nbest on the search seasons: alpha={best['alpha']} cap={best['cap']} "
          f"({best['loglossDelta']:+.5f})")

    helps = best["loglossDelta"] < -1e-4 and best["alpha"] > 0
    print("\nheld-out 2025, with the chosen setting:")
    results = {}
    for key, m in model["markets"].items():
        if m["kind"] != "skill":
            continue
        b, a, y = collect(te_games, te_absent, model, key, m, best["alpha"], best["cap"])
        if len(y) < 400 or len(set(y)) < 2:
            continue
        moved = np.abs(a - b) > 0.005
        row = {"n": int(len(y)), "nMoved": int(moved.sum()),
               "aucBefore": float(roc_auc_score(y, b)), "aucAfter": float(roc_auc_score(y, a)),
               "loglossBefore": float(log_loss(y, b)), "loglossAfter": float(log_loss(y, a))}
        results[key] = row
        print(f"  {key:9s} n={row['n']:5d} moved={row['nMoved']:4d} "
              f"auc {row['aucBefore']:.4f}->{row['aucAfter']:.4f} "
              f"logloss {row['loglossBefore']:.4f}->{row['loglossAfter']:.4f}")

    # What the exclusion alone is worth. Every pick the board would have printed
    # for a player who did not take the field is a guaranteed loss: he cannot
    # record a reception or a rushing yard from the inactive list. No model can
    # recover that; only knowing he is out can.
    print("\npicks that would have gone to a player who did not play (2025):")
    dead = {}
    for key, m in model["markets"].items():
        if m["kind"] != "skill":
            continue
        tiers = m.get("tiers") or []
        cut = min((t["minProb"] for t in tiers if t["label"] in ("Strong", "Solid")), default=1.1)
        shown = dead_shown = 0
        for eid, rs in te_games.items():
            absent = te_absent[eid]
            for r in rs:
                if key not in r["x"]:
                    continue
                p = infer(m, r["x"][key])
                if p < cut:
                    continue
                shown += 1
                if r["player_id"] in absent:
                    dead_shown += 1
        dead[key] = {"shown": shown, "dead": dead_shown,
                     "pct": (dead_shown / shown) if shown else 0.0}
        print(f"  {key:9s} {dead_shown:3d} of {shown:5d} Solid-or-better picks "
              f"({100 * dead[key]['pct']:.1f}%)")
    tot_shown = sum(d["shown"] for d in dead.values())
    tot_dead = sum(d["dead"] for d in dead.values())
    print(f"  overall {tot_dead} of {tot_shown} "
          f"({100 * tot_dead / max(tot_shown, 1):.1f}%) would have been dead on arrival")

    d_auc = float(np.mean([r["aucAfter"] - r["aucBefore"] for r in results.values()]))
    d_ll = float(np.mean([r["loglossAfter"] - r["loglossBefore"] for r in results.values()]))
    print(f"\nmean on 2025: AUC {d_auc:+.4f}, logloss {d_ll:+.5f}")
    verdict = ("ship" if helps and d_ll < 0 else "do-not-ship")
    print(f"VERDICT: {verdict} the probability redistribution "
          f"(removing unavailable players from the board is unconditional either way)")

    results["_summary"] = {
        "grid": grid, "chosen": best, "verdict": verdict,
        "meanAucDelta": d_auc, "meanLoglossDelta": d_ll,
        "searchGamesAffected": tr_aff, "searchGames": len(tr_games),
        "testGamesAffected": te_aff, "testGames": len(te_games),
        "recentTeamGames": RECENT_TEAM_GAMES,
        "deadPicks": dead,
        "deadPicksTotal": {"shown": tot_shown, "dead": tot_dead,
                           "pct": tot_dead / max(tot_shown, 1)},
    }
    json.dump(results, open(OUT, "w"), indent=1)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
