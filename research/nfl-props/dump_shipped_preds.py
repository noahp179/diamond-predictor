"""
The frozen, shipped NFL prop model's probability for every player-game the live
board would price, so it can be compared head-to-head with the game simulator.

Nothing is refit. The probabilities come from src/lib/nfl-props-model.json
through the same standardize -> logistic -> Platt that nfl-props.server.ts
`infer` runs, and the feature vectors come from features.py's own functions
(market_ctx, skill_vector, qb_vector, shrink) with the shipped `base` rates as
the own-rate prior, exactly as the live server and dump_expected.py use them.

What is added on top of features.build() is the candidate pool. build() only
walks games a player actually appeared in; the live board prices every player
with an appearance for the team in its last W_LONG games, whether or not he
then plays. So a row is written for each such player (plus anyone who played
for the team in the game itself), and:

  eligible = 1  the board's candidate rules pass: >= MIN_GAMES appearances in
                the team's trailing window and, for the market's kind,
                carries + targets >= MIN_SKILL_TOUCHES (skill) or pass
                attempts >= MIN_QB_ATTEMPTS (qb). This is what the board prices.
  eligible = 0  the player is in the pool but fails those rules (one game in
                the window, or some but too few touches / attempts). Written so
                the comparison can see the model off its own support. A skill
                row needs at least one carry or target in the window; a qb row
                needs at least one attempt AND a QB listing (so a punter's fake
                does not get a passing-yards price).
  y             1/0 from the box score; empty when he has no passing, rushing
                or receiving line in the game (did not play — the board voids).

Players with no appearance in the window (debutants) are not priceable and are
skipped. The live board's roster and injury filters are applied only on the
live day and cannot be rebuilt for past games, so they are not applied here.
`date` is the kickoff's UTC calendar date as fetch_espn.py stores it (night
games read as the next day); join on event_id. `position` comes from the
simulator's research/player-props/data/positions_nfl_{season}.json.

2024 is needed only to fill the trailing windows of early-2025 games. The
cached summaries in research/football-td/data/raw/nfl/*.json.gz can seed the
fetch cache (gunzip each to $ESPN_CACHE/{event_id}.json) to skip refetching.

    ESPN_CACHE=... python3 research/nfl-props/fetch_espn.py 2024 2025 2026
    python3 research/nfl-props/dump_shipped_preds.py            # 2025 2026

Writes research/nfl-props/data/logistic_preds.csv, and prints the selftest
parity, a cross-check against features.build(), and per-market metrics.
"""
import os, sys, csv, json, math
from collections import defaultdict

import numpy as np
from sklearn.metrics import roc_auc_score, brier_score_loss, log_loss

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "nfl-props-model.json"))
METRICS = os.path.join(HERE, "metrics.json")
OUT = os.path.join(F.DATA_DIR, "logistic_preds.csv")
POS_DIR = os.path.abspath(os.path.join(HERE, "..", "player-props", "data"))
POS_CSV = os.path.abspath(os.path.join(HERE, "..", "football-td", "data", "nfl_positions.csv"))

SEASONS = [int(s) for s in (sys.argv[1:] or ["2025", "2026"])]
COLS = ["season", "event_id", "date", "player_id", "player", "team", "position",
        "kind", "market", "p", "y", "eligible"]


def infer(m, x):
    """Standardize -> logistic -> Platt, operation for operation as
    nfl-props.server.ts `infer` (IEEE doubles in the same order)."""
    z = m["intercept"]
    for i in range(len(m["coef"])):
        z += m["coef"][i] * ((x[i] - m["mean"][i]) / m["std"][i])
    if z < -700:            # JS: raw 0 -> logit -inf -> p 0
        return 0.0
    raw = 1 / (1 + math.exp(-z))
    if raw >= 1.0:          # JS: logit +inf -> p 1
        return 1.0
    lg = math.log(raw / (1 - raw))
    return 1 / (1 + math.exp(-(m["plattA"] * lg + m["plattB"])))


def load_positions():
    by_season = {}
    if os.path.isdir(POS_DIR):
        for fn in os.listdir(POS_DIR):
            if fn.startswith("positions_nfl_") and fn.endswith(".json"):
                with open(os.path.join(POS_DIR, fn)) as f:
                    by_season[int(fn[len("positions_nfl_"):-5])] = json.load(f)
    extra = {}
    if os.path.exists(POS_CSV):
        with open(POS_CSV) as f:
            for r in csv.DictReader(f):
                extra[str(r["player_id"])] = r["position"]

    def pos(pid, season):
        order = sorted(by_season, key=lambda s: (abs(s - season), -s))
        for s in order:
            if pid in by_season[s]:
                return by_season[s][pid]
        return extra.get(pid, "")
    return pos


def selftest(model):
    worst, n = 0.0, 0
    for key, cases in model["selftest"].items():
        for c in cases:
            worst = max(worst, abs(infer(model["markets"][key], c["x"]) - c["p"]))
            n += 1
    return worst, n


def pool_rows(model, pos):
    """Every (game, team, player, market) the board's candidate pool covers."""
    rates = {k: m["base"] for k, m in model["markets"].items()}
    players, teams, games = F.load()
    game_by_id = {g["eid"]: g for g in games}

    # -- the same indexes features.build() makes
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

    # who appeared for which team in which game
    box = defaultdict(dict)                     # (eid, team) -> {pid: row}
    for r in players:
        box[(r["eid"], r["team"])][r["player_id"]] = r

    cands = defaultdict(list)                   # (eid, pid) -> [candidate]
    skipped_debut = 0
    for team, trows in by_team.items():
        for ti, t in enumerate(trows):
            if t["season"] not in SEASONS:
                continue
            eid, opp = t["eid"], t["opp"]
            is_home = int(t["is_home"])          # team_games.csv keeps it a string
            g = game_by_id.get(eid)
            oi = team_index.get(opp, {}).get(eid)
            if not g or oi is None:
                continue
            team_window = trows[max(0, ti - F.W_LONG):ti]
            opp_window = allowed[opp][max(0, oi - F.W_LONG):oi]
            if not team_window or not opp_window:
                continue
            long_ids = {w["eid"] for w in team_window}
            short_ids = {w["eid"] for w in trows[max(0, ti - F.W_SHORT):ti]}
            season_gp = sum(1 for w in team_window if w["season"] == t["season"])
            ctx = F.market_ctx(g, is_home)
            today = box.get((eid, team), {})

            pool = set(today)
            for w in team_window:
                pool.update(box.get((w["eid"], team), {}))

            for pid in pool:
                # features.build(): the player's earlier rows inside the team window
                h_l = [h for h in by_player[pid] if h["eid"] in long_ids]
                if not h_l:
                    skipped_debut += 1
                    continue
                h_s = [h for h in h_l if h["eid"] in short_ids]
                s_l = F._sum(h_l, F.P_KEYS)
                touches, attempts = s_l["car"] + s_l["tgt"], s_l["patt"]
                enough_games = len(h_l) >= F.MIN_GAMES
                board = {"skill": touches >= F.MIN_SKILL_TOUCHES and enough_games,
                         "qb": attempts >= F.MIN_QB_ATTEMPTS and enough_games}
                support = {"skill": touches > 0,
                           "qb": attempts > 0 and (board["qb"] or pos(pid, t["season"]) == "QB")}
                played = today.get(pid)
                out = []
                for key, (kind, _label, pred) in F.MARKETS.items():
                    if not support[kind]:
                        continue
                    own_l = F.shrink(sum(1 for h in h_l if pred(h)), len(h_l), rates[key], F.K["own_l"])
                    own_s = F.shrink(sum(1 for h in h_s if pred(h)), len(h_s), rates[key], F.K["own_l"])
                    vec = (F.skill_vector if kind == "skill" else F.qb_vector)(
                        h_s, h_l, team_window, opp_window, is_home, ctx,
                        season_gp, own_l, own_s)
                    out.append({"market": key, "kind": kind, "x": vec,
                                "p": infer(model["markets"][key], vec),
                                "y": "" if played is None else int(pred(played)),
                                "eligible": int(board[kind])})
                if out:
                    cands[(eid, pid)].append({
                        "season": t["season"], "eid": eid, "date": t["date"], "team": team,
                        "player_id": pid, "player": (played or h_l[-1])["player"],
                        "played": played is not None, "last": h_l[-1]["date"], "markets": out})

    # A player in both sides' pools (traded between the two teams): keep the
    # side he played for, else the side of his latest appearance.
    rows, dup = [], 0
    for (eid, pid), cs in cands.items():
        if len(cs) > 1:
            dup += 1
            cs.sort(key=lambda c: (c["played"], c["last"]), reverse=True)
        rows.append(cs[0])
    rows.sort(key=lambda c: (c["date"], c["eid"], c["team"], c["player_id"]))
    return rows, rates, skipped_debut, dup


def cross_check(rows, rates):
    """Every features.build() row (player played, board rules met) must be an
    eligible row here with the identical vector, and vice versa."""
    ref = {}
    for r in F.build(rates):
        if r["season"] in SEASONS:
            for key, x in r["x"].items():
                ref[(r["eid"], r["player_id"], key)] = (x, r["y"][key])
    mine = {}
    for c in rows:
        for m in c["markets"]:
            if m["eligible"] and c["played"]:
                mine[(c["eid"], c["player_id"], m["market"])] = (m["x"], m["y"])
    missing = set(ref) - set(mine)
    extra = set(mine) - set(ref)
    diff = sum(1 for k in set(ref) & set(mine)
               if ref[k][1] != mine[k][1] or max(abs(a - b) for a, b in zip(ref[k][0], mine[k][0])) > 0)
    return len(ref), len(missing), len(extra), diff


def report(rows, model):
    shipped = {}
    if os.path.exists(METRICS):
        with open(METRICS) as f:
            shipped = json.load(f)
    for season in SEASONS:
        print(f"\nseason {season}  (eligible = 1 and played)")
        print(f"  {'market':9s} {'rows':>6s} {'elig':>6s} {'void':>5s} {'n':>5s} {'base':>6s} "
              f"{'meanP':>6s} {'brier':>7s} {'logloss':>7s} {'auc':>6s}"
              + ("   | metrics.json n / base / brier / auc" if season == 2025 and shipped else ""))
        for key in F.MARKETS:
            allr = [m for c in rows if c["season"] == season for m in c["markets"] if m["market"] == key]
            el = [m for m in allr if m["eligible"]]
            ev = [m for m in el if m["y"] != ""]
            if not ev:
                print(f"  {key:9s} {len(allr):6d} {len(el):6d}  (no settled rows)")
                continue
            p = np.array([m["p"] for m in ev])
            y = np.array([m["y"] for m in ev])
            auc = roc_auc_score(y, p) if 0 < y.sum() < len(y) else float("nan")
            line = (f"  {key:9s} {len(allr):6d} {len(el):6d} {len(el) - len(ev):5d} {len(ev):5d} "
                    f"{y.mean():6.3f} {p.mean():6.3f} {brier_score_loss(y, p):7.4f} "
                    f"{log_loss(y, p, labels=[0, 1]):7.4f} {auc:6.3f}")
            if season == 2025 and key in shipped:
                s = shipped[key]
                line += f"   | {s['nTest']:5d} {s['base']:6.3f} {s['brier']:7.4f} {s['auc']:6.3f}"
            print(line)


def main():
    with open(MODEL) as f:
        model = json.load(f)
    worst, n = selftest(model)
    print(f"selftest: {n} shipped vectors, max |p - expected| = {worst:.3e} "
          f"({'OK' if worst < 1e-6 else 'FAIL'})")
    if worst >= 1e-6:
        sys.exit(1)

    pos = load_positions()
    rows, rates, debut, dup = pool_rows(model, pos)
    print(f"pool: {len(rows):,} player-games ({debut} debut appearances with no window skipped, "
          f"{dup} players in both sides' pools resolved)")

    nref, missing, extra, diff = cross_check(rows, rates)
    print(f"features.build() cross-check: {nref:,} reference rows, {missing} missing, "
          f"{extra} extra, {diff} with a different vector or label "
          f"({'OK' if missing == extra == diff == 0 else 'MISMATCH'})")

    n_out = 0
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLS)
        for c in rows:
            position = pos(c["player_id"], c["season"])
            for m in c["markets"]:
                w.writerow([c["season"], c["eid"], c["date"], c["player_id"], c["player"],
                            c["team"], position, m["kind"], m["market"], repr(m["p"]),
                            m["y"], m["eligible"]])
                n_out += 1
    print(f"wrote {OUT}: {n_out:,} rows")
    report(rows, model)


if __name__ == "__main__":
    main()
