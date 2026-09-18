"""
Score 500 real feature vectors in Python so TypeScript can be held to them.

The three vectors baked into the artefact catch a gross wiring error. They do
not catch a subtle one: a feature transposed with its neighbour will still
reproduce three rows if those rows happen to be close on both, and every board
downstream then shows plausible percentages with nothing to flag them. 500 rows
spanning the whole probability range do not have that escape.
"""
import os, json
import numpy as np
import bakeoff_nfl as B
from export_ranker import fit_bundle, predict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "lib", "nfl-td-ranker.parity.json")
N = 500

df = B.load()
bundle = fit_bundle(df, B.TRAIN + B.TEST)  # the shipped fit
raw = df[B.FEATURES].values
p = predict(bundle, raw)
# stratify across the probability range so the sample is not all mid-table
order = np.argsort(p)
idx = order[np.linspace(0, len(order) - 1, N).astype(int)]
json.dump(
    {"features": B.FEATURES,
     "cases": [{"x": [float(v) for v in raw[i]], "p": float(p[i])} for i in idx]},
    open(OUT, "w"))
print(f"wrote {N} cases, p from {p[idx].min():.4f} to {p[idx].max():.4f}")
