"""
Collect the context the models have never seen.

Everything the prop and game models use today comes from box scores — rates,
usage, matchups. This pulls the things that are *not* in a box score and that a
bettor can know before first pitch:

  weather      temperature, sky condition, wind speed and direction
  roof         open / dome / retractable, per venue
  umpire       the home-plate umpire (strike zones differ, K props care)
  handedness   batter side and pitcher throwing hand -> the platoon matchup
  schedule     day or night, venue coordinates (for travel), doubleheaders

Outputs (research/mlb-props/data):
  game_context.csv   one row per game
  player_hands.csv   one row per player
  venues.csv         roof type + coordinates

Raw JSON is cached in the scratchpad, so re-runs are instant.
"""

import json
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import requests

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.environ.get(
    "MLB_CTX_CACHE",
    "/tmp/claude-0/-home-user-diamond-predictor/8eb2dd74-712a-5179-bb60-2ffb42ffa173/scratchpad/mlbctx",
)
os.makedirs(DATA, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)
API = "https://statsapi.mlb.com/api"
SESSION = requests.Session()

FEED_FIELDS = (
    "gameData,datetime,dayNight,officialDate,weather,condition,temp,wind,venue,id,name,"
    "liveData,boxscore,officials,official,fullName,officialType"
)


def get(url, tries=4, timeout=30):
    for a in range(tries):
        try:
            r = SESSION.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(0.8 * (a + 1))
    return None


def feed(gamePk):
    fp = os.path.join(CACHE, f"{gamePk}.json")
    if os.path.exists(fp):
        try:
            return json.load(open(fp))
        except Exception:
            pass
    d = get(f"{API}/v1.1/game/{gamePk}/feed/live?fields={FEED_FIELDS}")
    if d:
        json.dump(d, open(fp, "w"))
    return d


def parse_wind(w):
    """'6 mph, R To L' -> (6.0, 'R To L'). Domes report '0 mph, None'."""
    try:
        speed, _, direction = str(w or "").partition(",")
        return float(speed.replace("mph", "").strip() or 0), direction.strip() or "None"
    except Exception:
        return 0.0, "None"


def parse_feed(gamePk, d):
    if not d:
        return None
    gd = d.get("gameData", {})
    w = gd.get("weather", {}) or {}
    speed, direction = parse_wind(w.get("wind"))
    hp = None
    for o in (d.get("liveData", {}).get("boxscore", {}) or {}).get("officials", []) or []:
        if o.get("officialType") == "Home Plate":
            hp = (o.get("official") or {}).get("fullName")
    try:
        temp = float(w.get("temp"))
    except (TypeError, ValueError):
        temp = None
    return dict(
        gamePk=gamePk,
        date=(gd.get("datetime") or {}).get("officialDate"),
        day_night=(gd.get("datetime") or {}).get("dayNight"),
        venue_id=(gd.get("venue") or {}).get("id"),
        venue=(gd.get("venue") or {}).get("name"),
        condition=w.get("condition"),
        temp=temp,
        wind_mph=speed,
        wind_dir=direction,
        hp_umpire=hp,
    )


def collect_games():
    metas = pd.read_csv(os.path.join(DATA, "game_meta.csv"))
    pks = metas.gamePk.tolist()
    print(f"fetching context for {len(pks):,} games", flush=True)
    rows = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=24) as ex:
        futs = {ex.submit(feed, pk): pk for pk in pks}
        done = 0
        for fut in as_completed(futs):
            pk = futs[fut]
            r = parse_feed(pk, fut.result())
            if r:
                rows.append(r)
            done += 1
            if done % 1000 == 0:
                print(f"  {done}/{len(pks)} ({time.time() - t0:.0f}s)", flush=True)
    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(DATA, "game_context.csv"), index=False)
    print(f"game_context: {len(df):,} rows  "
          f"temp coverage {df.temp.notna().mean():.1%}  "
          f"umpire coverage {df.hp_umpire.notna().mean():.1%}")
    return df


def collect_venues():
    d = get(f"{API}/v1/venues?season=2026&hydrate=fieldInfo,location"
            f"&fields=venues,id,name,fieldInfo,roofType,turfType,location,defaultCoordinates,"
            f"latitude,longitude")
    rows = []
    for v in (d or {}).get("venues", []):
        c = (v.get("location") or {}).get("defaultCoordinates") or {}
        rows.append(dict(venue_id=v.get("id"), venue=v.get("name"),
                         roof=(v.get("fieldInfo") or {}).get("roofType"),
                         turf=(v.get("fieldInfo") or {}).get("turfType"),
                         lat=c.get("latitude"), lon=c.get("longitude")))
    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(DATA, "venues.csv"), index=False)
    print(f"venues: {len(df)}  roofs: {df.roof.value_counts().to_dict()}")
    return df


def collect_hands():
    bg = pd.read_csv(os.path.join(DATA, "batter_games.csv"), usecols=["batter_id"])
    pg = pd.read_csv(os.path.join(DATA, "pitcher_games.csv"), usecols=["pitcher_id"])
    ids = sorted(set(bg.batter_id.dropna().astype(int)) | set(pg.pitcher_id.dropna().astype(int)))
    print(f"fetching handedness for {len(ids):,} players", flush=True)
    rows = []
    for i in range(0, len(ids), 300):
        chunk = ids[i:i + 300]
        d = get(f"{API}/v1/people?personIds={','.join(map(str, chunk))}"
                f"&fields=people,id,fullName,batSide,pitchHand,code", timeout=60)
        for p in (d or {}).get("people", []):
            rows.append(dict(player_id=p.get("id"), name=p.get("fullName"),
                             bats=(p.get("batSide") or {}).get("code"),
                             throws=(p.get("pitchHand") or {}).get("code")))
    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(DATA, "player_hands.csv"), index=False)
    print(f"player_hands: {len(df):,}  bats {df.bats.value_counts().to_dict()}  "
          f"throws {df.throws.value_counts().to_dict()}")
    return df


if __name__ == "__main__":
    collect_venues()
    collect_hands()
    collect_games()
