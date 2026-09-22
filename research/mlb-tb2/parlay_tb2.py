"""
What a 5, 10 or 15-leg "two or more total bases" slip is actually worth.

WHY THIS IS NOT THE FOOTBALL PARLAY WITH BASEBALL NAMES
-------------------------------------------------------
Two things differ, and the second one flips a sign.

1. THE LEGS ARE NEAR COIN FLIPS. The touchdown board's lead pick runs about
   65%; this model's whole range is 23% to 52%, and only 594 of ~37,000
   batter-games clear 50% at all. That is not a defect — 2+ total bases is
   simply a harder event than "scores at some point" — but it means a slip
   compounds much faster, and it means the floor cannot be set anywhere near
   the football board's.

2. THE SAME-TEAM CORRELATION SHOULD BE POSITIVE, WHICH IS THE OPPOSITE OF
   FOOTBALL. On the touchdown board two team-mates compete for a finite number
   of goal-line carries, so stacking them is penalised (0.826 against a 1.0
   control). Two hitters in one lineup do not compete — they share a starting
   pitcher and a ballpark. If he is wild and it is warm in Cincinnati, both get
   extra-base hits; if he is dealing, neither does. For an all-or-nothing slip
   that is the good kind of correlation: positively correlated legs are MORE
   likely to all land than the plain product implies.

   So the football board's instinct — cap the stack — may be exactly wrong
   here. That is measured below rather than assumed, against a different-games
   control, and the construction sweep is allowed to choose stacking if the
   corrected number backs it. The correction is applied INSIDE the sweep, so a
   construction that stacks pays whatever stacking costs and is chosen anyway
   only if it still comes out ahead.

DISCIPLINE. The model was fitted on 2024-25, so all of 2026 is held out for
IT. But the parlay's floors and caps are chosen here, so choosing them on all
of 2026 and reporting on the same days would be in-sample for the constants.
2026 is split in half by date: the first half picks the construction, the
second half is the only thing reported.
"""
import os, json, itertools
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "mlb-tb2-model.json"))
SIZES = [5, 10, 15]
CORR_FLOOR = 0.30       # the range a slip actually draws from
MAX_PER_GAME_GRID = [1, 2, 3, 99]
FLOOR_GRID = [0.30, 0.34, 0.38, 0.42, 0.45, 0.48]


def score(df, m):
    """The shipped model's probability, reproduced from the frozen artefact —
    which doubles as a parity check on the app's own inference."""
    X = df[m["features"]].values.astype(float)
    z = (X - np.array(m["mean"])) / np.array(m["std"])
    lg = z @ np.array(m["coef"]) + m["intercept"]
    p = 1 / (1 + np.exp(-lg))
    s = np.log(p / (1 - p))
    return 1 / (1 + np.exp(-(m["plattA"] * s + m["plattB"])))


def build(day, size, floor, cap):
    """One slip, the way a board builds one: best first, one leg per batter,
    at most `cap` from any game, everything clearing `floor`."""
    s = day[day.p >= floor].sort_values("p", ascending=False)
    keep, per_game = [], {}
    for r in s.itertuples():
        if per_game.get(r.gamePk, 0) >= cap:
            continue
        per_game[r.gamePk] = per_game.get(r.gamePk, 0) + 1
        keep.append(r)
        if len(keep) == size:
            break
    return keep if len(keep) == size else None


def correction(k, pair):
    """The measured per-pair factor over the slip's own same-game pairs.

    THIS BELONGS IN `stated`, AND LEAVING IT OUT WAS A BUG. The first version
    of this reported the plain product while the app quoted the product times
    this factor, so the card cited a backtest computed a different way than the
    number printed above it. At fifteen legs uncapped that gap is large: a slip
    concentrated in a few games carries eighteen opposed pairs, and 0.937^18 is
    0.30. The board cannot state one number and cite another.

    It also means the construction sweep now pays for stacking. That is the
    point — a cap is only worth choosing against the number the board quotes.
    """
    same = sum(1 for a, b in itertools.combinations(k, 2)
               if a.gamePk == b.gamePk and a.team_id == b.team_id)
    opp = sum(1 for a, b in itertools.combinations(k, 2)
              if a.gamePk == b.gamePk and a.team_id != b.team_id)
    return pair["sameTeam"] ** same * pair["opposed"] ** opp, same, opp


def slips_for(days, size, floor, cap, pair):
    out = []
    for _, day in days:
        k = build(day, size, floor, cap)
        if k is None:
            continue
        f, same, opp = correction(k, pair)
        out.append({
            "product": float(np.prod([r.p for r in k])),
            "stated": float(np.prod([r.p for r in k]) * f),
            "factor": float(f),
            "won": int(all(r.y for r in k)),
            "legs_hit": int(sum(r.y for r in k)),
            "same_pairs": same,
            "opposed_pairs": opp,
            "stacked": same + opp,
        })
    return pd.DataFrame(out)


def main():
    m = json.load(open(MODEL))
    import sys
    sys.path.insert(0, HERE)
    from bakeoff_tb2 import load  # noqa: E402

    df = load()
    df = df[df.season == 2026].copy()
    df["p"] = score(df, m)
    df["y"] = df.y_tb2.astype(int)
    df = df[["date", "gamePk", "batter_id", "team_id", "p", "y"]].dropna()

    dates = sorted(df.date.unique())
    cut = dates[len(dates) // 2]
    pick_days = list(df[df.date < cut].groupby("date"))
    test_days = list(df[df.date >= cut].groupby("date"))
    print(f"2026: {len(df):,} batter-games over {len(dates)} days")
    print(f"  construction chosen on {len(pick_days)} days (< {cut})")
    print(f"  reported on {len(test_days)} days (>= {cut})")
    print(f"  model range {df.p.min():.3f}..{df.p.max():.3f}, base {df.y.mean():.4f}\n")

    # ---------------------------------------------------- 1. correlation
    print(f"--- how legs move together, p>={CORR_FLOOR} (chosen days only) ---")
    buckets = {k: {"n": 0, "both": 0, "prod": 0.0} for k in ("same_team", "opposed", "diff")}
    for _, day in pick_days:
        s = day[day.p >= CORR_FLOOR].sort_values("p", ascending=False).head(40)
        for a, b in itertools.combinations(list(s.itertuples()), 2):
            k = ("same_team" if a.team_id == b.team_id
                 else "opposed" if a.gamePk == b.gamePk else "diff")
            bk = buckets[k]
            bk["n"] += 1
            bk["both"] += a.y * b.y
            bk["prod"] += a.p * b.p
    print(f"{'pair type':>26} {'pairs':>9} {'both':>7} {'expected':>9} {'ratio':>7}")
    ratios = {}
    for k, lab in (("same_team", "same lineup"), ("opposed", "same game, opposed"),
                   ("diff", "different games (control)")):
        bk = buckets[k]
        if not bk["n"]:
            continue
        r = bk["both"] / bk["prod"] if bk["prod"] else float("nan")
        ratios[k] = r
        print(f"{lab:>26} {bk['n']:>9,} {bk['both']:>7,} {bk['prod']:>9.1f} {r:>7.3f}")
    ctrl = ratios.get("diff", 1.0)
    pair = {"sameTeam": ratios.get("same_team", ctrl) / ctrl,
            "opposed": ratios.get("opposed", ctrl) / ctrl}
    print(f"\n  against the control: same lineup {pair['sameTeam']:.3f}, "
          f"opposed {pair['opposed']:.3f}")
    print("  above 1.000 means the legs land together MORE often than independence")
    print("  implies — which for an all-or-nothing slip is help, not a penalty.")

    # ------------------------------------------- 2. construction sweep
    #
    # CHOSEN ON STATED PROBABILITY, NOT ON WINS. The first version of this
    # picked whichever construction won most often on the chosen days, and that
    # is not a criterion — it is noise dressed as one. At ten and fifteen legs
    # EVERY construction won zero, so "most wins" tied at nothing and the code
    # silently kept the first row it saw: for ten legs that was one leg per game
    # at a 0.30 floor, which fills fewer days AND states a worse number
    # (0.052%) than the construction it beat on the tie (0.083%). At five legs
    # it was choosing between four wins and three when the expected count was
    # 2.4 — the same mistake as picking a model on one random seed.
    #
    # Stated probability is deterministic given the model, and it is exactly
    # "how good are these legs". So the rule is: the construction with the best
    # stated probability among those that can fill at least 70% of the days.
    # Realised wins are then REPORTED on days this never saw, which is the only
    # thing they can honestly do at these rates.
    FILL = 0.70
    print("\n--- construction, chosen on the first half of 2026 ---")
    print(f"{'size':>5} {'cap':>5} {'floor':>6} {'days':>6} {'product':>9} {'corr':>6} {'stated':>9} {'won':>5} {'realised':>9} {'ratio':>7}")
    chosen = {}
    for size in SIZES:
        best = None
        for cap in MAX_PER_GAME_GRID:
            for floor in FLOOR_GRID:
                sl = slips_for(pick_days, size, floor, cap, pair)
                if len(sl) < FILL * len(pick_days):
                    continue  # a construction that cannot fill most days is not one
                st, re_ = sl.stated.mean(), sl.won.mean()
                row = {"cap": cap, "floor": floor, "days": len(sl), "stated": st,
                       "won": int(sl.won.sum()), "realised": re_,
                       "ratio": (re_ / st) if st else 0}
                print(f"{size:>5} {cap:>5} {floor:>6.2f} {len(sl):>6} "
                      f"{sl['product'].mean()*100:>8.3f}% {sl.factor.mean():>6.3f} {st*100:>8.3f}% "
                      f"{int(sl.won.sum()):>5} {re_*100:>8.3f}% {row['ratio']:>7.2f}")
                if best is None or st > best["stated"]:
                    best = row
        chosen[size] = best
        if best:
            print(f"      -> cap {best['cap']}, floor {best['floor']:.2f}\n")

    # --------------------------------------------- 3. report on held-out days
    print("--- reported on the second half of 2026, using those constants ---")
    print(f"{'size':>5} {'cap':>5} {'floor':>6} {'days':>6} {'stated':>9} {'1 in':>8} {'won':>5} {'expected':>9} {'legs hit':>10}")
    evidence = {}
    for size in SIZES:
        c = chosen[size]
        if not c:
            continue
        sl = slips_for(test_days, size, c["floor"], c["cap"], pair)
        if len(sl) == 0:
            continue
        st = sl.stated.mean()
        evidence[size] = {
            "cap": c["cap"], "floor": c["floor"], "days": int(len(sl)),
            "stated": float(st), "oneIn": int(round(1 / st)) if st else 0,
            "won": int(sl.won.sum()), "expected": float(sl.stated.sum()),
            "realised": float(sl.won.mean()),
            "mean_legs_hit": float(sl.legs_hit.mean()),
            "mean_correction": float(sl.factor.mean()),
            "mean_stacked_pairs": float(sl.stacked.mean()),
        }
        print(f"{size:>5} {c['cap']:>5} {c['floor']:>6.2f} {len(sl):>6} {st*100:>8.3f}% "
              f"{1/st if st else 0:>8,.0f} {int(sl.won.sum()):>5} {sl.stated.sum():>9.2f} "
              f"{sl.legs_hit.mean():>6.1f}/{size}")

    json.dump({"pair_factor": pair, "control": float(ctrl),
               "chosen": {str(k): v for k, v in chosen.items()},
               "evidence": {str(k): v for k, v in evidence.items()},
               "split": {"cut": str(cut), "pick_days": len(pick_days),
                         "test_days": len(test_days)}},
              open(os.path.join(HERE, "parlay_tb2.json"), "w"), indent=1, default=float)
    print("\nwrote parlay_tb2.json")


if __name__ == "__main__":
    main()
