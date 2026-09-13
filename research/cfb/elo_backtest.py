"""
Margin-of-victory Elo for college football: tune it, then test it.

The app already runs this engine for the NFL and NBA (src/lib/espn.server.ts).
Three knobs decide how it behaves — K (how hard a result moves a rating), HFA
(home-field advantage in rating points) and CARRY (how much of a rating
survives into the next season). The NFL's settings are not college's: 134 FBS
teams play ~12 games against wildly uneven schedules, rosters turn over far
faster, and the scores are bigger.

Two things here that the pro-league version does not need:

  FCS opponents. About 100 games a season are an FBS team hosting an FCS one.
  Those teams never appear again, so each gets no rating of its own — they all
  share one pooled FCS rating that floats. Giving each its own would hand a
  team a free win over an unrated opponent and leave the rating meaningless.

  A preseason prior. Week 1 of a season, every rating is last season's
  regressed toward the mean. That is genuinely all we know, and it is what the
  app will have live too.

Method: grid search on 2021-2024, then a single held-out run on 2025-2026 with
the winning settings. Scoring is log loss (the honest one for probabilities),
with accuracy and Brier alongside.
"""
import os, json, math, itertools
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data", "cache")

SEASONS = [2021, 2022, 2023, 2024, 2025, 2026]
TRAIN = [2021, 2022, 2023, 2024]
TEST = [2025, 2026]

ELO_MEAN = 1505.0
ELO_INIT = 1300.0
FCS = "__FCS__"


def load():
    """Every completed game, oldest first, with team ids (not abbreviations —
    abbreviations get reused and renamed; ids do not)."""
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
    # An FBS team is one that appears on the FBS scoreboard in enough games to
    # have a schedule of its own. FCS visitors show up once or twice a year.
    counts = defaultdict(int)
    for s, games in by_season.items():
        for g in games:
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
    """FCS opponents share one pooled rating."""
    return side["id"] if side["id"] in fbs else FCS


def run(k, hfa, carry, seasons, by_season, fbs, warm=2, collect=False):
    """Replay `warm` seasons before each scored season, then score every game
    in it point-in-time: predict with the ratings as they stand, then update."""
    elo = Elo(k, hfa, carry)
    first = min(seasons) - warm
    rows = []
    n = ll = brier = 0
    hits = 0
    for s in range(first, max(seasons) + 1):
        if s not in by_season:
            continue
        if s > first:
            elo.carry_season()
        for g in by_season[s]:
            h, a = team_key(g["home"], fbs), team_key(g["away"], fbs)
            hs, as_ = g["home"]["score"], g["away"]["score"]
            if hs == as_:
                continue
            score = s in seasons
            if score:
                p = elo.prob(h, a, g["neutral"])
                y = 1.0 if hs > as_ else 0.0
                q = min(1 - 1e-12, max(1e-12, p))
                ll += -(y * math.log(q) + (1 - y) * math.log(1 - q))
                brier += (p - y) ** 2
                hits += 1 if (p >= 0.5) == (y == 1) else 0
                n += 1
                if collect:
                    rows.append({
                        "season": s, "date": g["date"], "game_id": g["id"],
                        "home": g["home"]["abbr"], "away": g["away"]["abbr"],
                        "p_home": p, "home_won": int(y), "neutral": int(g["neutral"]),
                        "elo_home": round(elo.rating(h), 1), "elo_away": round(elo.rating(a), 1),
                        "fcs": int(h == FCS or a == FCS),
                    })
            elo.update(h, a, hs, as_, g["neutral"])
    if n == 0:
        return None
    out = {"n": n, "logloss": ll / n, "brier": brier / n, "acc": hits / n}
    return (out, rows, elo) if collect else out


def main():
    by_season, fbs = load()
    print(f"FBS teams identified: {len(fbs)}")
    for s in SEASONS:
        if s in by_season:
            print(f"  {s}: {len(by_season[s])} completed games")

    print("\n--- grid search on train seasons", TRAIN, "---")
    grid = []
    for k in (12, 16, 20, 24, 28, 32, 40):
        for hfa in (40, 55, 65, 75, 85):
            for carry in (0.30, 0.45, 0.60, 0.75, 0.90):
                m = run(k, hfa, carry, TRAIN, by_season, fbs)
                if m:
                    grid.append(((k, hfa, carry), m))
    grid.sort(key=lambda x: x[1]["logloss"])
    print(f"{'K':>4} {'HFA':>5} {'CARRY':>6} {'logloss':>9} {'brier':>8} {'acc':>7}")
    for (k, hfa, carry), m in grid[:10]:
        print(f"{k:>4} {hfa:>5} {carry:>6.2f} {m['logloss']:>9.4f} {m['brier']:>8.4f} {m['acc']*100:>6.1f}%")
    print("  ... worst:", end=" ")
    (k, hfa, carry), m = grid[-1]
    print(f"K={k} HFA={hfa} CARRY={carry} logloss={m['logloss']:.4f} acc={m['acc']*100:.1f}%")

    best = grid[0][0]
    print(f"\nbest on train: K={best[0]} HFA={best[1]} CARRY={best[2]}")

    print(f"\n--- held out: {TEST} (settings chosen without seeing them) ---")
    res, rows, elo = run(*best, TEST, by_season, fbs, collect=True)
    print(f"n={res['n']}  logloss={res['logloss']:.4f}  brier={res['brier']:.4f}  acc={res['acc']*100:.1f}%")

    # A baseline worth beating: always pick the home team.
    home_wins = sum(r["home_won"] for r in rows)
    print(f"baseline (always home): acc={home_wins/len(rows)*100:.1f}%")
    fbs_only = [r for r in rows if not r["fcs"]]
    acc_fbs = sum(1 for r in fbs_only if (r["p_home"] >= .5) == (r["home_won"] == 1)) / len(fbs_only)
    print(f"FBS-vs-FBS only: n={len(fbs_only)} acc={acc_fbs*100:.1f}%")

    # Calibration: does a stated 70% actually win 70%?
    print("\ncalibration (held out):")
    buckets = defaultdict(lambda: [0, 0.0, 0])
    for r in rows:
        p = r["p_home"] if r["p_home"] >= .5 else 1 - r["p_home"]
        won = (r["home_won"] == 1) == (r["p_home"] >= .5)
        b = min(9, int(p * 10))
        buckets[b][0] += 1
        buckets[b][1] += p
        buckets[b][2] += 1 if won else 0
    print(f"{'stated':>12} {'n':>6} {'predicted':>10} {'actual':>8}")
    for b in sorted(buckets):
        n, sp, w = buckets[b]
        print(f"{b*10:>8}-{b*10+10:<3} {n:>6} {sp/n*100:>9.1f}% {w/n*100:>7.1f}%")

    by_year = {}
    for s in TEST:
        sub = [r for r in rows if r["season"] == s]
        if sub:
            acc = sum(1 for r in sub if (r["p_home"] >= .5) == (r["home_won"] == 1)) / len(sub)
            by_year[s] = {"n": len(sub), "acc": acc}
            print(f"  {s}: n={len(sub)} acc={acc*100:.1f}%")

    top = sorted(((v, t) for t, v in elo.r.items() if t in fbs), reverse=True)[:15]
    id2abbr = {}
    for s in by_season:
        for g in by_season[s]:
            id2abbr[g["home"]["id"]] = g["home"]["abbr"]
            id2abbr[g["away"]["id"]] = g["away"]["abbr"]
    print("\ntop 15 by Elo at the end of the held-out run:")
    print("  " + ", ".join(f"{id2abbr.get(t,t)} {v:.0f}" for v, t in top))

    json.dump({
        "grid_top": [{"k": g[0][0], "hfa": g[0][1], "carry": g[0][2], **g[1]} for g in grid[:10]],
        "best": {"k": best[0], "hfa": best[1], "carry": best[2]},
        "train_seasons": TRAIN, "test_seasons": TEST,
        "holdout": res, "by_season": by_year,
        "baseline_home_acc": home_wins / len(rows),
        "fbs_only": {"n": len(fbs_only), "acc": acc_fbs},
        "calibration": {f"{b*10}-{b*10+10}": {"n": v[0], "pred": v[1]/v[0], "actual": v[2]/v[0]}
                        for b, v in sorted(buckets.items())},
        "fbs_team_count": len(fbs),
    }, open(os.path.join(HERE, "elo_metrics.json"), "w"), indent=1)
    print("\nwrote elo_metrics.json")


if __name__ == "__main__":
    main()
