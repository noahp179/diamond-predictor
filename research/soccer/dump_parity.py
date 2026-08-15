"""
Dump a parity fixture: real feature vectors and the probabilities Python gets
from the shipped coefficients.

scripts/test-soccer-props.ts replays these through the TypeScript scorer and
requires agreement to 1e-9. That is the check that the site's numbers ARE the
backtested numbers — a wrong feature order, a missed standardisation or a
dropped Platt term all change the probability, and all of them would otherwise
be invisible on the page.

Usage: python3 dump_parity.py --league epl
"""

import argparse
import json
import os

import numpy as np

from leagues import add_league_arg, get as get_league
from props_soccer import CONFIRM, MARKETS, build

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
N_ROWS = 40


def main():
    ap = add_league_arg(argparse.ArgumentParser(description=__doc__))
    league = get_league(ap.parse_args().league)
    model = json.load(open(os.path.join(RESULTS, f"{league.slug}_props_model.json")))

    df = build(os.path.join(HERE, "data", league.slug))
    df = df[df.season == CONFIRM].reset_index(drop=True)
    # A spread of rows rather than the first N, so forwards, defenders and
    # goalkeepers are all represented.
    idx = np.linspace(0, len(df) - 1, N_ROWS).astype(int)

    cases = []
    for i in idx:
        row = df.iloc[i]
        case = {"player": str(row["name"]), "features": {}, "expected": {}}
        for mk, m in model["markets"].items():
            feats = m["features"]
            x = np.array([float(row[f]) for f in feats])
            z = float(((x - np.array(m["mean"])) / np.array(m["std"])) @ np.array(m["coef"])
                      + m["intercept"])
            raw = 1 / (1 + np.exp(-z))
            c = min(max(raw, 1e-9), 1 - 1e-9)
            lg = np.log(c / (1 - c))
            case["expected"][mk] = float(1 / (1 + np.exp(-(m["plattA"] * lg + m["plattB"]))))
            for f in feats:
                case["features"][f] = float(row[f])
        cases.append(case)

    out = dict(league=league.slug, markets=sorted(MARKETS), cases=cases)
    path = os.path.join(RESULTS, f"{league.slug}_parity.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"{len(cases)} cases x {len(model['markets'])} markets -> "
          f"results/{league.slug}_parity.json")


if __name__ == "__main__":
    main()
