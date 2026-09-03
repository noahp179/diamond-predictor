"""
Temperature at first pitch, from a source the live app can also call.

The weather block measured in features_tb2.py came from MLB's game feed, which
publishes it only once a game is under way — useless to a board rendered in the
morning. weather_sensitivity.py showed the signal is almost entirely
temperature and that ~80% of it survives forecast-grade error, so it is worth
having from a source that exists before first pitch.

Open-Meteo is that source: free, no key, global (which matters for Toronto),
and — the part that makes it usable here — it serves a historical archive from
the same model at the same coordinates. So the model can be *trained* on the
archive and *served* from the forecast, and the two are the same quantity
measured the same way. Training on MLB's thermometer and serving a forecast
would be two different numbers wearing one name.

Outputs (research/mlb-tb2/data):
  venue_temps.csv   gamePk -> temperature at first pitch, in F

Usage: python3 fetch_weather.py
"""

import json
import os
import time
from datetime import datetime, timezone

import pandas as pd
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
SESSION = requests.Session()


def get(url, params, tries=6):
    """Open-Meteo is occasionally flaky from here; back off and retry."""
    for a in range(tries):
        try:
            r = SESSION.get(url, params=params, timeout=90)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:
                time.sleep(10 * (a + 1))
                continue
        except Exception:
            pass
        time.sleep(3 * (a + 1))
    return None


def fetch_coords(venue_ids):
    """Coordinates keyed by venue id, not name — parks get renamed (Dodger
    Stadium, Minute Maid, Guaranteed Rate all changed names inside this data
    set) and the id is what survives."""
    out = {}
    ids = sorted(int(v) for v in venue_ids)
    for i in range(0, len(ids), 40):
        chunk = ids[i:i + 40]
        d = get("https://statsapi.mlb.com/api/v1/venues",
                dict(venueIds=",".join(map(str, chunk)), hydrate="location",
                     fields="venues,id,name,location,defaultCoordinates,"
                            "latitude,longitude"))
        for v in (d or {}).get("venues", []):
            c = (v.get("location") or {}).get("defaultCoordinates") or {}
            if c.get("latitude") is not None:
                out[int(v["id"])] = dict(name=v.get("name", ""),
                                         lat=c["latitude"], lon=c["longitude"])
    return out


def main():
    ctx = pd.read_csv(os.path.join(PROPS, "game_context.csv"))
    meta = pd.read_csv(os.path.join(PROPS, "game_meta.csv"))
    games = meta[["gamePk", "date", "venue"]].merge(
        ctx[["gamePk", "venue_id"]], on="gamePk", how="left"
    )
    games = games[games.venue_id.notna()]
    games["venue_id"] = games.venue_id.astype(int)

    by_id = fetch_coords(games.venue_id.unique())
    json.dump({str(k): v for k, v in by_id.items()},
              open(os.path.join(DATA, "venue_coords.json"), "w"), indent=1)
    venues = sorted(games.venue_id.unique())
    missing = [v for v in venues if v not in by_id]
    print(f"{len(venues)} venues in the data, {len(missing)} without coordinates")
    if missing:
        print("  no coordinates for ids:", missing)

    lo, hi = games.date.min(), games.date.max()
    print(f"archive window {lo} -> {hi}")

    rows = []
    for i, venue in enumerate(venues, 1):
        c = by_id.get(venue)
        if not c:
            continue
        d = get(ARCHIVE, dict(
            latitude=c["lat"], longitude=c["lon"],
            start_date=lo, end_date=hi,
            hourly="temperature_2m", temperature_unit="fahrenheit",
            timezone="UTC",
        ))
        if not d or "hourly" not in d:
            print(f"  [{i}/{len(venues)}] {c['name']}: FAILED")
            continue
        h = d["hourly"]
        temps = dict(zip(h["time"], h["temperature_2m"]))
        rows.append((venue, temps))
        print(f"  [{i}/{len(venues)}] {c['name']}: {len(temps):,} hours", flush=True)

    lookup = dict(rows)
    # match each game to the UTC hour of first pitch
    sched = {}
    for season in (2024, 2025, 2026):
        s = get("https://statsapi.mlb.com/api/v1/schedule",
                dict(sportId=1, gameType="R",
                     startDate=f"{season}-03-01", endDate=f"{season}-11-10"))
        for day in (s or {}).get("dates", []):
            for g in day.get("games", []):
                sched[g["gamePk"]] = g.get("gameDate")

    out = []
    miss = 0
    for r in games.itertuples():
        temps = lookup.get(r.venue_id)
        iso = sched.get(r.gamePk)
        if not temps or not iso:
            miss += 1
            continue
        t = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
        key = t.strftime("%Y-%m-%dT%H:00")
        v = temps.get(key)
        if v is None:
            miss += 1
            continue
        out.append(dict(gamePk=r.gamePk, temp_fc=float(v)))

    df = pd.DataFrame(out)
    df.to_csv(os.path.join(DATA, "venue_temps.csv"), index=False)
    print(f"\nmatched {len(df):,} games, missed {miss}")

    # sanity: does the archive agree with what MLB's thermometer said?
    j = df.merge(ctx[["gamePk", "temp", "condition"]], on="gamePk", how="inner")
    j = j[(j.temp > 0) & (~j.condition.isin(["Dome", "Roof Closed"]))]
    print(f"open-air games with both readings: {len(j):,}")
    print(f"  correlation {j.temp_fc.corr(j.temp):.4f}   "
          f"mean diff {(j.temp_fc - j.temp).mean():+.2f}F   "
          f"MAE {(j.temp_fc - j.temp).abs().mean():.2f}F")


if __name__ == "__main__":
    main()
