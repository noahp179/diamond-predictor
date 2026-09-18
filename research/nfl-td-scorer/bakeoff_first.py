"""
The same twenty-four models, asked a harder question: who scores FIRST.

WHY THIS IS NOT THE ANYTIME BOARD WITH A DIFFERENT LABEL
---------------------------------------------------------
Anytime touchdown has 21.4% of candidates succeeding and several winners per
game. First touchdown has exactly one winner per game, and sometimes none that
the board could ever have named:

  first TD scored by a rusher or receiver   1,354 games   94.7%
  interception return                          36
  fumble return                                13
  kickoff return                                8
  punt return                                   8
  blocked punt / blocked FG / own fumble        10
  no touchdown in the game at all              10 games

So 5.3% of games are unwinnable by construction — the first points came off a
defender or a returner, and no candidate on the board was even eligible. Those
games are KEPT. Deleting them would fit the model on a filtered world where
every game has an offensive first scorer, and every probability it stated would
be too high by about that 5%. The ceiling on per-game top-1 is therefore ~94.7%
and the realistic number is far below it, because one winner out of eighteen
candidates is a much thinner target than "any of the four who scored".

The base rate falls from 21.4% to about 5%, which changes what a good model
looks like. Everything else — five metrics, the slate-clustered bootstrap, the
seed sweep — is the discipline the anytime bakeoff used, unchanged.
"""
import os, json, time
import numpy as np
import pandas as pd

import bakeoff_nfl as B

HERE = os.path.dirname(os.path.abspath(__file__))


def load_first():
    """The feature table with `scored` replaced by 'was the first scorer'.

    Swapping the column rather than adding one means every model, metric and
    helper in bakeoff_nfl.py applies unchanged — the comparison is the same
    comparison, asked of a different target.
    """
    df = B.load()
    ft = pd.read_csv(os.path.join(HERE, "data", "nfl_first_td.csv"),
                     dtype={"game_id": str, "scorer_id": str})
    df["game_id"] = df.game_id.astype(str)
    df["player_id"] = df.player_id.astype(str)
    ft["scorer_id"] = ft.scorer_id.fillna("")
    m = dict(zip(ft.game_id, ft.scorer_id))
    df["first_scorer_id"] = df.game_id.map(m).fillna("")
    df["anytime"] = df.scored           # keep the old label for reference
    df["scored"] = (df.player_id == df.first_scorer_id).astype(int)
    return df


def main():
    df = load_first()
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)

    # how many games even have a candidate who could have been right
    hit_games = df.groupby("game_id").scored.max()
    print(f"{len(df):,} rows, {df.game_id.nunique():,} games")
    print(f"  games where a board candidate scored first: {int(hit_games.sum()):,} "
          f"({hit_games.mean()*100:.1f}%) — the ceiling on top-1")
    print(f"  base rate: train {tr.scored.mean()*100:.2f}%, test {te.scored.mean()*100:.2f}%")
    te_ceiling = te.groupby("game_id").scored.max().mean()
    print(f"  test-season ceiling: {te_ceiling*100:.1f}%\n")

    from sklearn.preprocessing import StandardScaler
    from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

    sc = StandardScaler().fit(tr[B.FEATURES].values)
    Xtr, Xte = sc.transform(tr[B.FEATURES].values), sc.transform(te[B.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values

    print(f"train {len(tr):,} rows ({tr.game_id.nunique():,} games) · "
          f"test {len(te):,} rows ({te.game_id.nunique():,} games, "
          f"{te.date.nunique()} slates)\n")

    rows, top1_vectors, parlay_vectors = [], {}, {}
    for name, kind, family in B.CANDIDATES:
        t0 = time.time()
        try:
            score, prob = B.fit_predict(kind, tr, te, Xtr, Xte, ytr)
        except Exception as e:
            print(f"  {name:<32} FAILED: {str(e)[:60]}")
            continue
        hits, _ = B.per_game_top1(te, score)
        pv = B.parlay_rate(te, score, size=5, floor=0.0, probs=None)
        r = {"model": name, "family": family,
             "auc": float(roc_auc_score(yte, score)),
             "logloss": float(log_loss(yte, prob)) if prob is not None else None,
             "brier": float(brier_score_loss(yte, prob)) if prob is not None else None,
             "ece": float(B.ece(yte, prob)) if prob is not None else None,
             "top1": float(hits.mean()), "top1_n": int(len(hits)),
             "secs": round(time.time() - t0, 1)}
        rows.append(r)
        top1_vectors[name] = hits
        parlay_vectors[name] = pv
        print(f"  {name:<32} auc {r['auc']:.4f}  top1 {r['top1']*100:5.1f}%  "
              f"{'ll %.4f' % r['logloss'] if r['logloss'] else 'll    —  '}  "
              f"{'ece %.4f' % r['ece'] if r['ece'] is not None else 'ece    — '}"
              f"  {r['secs']:>5}s")

    res = pd.DataFrame(rows)
    res.to_csv(os.path.join(HERE, "bakeoff_first_results.csv"), index=False)
    json.dump({"results": rows, "train": B.TRAIN, "test": B.TEST,
               "ceiling": float(te_ceiling)},
              open(os.path.join(HERE, "bakeoff_first_metrics.json"), "w"), indent=1)
    best = max(rows, key=lambda r: r["top1"])
    print(f"\nbest top-1: {best['model']} at {best['top1']*100:.1f}% "
          f"(ceiling {te_ceiling*100:.1f}%, random would be "
          f"{1/te.groupby('game_id').size().mean()*100:.1f}%)")
    print("wrote bakeoff_first_results.csv / bakeoff_first_metrics.json")
    return res, top1_vectors, parlay_vectors


if __name__ == "__main__":
    main()
