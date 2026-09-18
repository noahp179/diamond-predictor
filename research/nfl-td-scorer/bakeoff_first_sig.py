"""
Is anything actually winning the first-touchdown bakeoff?

The top eight models span 15.3% to 16.3% — three games out of 301. That is the
range in which this project has twice now found a leader that was a random
seed, so nothing gets believed without the slate-clustered bootstrap.

There is a second question here that the anytime bakeoff did not have to ask.
Two of the leaders, the Poisson rate and the ordinal, are fitted on `td_count`
rather than on the first-touchdown label, and their calibration is dreadful:
expected calibration error 0.164 and 0.163, against 0.003 for the logistic.
They order candidates plausibly and then state numbers that are nowhere near
right. A board that only ranked could ship one of them; a board that prints a
percentage on every leg and multiplies five of them together cannot.
"""
import os, json
import numpy as np
import pandas as pd
from scipy import stats

import bakeoff_nfl as B
import bakeoff_first as F

HERE = os.path.dirname(os.path.abspath(__file__))
BOOTSTRAPS = 4000
RNG = np.random.default_rng(23)


def main():
    res, top1, _ = F.main()
    df = F.load_first()
    te = df[df.season.isin(B.TEST)]
    gmeta = te.groupby("game_id").agg(date=("date", "first")).sort_index()
    slate_of = gmeta.date.values
    slates = np.unique(slate_of)
    slate_idx = {s: np.flatnonzero(slate_of == s) for s in slates}

    names = list(top1.keys())
    champ = max(names, key=lambda n: top1[n].mean())
    ref = "logistic L2 (shipped)"
    print(f"\n{'='*78}")
    print(f"best top-1: {champ} ({top1[champ].mean()*100:.1f}%)")
    print(f"reference:  {ref} ({top1[ref].mean()*100:.1f}%)\n")

    def boot(a, b):
        va, vb = top1[a], top1[b]
        out = np.empty(BOOTSTRAPS)
        for k in range(BOOTSTRAPS):
            pick = RNG.choice(slates, size=len(slates), replace=True)
            idx = np.concatenate([slate_idx[s] for s in pick])
            out[k] = va[idx].mean() - vb[idx].mean()
        return out

    ece = {r["model"]: r["ece"] for r in res.to_dict("records")}
    print("--- every model against the L2 logistic, paired by slate ---")
    print(f"{'model':<32} {'top1':>7} {'diff':>7} {'95% CI':>18} {'P(better)':>10} {'ece':>8}")
    sig = []
    for n in sorted(names, key=lambda x: -top1[x].mean()):
        d = boot(n, ref)
        lo, hi = np.percentile(d, [2.5, 97.5])
        e = ece.get(n)
        sig.append({"model": n, "top1": float(top1[n].mean()), "diff": float(d.mean()),
                    "lo": float(lo), "hi": float(hi),
                    "p_better": float((d > 0).mean()), "ece": e})
        star = "  *" if lo > 0 else ("  -" if hi < 0 else "")
        print(f"{n:<32} {top1[n].mean()*100:>6.1f}% {d.mean()*100:>+6.1f} "
              f"[{lo*100:>+5.1f},{hi*100:>+5.1f}]{'':>3} {(d>0).mean():>9.2f} "
              f"{('%.4f' % e) if e is not None else '    —   ':>8}{star}")
    print("\n  * = 95% interval excludes zero (genuinely better than the logistic)")

    a, b = top1[champ], top1[ref]
    a_only = int(((a == 1) & (b == 0)).sum())
    b_only = int(((a == 0) & (b == 1)).sum())
    n_disc = a_only + b_only
    pval = float(stats.binomtest(a_only, n_disc, 0.5).pvalue) if n_disc else 1.0
    print(f"\n--- McNemar: {champ} vs the logistic ---")
    print(f"  {champ} only: {a_only}   logistic only: {b_only}   (discordant {n_disc})")
    print(f"  two-sided binomial p = {pval:.4f}")

    print("\n--- and what a leg would actually claim ---")
    print("  a five-leg slip multiplies five stated probabilities, so a model")
    print("  whose calibration error is 0.16 on a 5% base rate is not a")
    print("  candidate however it ranks:")
    for n in sorted(names, key=lambda x: -top1[x].mean())[:6]:
        e = ece.get(n)
        verdict = "unusable" if (e is not None and e > 0.05) else "ok"
        print(f"    {n:<32} ece {('%.4f' % e) if e is not None else '  none  '}  {verdict}")

    json.dump({"champion": champ, "reference": ref, "significance": sig,
               "mcnemar": {"champ_only": a_only, "ref_only": b_only, "p": pval}},
              open(os.path.join(HERE, "bakeoff_first_sig.json"), "w"), indent=1)
    print("\nwrote bakeoff_first_sig.json")


if __name__ == "__main__":
    main()
