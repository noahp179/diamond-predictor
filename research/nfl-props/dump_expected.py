"""
Dump the probabilities the trained model produces for one past slate, computed
from the research CSVs, so scripts/test-nfl-props.ts can check that the live
TypeScript path rebuilds the same features from ESPN and lands on the same
numbers. A model that is only correct in the notebook is not correct.

    python3 research/nfl-props/dump_expected.py 2025-11-16
"""
import os, sys, json
import numpy as np

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "nfl-props-model.json"))
OUT = os.path.join(HERE, "expected.json")


def infer(m, x):
    z = m["intercept"] + float(np.dot((np.array(x) - np.array(m["mean"])) / np.array(m["std"]),
                                      m["coef"]))
    raw = 1 / (1 + np.exp(-z))
    lg = np.log(raw / (1 - raw))
    return float(1 / (1 + np.exp(-(m["plattA"] * lg + m["plattB"]))))


def main():
    date = sys.argv[1] if len(sys.argv) > 1 else "2025-11-16"
    model = json.load(open(MODEL))
    rates = {k: m["base"] for k, m in model["markets"].items()}
    rows = [r for r in F.build(rates) if r["date"] == date]
    out = []
    for r in rows:
        for key, m in model["markets"].items():
            if key not in r["x"]:
                continue
            out.append({"gameId": int(r["eid"]), "playerId": str(r["player_id"]),
                        "player": r["player"], "market": key, "prob": infer(m, r["x"][key]),
                        "x": r["x"][key], "kind": m["kind"]})
    feats = {k: m["features"] for k, m in model["markets"].items()}
    json.dump({"date": date, "rows": out, "features": feats}, open(OUT, "w"))
    print(f"{len(rows)} players, {len(out)} probabilities for {date} -> {OUT}")


if __name__ == "__main__":
    main()
