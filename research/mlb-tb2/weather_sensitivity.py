"""
Would a weather *forecast* recover what observed weather is worth?

features_tb2.py measured the weather block at +0.0014 AUC — the best of the
seven candidate blocks — using the values MLB publishes after a game has
started. A pre-game board cannot have those. It could have a forecast, from
api.weather.gov or open-meteo, and the question this script answers is whether
the signal survives being a forecast rather than a measurement.

Method: degrade the observed values by the error a real forecast carries at the
lead times that matter, and re-measure. Published verification for 0-24h
forecasts puts temperature MAE near 2-3F and wind-speed MAE near 2-3 mph, with
direction the least reliable of the three. Each noise level is run five times
with different draws so the number quoted is not one lucky seed.

Usage: python3 weather_sensitivity.py
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bakeoff_tb2 import BASE, auc, boot_delta, load  # noqa: E402
from features_tb2 import EXTRA_BLOCKS  # noqa: E402
from final_tb2 import fit  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026
SERVABLE = BASE + EXTRA_BLOCKS["parktb"] + EXTRA_BLOCKS["def"] + EXTRA_BLOCKS["form15"]
WEATHER = EXTRA_BLOCKS["weather"]  # temp, wind_mph, wind_out, wind_in, is_dome, is_day

# (label, temp sd in F, wind sd in mph, probability the direction category flips)
LEVELS = [
    ("perfect (what was measured)", 0.0, 0.0, 0.00),
    ("same-day forecast", 2.5, 2.5, 0.15),
    ("next-day forecast", 3.5, 3.5, 0.25),
    ("three days out", 5.0, 5.0, 0.40),
    ("useless (pure noise)", 15.0, 12.0, 0.67),
]
REPS = 5


def degrade(df, temp_sd, wind_sd, flip_p, rng):
    """Observed weather plus the error a forecast at that lead time carries."""
    d = df.copy()
    if temp_sd:
        d["temp"] = d.temp + rng.normal(0, temp_sd, len(d))
    if wind_sd or flip_p:
        base = np.maximum(d.wind_mph + rng.normal(0, wind_sd, len(d)), 0)
        # a dome stays a dome; only open-air games have a wind to get wrong
        open_air = d.is_dome.values < 0.5
        out = d.wind_out.values > 0
        inn = d.wind_in.values > 0
        flip = (rng.random(len(d)) < flip_p) & open_air
        new_out = np.where(flip, inn, out)
        new_in = np.where(flip, out, inn)
        d["wind_mph"] = np.where(open_air, base, 0.0)
        d["wind_out"] = np.where(new_out & open_air, base, 0.0)
        d["wind_in"] = np.where(new_in & open_air, base, 0.0)
    return d


def main():
    df = load()
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    y = df.y_tb2.values.astype(int)
    yte = y[te]

    p_serv = fit(df, SERVABLE, tr, te, y)
    a_serv = auc(yte, p_serv)
    p_base = fit(df, BASE, tr, te, y)
    a_base = auc(yte, p_base)
    print(f"shipped props model (34 features)      auc={a_base:.5f}")
    print(f"what ships today  (43, no weather)     auc={a_serv:.5f}  "
          f"({a_serv - a_base:+.5f})\n")
    print("adding the weather block, degraded to forecast accuracy:")
    print(f"{'lead time':30s} {'auc':>9s} {'vs no weather':>14s}   {'noise':>18s}")

    out = []
    for label, tsd, wsd, flip in LEVELS:
        aucs = []
        for rep in range(1 if tsd == 0 else REPS):
            rng = np.random.default_rng(1000 + rep)
            d = degrade(df, tsd, wsd, flip, rng)
            p = fit(d, SERVABLE + WEATHER, tr, te, y)
            aucs.append(auc(yte, p))
        m = float(np.mean(aucs))
        sd = float(np.std(aucs))
        print(f"{label:30s} {m:9.5f} {m - a_serv:+14.5f}   "
              f"temp±{tsd:.1f}F wind±{wsd:.1f}mph dir {flip:.0%}"
              + (f"  (sd {sd:.5f})" if len(aucs) > 1 else ""))
        out.append(dict(label=label, auc=m, sd=sd, delta=m - a_serv,
                        temp_sd=tsd, wind_sd=wsd, flip=flip, reps=len(aucs)))

    # Is the same-day number distinguishable from no weather at all?
    rng = np.random.default_rng(1000)
    d = degrade(df, 2.5, 2.5, 0.15, rng)
    p_fc = fit(d, SERVABLE + WEATHER, tr, te, y)
    m, lo, hi = boot_delta(yte, p_serv, p_fc, 400)
    print(f"\nsame-day forecast vs shipping no weather: {auc(yte, p_fc) - a_serv:+.5f} "
          f"95% [{lo:+.5f}, {hi:+.5f}]  -> "
          f"{'worth wiring up' if lo > 0 else 'NOT distinguishable from zero'}")

    # And which single weather variable carries it?
    print("\nwhich part of the weather is doing the work (observed, no noise):")
    for name, cols in [("temperature only", ["temp"]),
                       ("wind only", ["wind_mph", "wind_out", "wind_in"]),
                       ("roof + day/night only", ["is_dome", "is_day"])]:
        p = fit(df, SERVABLE + cols, tr, te, y)
        print(f"  {name:24s} auc={auc(yte, p):.5f}  ({auc(yte, p) - a_serv:+.5f})")

    json.dump(dict(baseline=a_base, servable=a_serv, levels=out,
                   forecast_ci=[lo, hi]),
              open(os.path.join(HERE, "weather_sensitivity.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
