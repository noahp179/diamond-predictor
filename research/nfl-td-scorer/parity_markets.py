"""500 Python-scored vectors per market, for the TypeScript port to match.

Same reasoning as parity.py for the anytime ranker: the three vectors inside
each artefact catch a gross wiring error but not a subtle one, and two adjacent
features transposed can reproduce three rows by coincidence.
"""
import os, json
import numpy as np
import bakeoff_nfl as B
import bakeoff_first as F
from export_two_plus import fit_logit_bundle, predict as predict2, label as label2
from export_first_td import fit_bundle as fit1, predict as predict1

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "lib", "nfl-td-markets.parity.json")
N = 500

cases = {}

# --- 2+ : fitted on every season, exactly as the shipped artefact is
df2 = B.load()
sh2 = json.load(open(os.path.join(HERE, "..", "..", "src", "lib", "nfl-td2-model.json")))["shrink"]
b2 = fit_logit_bundle(df2, B.TRAIN + B.TEST, label2, sh2)
raw2 = df2[B.FEATURES].values
p2 = predict2(b2, raw2)
idx = np.argsort(p2)[np.linspace(0, len(p2) - 1, N).astype(int)]
cases["td2"] = [{"x": [float(v) for v in raw2[i]], "p": float(p2[i])} for i in idx]
print(f"td2: {N} cases, p {p2[idx].min():.4f}..{p2[idx].max():.4f}")

# --- first TD
df1 = F.load_first()
sh1 = json.load(open(os.path.join(HERE, "..", "..", "src", "lib", "nfl-td1-model.json")))["shrink"]
b1 = fit1(df1, B.TRAIN + B.TEST, sh1)
raw1 = df1[B.FEATURES].values
p1 = predict1(b1, raw1)
idx = np.argsort(p1)[np.linspace(0, len(p1) - 1, N).astype(int)]
cases["td1"] = [{"x": [float(v) for v in raw1[i]], "p": float(p1[i])} for i in idx]
print(f"td1: {N} cases, p {p1[idx].min():.4f}..{p1[idx].max():.4f}")

json.dump({"features": B.FEATURES, "cases": cases}, open(OUT, "w"))
print(f"wrote {os.path.relpath(OUT, os.path.join(HERE, '..', '..'))}")
