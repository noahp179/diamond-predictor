"""
Merge the per-league research outputs into the two JSON files the site imports.

  results/<league>_match_model.json  ->  src/lib/soccer-match-model.json
  results/<league>_props_model.json  ->  src/lib/soccer-props-model.json

Keyed by league slug, so src/lib/soccer.server.ts can look a competition up by
its URL segment. Nothing is transformed on the way through: whatever the
backtest fitted is exactly what the site scores with, which is the only way the
numbers printed on the page can honestly claim to be the backtested ones.

Usage: python3 export_models.py
"""

import json
import os

from leagues import LEAGUES

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
SRC = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib"))


def merge(suffix, out_name):
    merged, missing = {}, []
    for lg in LEAGUES:
        path = os.path.join(RESULTS, f"{lg.slug}_{suffix}.json")
        if not os.path.exists(path):
            missing.append(lg.slug)
            continue
        merged[lg.slug] = json.load(open(path))
    dest = os.path.join(SRC, out_name)
    with open(dest, "w") as fh:
        json.dump(merged, fh, indent=1)
        fh.write("\n")
    size = os.path.getsize(dest) / 1024
    print(f"{out_name:32s} {len(merged)}/{len(LEAGUES)} leagues  {size:7.1f} KB"
          + (f"  MISSING: {', '.join(missing)}" if missing else ""))
    return missing


def main():
    m1 = merge("match_model", "soccer-match-model.json")
    m2 = merge("props_model", "soccer-props-model.json")
    if m1 or m2:
        raise SystemExit("\nrun fetch_soccer.py / ship_soccer.py / props_soccer.py "
                         "for the missing leagues before shipping")
    print("\nboth model files written to src/lib/")


if __name__ == "__main__":
    main()
