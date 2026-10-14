"""
College-football data for the football-td study: every FBS game 2021-2026 and
its ESPN box score.

    python3 research/football-td/fetch_cfb.py            # 2021..2026
    python3 research/football-td/fetch_cfb.py 2025 2026  # a subset (testing)

Adapted copy of research/cfb/fetch_espn.py. Two changes forced by ESPN:

  * date-RANGE scoreboard queries (`dates=A-B`) now return HTTP 400, and a
    `limit` above 500 is silently ignored (25 events come back). The schedule
    is therefore read one ET day at a time (`dates=YYYYMMDD&groups=80
    &limit=500`), Aug 1 through Jan 31, de-duplicated by event id. Same event
    objects, same fields, as the original range call.
  * a failed summary fetch is not cached as null, so a rerun retries it.

Outputs (same names/columns as research/cfb/data, so features_cfb.py and the
Elo replay read them unchanged):

  data/cache/sched_{season}.json   every FBS event: id, ET date, completed,
                                   neutral, home/away {id, abbr, name, score}
  data/games.csv                   one row per completed game (+ boxscore flag)
  data/team_games.csv              one row per (game, team): points, rush/rec TDs
  data/player_games.csv            one row per (game, team, player) with >=1
                                   carry or reception
  data/cfb_player_box.csv          wide per-player offensive/return box line
  data/box/cfb/{event_id}.json     compact boxscore-lossless parse (common.py)
  data/raw/cfb/{event_id}.json.gz  raw ESPN summary, seasons 2024-2026
"""
import os, sys, json, time, csv
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

BASE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "cache")
DAYS = os.path.join(CACHE, "cfb_days")
BOX = os.path.join(DATA, "box", "cfb")
RAW = os.path.join(DATA, "raw", "cfb")
for d in (CACHE, DAYS, BOX, RAW):
    os.makedirs(d, exist_ok=True)

SEASONS = [int(s) for s in (sys.argv[1:] or [2021, 2022, 2023, 2024, 2025, 2026])]
RAW_SEASONS = {2024, 2025, 2026}
TODAY = date.today()


def fetch_day(day):
    """Scoreboard for one ET day. Days at least 3 days old are cached."""
    key = day.strftime("%Y%m%d")
    fp = os.path.join(DAYS, f"{key}.json")
    if os.path.exists(fp):
        return json.load(open(fp))
    if day > TODAY:
        return []
    d = C.get_json(f"{BASE}/scoreboard?dates={key}&groups=80&limit=500")
    evs = d.get("events", [])
    if (TODAY - day).days >= 3:
        C.write_json_atomic(fp, evs)
    return evs


def fetch_schedule(season):
    days = []
    d = date(season, 8, 1)
    while d <= date(season + 1, 1, 31):
        days.append(d)
        d += timedelta(days=1)
    with ThreadPoolExecutor(8) as ex:
        per_day = list(ex.map(fetch_day, days))
    out, seen = [], set()
    for evs in per_day:
        for ev in evs:
            eid = int(ev["id"])
            if eid in seen:
                continue
            comp = (ev.get("competitions") or [{}])[0]
            cs = {c.get("homeAway"): c for c in comp.get("competitors", [])}
            if "home" not in cs or "away" not in cs:
                continue
            st = ev.get("status", {}).get("type", {})
            done = st.get("completed") is True or st.get("state") == "post"

            def side(c):
                t = c.get("team", {})
                return {
                    "id": str(t.get("id")),
                    "abbr": t.get("abbreviation") or t.get("shortDisplayName") or "?",
                    "name": t.get("shortDisplayName") or t.get("displayName") or "?",
                    "score": int(c["score"]) if str(c.get("score", "")).strip().isdigit() else None,
                }

            seen.add(eid)
            out.append({
                "id": eid,
                "season": season,
                "date": C.et_date(ev["date"]),
                "completed": done,
                "neutral": comp.get("neutralSite") is True,
                "home": side(cs["home"]),
                "away": side(cs["away"]),
                # extra (not in the original cache): kickoff and ESPN week
                "kickoff_utc": ev.get("date"),
                "week": (ev.get("week") or {}).get("number"),
                "season_type": (ev.get("season") or {}).get("type"),
            })
    out.sort(key=lambda g: (g["date"], g["id"]))
    C.write_json_atomic(os.path.join(CACHE, f"sched_{season}.json"), out)
    return out


def fetch_box(g):
    eid, season = g["id"], g["season"]
    fp = os.path.join(BOX, f"{eid}.json")
    rp = os.path.join(RAW, f"{eid}.json.gz")
    need_raw = season in RAW_SEASONS
    if os.path.exists(fp) and (not need_raw or os.path.exists(rp)):
        try:
            return json.load(open(fp)), None
        except Exception:
            pass
    if need_raw and os.path.exists(rp):
        try:
            v = C.compact_box(C.load_raw(rp), "cfb", eid)
            C.write_json_atomic(fp, v)
            return v, None
        except Exception:
            pass
    try:
        raw = C.get_bytes(f"{BASE}/summary?event={eid}")
        d = json.loads(raw)
    except Exception as e:
        return None, f"{eid}: {str(e)[:80]}"
    if need_raw:
        C.save_raw(rp, raw)
    v = C.compact_box(d, "cfb", eid)
    C.write_json_atomic(fp, v)
    return v, None


def main():
    sched_rows, team_rows, player_rows, wide = [], [], [], []
    for season in SEASONS:
        t0 = time.time()
        games = fetch_schedule(season)
        done = [g for g in games if g["completed"] and g["home"]["score"] is not None]
        print(f"[{season}] {len(games)} games, {len(done)} completed — box scores…", flush=True)
        with ThreadPoolExecutor(8) as ex:
            res = list(ex.map(fetch_box, done))
        errs = [e for _, e in res if e]
        for e in errs[:10]:
            print("  ! box", e, flush=True)
        ok = 0
        for g, (b, _) in zip(done, res):
            # the research parser's view of the box (None unless two teams)
            teams = C.usage_from_box(b, "receptions") if b else None
            if teams is not None and len(teams) != 2:
                teams = None
            sched_rows.append({
                "game_id": g["id"], "season": season, "date": g["date"],
                "neutral": int(g["neutral"]),
                "home_id": g["home"]["id"], "home": g["home"]["abbr"], "home_score": g["home"]["score"],
                "away_id": g["away"]["id"], "away": g["away"]["abbr"], "away_score": g["away"]["score"],
                "boxscore": int(teams is not None),
            })
            if not teams:
                continue
            ok += 1
            for w in C.player_box_rows(b):
                wide.append({"season": season, "date": g["date"], **w})
            for t in teams:
                opp = [x for x in teams if x["abbr"] != t["abbr"]]
                opp = opp[0] if opp else None
                pts = g["home"]["score"] if t["abbr"] == g["home"]["abbr"] else g["away"]["score"]
                opp_pts = g["away"]["score"] if t["abbr"] == g["home"]["abbr"] else g["home"]["score"]
                team_rows.append({
                    "game_id": g["id"], "season": season, "date": g["date"],
                    "team": t["abbr"], "team_id": t["id"], "is_home": int(t["home_away"] == "home"),
                    "opp": opp["abbr"] if opp else "", "points": pts, "opp_points": opp_pts,
                    "rush_td": int(t["rushTd"]), "rec_td": int(t["recTd"]),
                })
                for p in t["players"]:
                    if p["car"] + p["rc"] <= 0:
                        continue
                    player_rows.append({
                        "game_id": g["id"], "season": season, "date": g["date"],
                        "team": t["abbr"], "player_id": p["id"], "player": p["name"],
                        "car": int(p["car"]), "rec": int(p["rc"]),
                        "rush_yds": int(p["ry"]), "rec_yds": int(p["cy"]),
                        "rush_td": int(p["rtd"]), "rec_td": int(p["ctd"]),
                        "scored": int(p["rtd"] + p["ctd"] > 0),
                        "team_id": t["id"],
                    })
        print(f"[{season}] {ok}/{len(done)} box scores parsed in {time.time()-t0:.0f}s "
              f"({len(errs)} fetch errors)", flush=True)

    def write(name, rows):
        if not rows:
            return
        with open(os.path.join(DATA, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"wrote data/{name}: {len(rows):,} rows", flush=True)

    write("games.csv", sched_rows)
    write("team_games.csv", team_rows)
    write("player_games.csv", player_rows)
    write("cfb_player_box.csv", wide)


if __name__ == "__main__":
    main()
