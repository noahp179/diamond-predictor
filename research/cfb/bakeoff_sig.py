"""
Is the winner actually winning?

bakeoff_big.py says extra trees picks the right name in 58.1% of games and the
shipped logistic regression in 56.3%. That is 1.8 points over 1,130 games —
about twenty games — and the obvious question is whether twenty games is a
finding or a coin.

Three tests, because each answers a different objection:

  paired bootstrap by SLATE   resample Saturdays, not games. Games on one slate
                              share weather, week and the state of every team's
                              usage sample, so treating 1,130 games as 1,130
                              independent trials overstates the precision.
  McNemar                     of the games where the two models disagree, how
                              lopsided is the split? Discards the games both get
                              right, which are not evidence either way.
  per-season                  a model that wins in 2025 and loses in 2026 has
                              found something about 2025.
"""
import os, json
import numpy as np
import pandas as pd
from scipy import stats

import bakeoff_big as B

HERE = os.path.dirname(os.path.abspath(__file__))
BOOTSTRAPS = 4000
RNG = np.random.default_rng(7)


def main():
    res, top1, parlay = B.main()

    # rebuild the game -> slate map so the bootstrap can resample slates
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    te = df[df.season.isin(B.TEST)]
    gmeta = te.groupby("game_id").agg(date=("date", "first"), season=("season", "first"))
    gmeta = gmeta.sort_index()
    order = list(gmeta.index)
    slate_of = gmeta.date.values
    season_of = gmeta.season.values
    slates = np.unique(slate_of)
    slate_idx = {s: np.flatnonzero(slate_of == s) for s in slates}

    names = list(top1.keys())
    champ = max(names, key=lambda n: top1[n].mean())
    shipped = "logistic L2 (shipped)"
    print(f"\n{'='*78}\nbest top-1: {champ} ({top1[champ].mean()*100:.1f}%)")
    print(f"shipped:    {shipped} ({top1[shipped].mean()*100:.1f}%)\n")

    def boot_diff(a, b, n=BOOTSTRAPS):
        """Paired bootstrap of (a - b) top-1 rate, resampling whole slates."""
        va, vb = top1[a], top1[b]
        out = np.empty(n)
        for k in range(n):
            pick = RNG.choice(slates, size=len(slates), replace=True)
            idx = np.concatenate([slate_idx[s] for s in pick])
            out[k] = va[idx].mean() - vb[idx].mean()
        return out

    print("--- every model against the shipped logistic, paired by slate ---")
    print(f"{'model':<32} {'top1':>7} {'diff':>7} {'95% CI':>18} {'P(better)':>10}")
    sig = []
    for n in sorted(names, key=lambda x: -top1[x].mean()):
        d = boot_diff(n, shipped)
        lo, hi = np.percentile(d, [2.5, 97.5])
        pbet = float((d > 0).mean())
        sig.append({"model": n, "top1": float(top1[n].mean()),
                    "diff": float(d.mean()), "lo": float(lo), "hi": float(hi),
                    "p_better": pbet})
        star = "  *" if lo > 0 else ("  -" if hi < 0 else "")
        print(f"{n:<32} {top1[n].mean()*100:>6.1f}% {d.mean()*100:>+6.1f} "
              f"[{lo*100:>+5.1f},{hi*100:>+5.1f}]{'':>3} {pbet:>9.2f}{star}")
    print("\n  * = 95% interval excludes zero (genuinely better)")
    print("  - = 95% interval excludes zero on the losing side")

    print("\n--- McNemar: champion vs shipped, on the games they disagree about ---")
    a, b = top1[champ], top1[shipped]
    a_only = int(((a == 1) & (b == 0)).sum())
    b_only = int(((a == 0) & (b == 1)).sum())
    both = int(((a == 1) & (b == 1)).sum())
    neither = int(((a == 0) & (b == 0)).sum())
    n_disc = a_only + b_only
    pval = float(stats.binomtest(a_only, n_disc, 0.5).pvalue) if n_disc else 1.0
    print(f"  both right {both}, both wrong {neither}")
    print(f"  {champ} only: {a_only}   {shipped} only: {b_only}   (discordant {n_disc})")
    print(f"  two-sided binomial p = {pval:.4f}")

    print("\n--- per season (does the winner keep winning?) ---")
    print(f"{'model':<32} {'2025':>8} {'2026':>8}")
    per_season = {}
    for n in sorted(names, key=lambda x: -top1[x].mean())[:10]:
        row = {}
        for s in B.TEST:
            m = season_of == s
            row[str(s)] = float(top1[n][m].mean())
        per_season[n] = row
        print(f"{n:<32} {row['2025']*100:>7.1f}% {row['2026']*100:>7.1f}%")

    print("\n--- 5-leg parlay rate (the hardest ask) ---")
    print(f"{'model':<32} {'slips':>7} {'all five hit':>13}")
    for n in sorted(names, key=lambda x: -(parlay[x].mean() if len(parlay[x]) else -1))[:10]:
        pv = parlay[n]
        if len(pv) == 0:
            continue
        print(f"{n:<32} {len(pv):>7} {pv.mean()*100:>12.1f}%")

    json.dump({"champion": champ, "shipped": shipped, "significance": sig,
               "mcnemar": {"champ_only": a_only, "shipped_only": b_only,
                           "both": both, "neither": neither, "p": pval},
               "per_season": per_season,
               "parlay5": {n: {"slips": int(len(parlay[n])),
                               "rate": float(parlay[n].mean()) if len(parlay[n]) else None}
                           for n in names}},
              open(os.path.join(HERE, "bakeoff_sig.json"), "w"), indent=1)
    print("\nwrote bakeoff_sig.json")


if __name__ == "__main__":
    main()
