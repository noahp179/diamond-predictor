"""
Data collection for the college-football backtests.

Source: the public ESPN college-football API, the same one the app reads live.

    scoreboard?dates=A-B&groups=80   every FBS game in a date range
    summary?event=<id>               one game's box score

Two tables come out of it:

    team_games.csv    one row per (game, team): score, rush/rec TDs scored
    player_games.csv  one row per (game, team, player): carries, receptions,
                      yards and touchdowns

`groups=80` is FBS. Games where an FBS team hosts an FCS one come back too (the
FBS side is in the group), which is what we want: they are on the slate, so the
model has to price them.

What is deliberately NOT collected: betting lines. ESPN serves a `pickcenter`
block for games in the current season and drops it afterwards — 25-game samples
from 2024-10-12, 2025-09-06 and 2025-10-18 returned a total+spread for zero
games. The NFL TD model leans on the market's implied team total; for college
that feature cannot be backtested honestly, so the models here are built from
on-field history alone. See CFB-ANALYSIS.md §1.

Raw JSON is parsed on arrival and only the compact per-event record is cached —
a season of raw summaries is ~400MB, the parsed cache is ~8MB.
"""
import os, sys, json, time, csv
from concurrent.futures import ThreadPoolExecutor
import urllib.request, urllib.error

BASE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "cache")
os.makedirs(CACHE, exist_ok=True)

# 2021-2026. The Elo replay wants the long run; the TD model trains on the last
# three and is tested on 2026, which had not been played when the model was fit.
SEASONS = [int(s) for s in (sys.argv[1:] or [2021, 2022, 2023, 2024, 2025, 2026])]

# A season spans August to mid-January (bowls + playoff).
def season_range(season):
    return f"{season}0801-{season+1}0120"


def get(url, tries=4, timeout=30):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as e:
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    return None


def et_date(iso):
    """The league day. ESPN stamps kickoff in UTC, so a 8pm ET Saturday night
    game is 00:30Z Sunday; filed under Sunday it would leak into Sunday's
    point-in-time features and vanish from Saturday's."""
    from datetime import datetime, timedelta, timezone
    dt = datetime.strptime(iso.replace("Z", "+0000"), "%Y-%m-%dT%H:%M%z")
    return (dt.astimezone(timezone(timedelta(hours=-5)))).strftime("%Y-%m-%d")


def fetch_schedule(season):
    """Every FBS event in a season: id, kickoff, teams, final score."""
    fp = os.path.join(CACHE, f"sched_{season}.json")
    if os.path.exists(fp):
        return json.load(open(fp))
    out, seen = [], set()
    # One call per month keeps each response under the 1000-event cap.
    months = [(season, m) for m in (8, 9, 10, 11, 12)] + [(season + 1, 1)]
    for (y, m) in months:
        last = 31 if m in (8, 10, 12, 1) else 30
        url = f"{BASE}/scoreboard?dates={y}{m:02d}01-{y}{m:02d}{last}&groups=80&limit=1000"
        try:
            d = get(url)
        except Exception as e:
            print(f"  ! {y}-{m:02d}: {e}", flush=True)
            continue
        for ev in d.get("events", []):
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
                "date": et_date(ev["date"]),
                "completed": done,
                "neutral": comp.get("neutralSite") is True,
                "home": side(cs["home"]),
                "away": side(cs["away"]),
            })
    out.sort(key=lambda g: (g["date"], g["id"]))
    json.dump(out, open(fp, "w"))
    return out


def num(v):
    """ESPN stat cells are strings, sometimes 'made/attempts'."""
    try:
        return float(str(v).split("/")[0])
    except Exception:
        return 0.0


def parse_summary(d):
    """Per-team player usage from one box score.

    College box scores carry `receptions`, not `receivingTargets` — ESPN does
    not publish college targets at all. Every share the model builds on the
    receiving side is therefore a share of catches, not of looks.
    """
    comp = ((d.get("header") or {}).get("competitions") or [{}])[0]
    box = (d.get("boxscore") or {}).get("players")
    if not comp or not isinstance(box, list) or not box:
        return None
    home_abbr = None
    for c in comp.get("competitors", []):
        if c.get("homeAway") == "home":
            home_abbr = (c.get("team") or {}).get("abbreviation")
    teams = []
    for tb in box:
        abbr = (tb.get("team") or {}).get("abbreviation")
        tid = str((tb.get("team") or {}).get("id") or "")
        if not abbr:
            continue
        players = {}
        for cat in tb.get("statistics") or []:
            keys = cat.get("keys") or []
            name = cat.get("name")
            if name not in ("rushing", "receiving"):
                continue
            for a in cat.get("athletes") or []:
                ath = a.get("athlete") or {}
                pid = ath.get("id")
                if not pid:
                    continue
                p = players.setdefault(str(pid), {
                    "id": str(pid), "name": ath.get("displayName") or "",
                    "car": 0.0, "rec": 0.0, "ry": 0.0, "cy": 0.0, "rtd": 0.0, "ctd": 0.0,
                })
                s = {k: (a.get("stats") or [None] * len(keys))[i] for i, k in enumerate(keys)}
                if name == "rushing":
                    p["car"] = num(s.get("rushingAttempts"))
                    p["ry"] = num(s.get("rushingYards"))
                    p["rtd"] = num(s.get("rushingTouchdowns"))
                else:
                    p["rec"] = num(s.get("receptions"))
                    p["cy"] = num(s.get("receivingYards"))
                    p["ctd"] = num(s.get("receivingTouchdowns"))
        pl = list(players.values())
        teams.append({
            "abbr": abbr, "id": tid, "isHome": abbr == home_abbr, "players": pl,
            "rushTd": sum(p["rtd"] for p in pl), "recTd": sum(p["ctd"] for p in pl),
        })
    if len(teams) != 2:
        return None
    return {"date": et_date(str(comp.get("date"))), "teams": teams}


def fetch_box(eid):
    fp = os.path.join(CACHE, f"box_{eid}.json")
    if os.path.exists(fp):
        try:
            return json.load(open(fp))
        except Exception:
            pass
    v = None
    try:
        v = parse_summary(get(f"{BASE}/summary?event={eid}"))
    except Exception as e:
        print(f"  ! box {eid}: {e}", flush=True)
    json.dump(v, open(fp, "w"))
    return v


def main():
    sched_rows, team_rows, player_rows = [], [], []
    for season in SEASONS:
        t0 = time.time()
        games = fetch_schedule(season)
        done = [g for g in games if g["completed"] and g["home"]["score"] is not None]
        print(f"[{season}] {len(games)} games, {len(done)} completed — box scores…", flush=True)
        with ThreadPoolExecutor(8) as ex:
            boxes = list(ex.map(lambda g: fetch_box(g["id"]), done))
        ok = 0
        for g, b in zip(done, boxes):
            sched_rows.append({
                "game_id": g["id"], "season": season, "date": g["date"],
                "neutral": int(g["neutral"]),
                "home_id": g["home"]["id"], "home": g["home"]["abbr"], "home_score": g["home"]["score"],
                "away_id": g["away"]["id"], "away": g["away"]["abbr"], "away_score": g["away"]["score"],
                "boxscore": int(b is not None),
            })
            if not b:
                continue
            ok += 1
            for t in b["teams"]:
                opp = [x for x in b["teams"] if x["abbr"] != t["abbr"]]
                opp = opp[0] if opp else None
                pts = g["home"]["score"] if t["abbr"] == g["home"]["abbr"] else g["away"]["score"]
                opp_pts = g["away"]["score"] if t["abbr"] == g["home"]["abbr"] else g["home"]["score"]
                team_rows.append({
                    "game_id": g["id"], "season": season, "date": g["date"],
                    "team": t["abbr"], "team_id": t["id"], "is_home": int(t["isHome"]),
                    "opp": opp["abbr"] if opp else "", "points": pts, "opp_points": opp_pts,
                    "rush_td": int(t["rushTd"]), "rec_td": int(t["recTd"]),
                })
                for p in t["players"]:
                    if p["car"] + p["rec"] <= 0:
                        continue
                    player_rows.append({
                        "game_id": g["id"], "season": season, "date": g["date"],
                        "team": t["abbr"], "player_id": p["id"], "player": p["name"],
                        "car": int(p["car"]), "rec": int(p["rec"]),
                        "rush_yds": int(p["ry"]), "rec_yds": int(p["cy"]),
                        "rush_td": int(p["rtd"]), "rec_td": int(p["ctd"]),
                        "scored": int(p["rtd"] + p["ctd"] > 0),
                    })
        print(f"[{season}] {ok}/{len(done)} box scores parsed in {time.time()-t0:.0f}s", flush=True)

    def write(name, rows):
        if not rows:
            return
        with open(os.path.join(DATA, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {name}: {len(rows):,} rows", flush=True)

    if os.environ.get("CFB_WARM"):
        print("warm-only run: cache filled, CSVs left to the full pass", flush=True)
        return

    write("games.csv", sched_rows)
    write("team_games.csv", team_rows)
    write("player_games.csv", player_rows)


if __name__ == "__main__":
    main()
