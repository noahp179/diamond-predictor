"""
NFL data for the football-td study: nflverse schedule + closing lines, ESPN box
scores for 2021-2026.

    python3 research/football-td/fetch_nfl.py            # 2021..2026
    python3 research/football-td/fetch_nfl.py 2025 2026  # a subset (testing)

Adapted copy of research/nfl-td-scorer/fetch_nfl.py. The derived research
tables (nfl_games.csv / nfl_player_games.csv) are byte-for-byte the same
construction as the original, so features_nfl.py sees the same inputs the
shipped ranker was fitted on. What is added:

  * every summary is kept as a compact, boxscore-lossless JSON
    (data/box/nfl/{event_id}.json, format in common.py) — it is also the cache;
  * the raw ESPN summary for 2024, 2025 and 2026 games is archived gzipped at
    data/raw/nfl/{event_id}.json.gz;
  * data/nfl_player_box.csv — one wide row per (game, team, player) with
    passing / rushing / receiving / fumble / return stats;
  * data/nfl_schedule.csv — the nflverse rows used (game_type, week, lines).

A failed fetch is NOT cached as null (the original did), so a rerun retries it.
"""
import os, sys, csv, json, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

DATA = os.path.join(HERE, "data")
BOX = os.path.join(DATA, "box", "nfl")
RAW = os.path.join(DATA, "raw", "nfl")
CACHE = os.path.join(DATA, "cache")
for d in (BOX, RAW, CACHE):
    os.makedirs(d, exist_ok=True)

ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
NFLVERSE = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
SEASONS = [int(s) for s in (sys.argv[1:] or [2021, 2022, 2023, 2024, 2025, 2026])]
RAW_SEASONS = {2024, 2025, 2026}


def schedule(refresh=True):
    """Completed games with an ESPN id and a market line (same filter as the
    original). The nflverse file is re-downloaded on each run so the 2026
    season stays current; the copy used is kept in data/cache."""
    fp = os.path.join(CACHE, "nflverse_games.csv")
    if refresh or not os.path.exists(fp):
        tmp = fp + ".tmp"
        urllib.request.urlretrieve(NFLVERSE, tmp)
        os.replace(tmp, fp)
    out = []
    with open(fp) as f:
        for r in csv.DictReader(f):
            try:
                season = int(r["season"])
            except (ValueError, KeyError):
                continue
            if season not in SEASONS or not r.get("espn") or r.get("result") in ("", None):
                continue
            try:
                spread_line = float(r["spread_line"])
                total = float(r["total_line"])
                hs, as_ = int(r["home_score"]), int(r["away_score"])
            except (ValueError, KeyError, TypeError):
                continue
            out.append({
                "game_id": str(r["espn"]),
                "season": season,
                "week": int(r["week"]),
                "date": r["gameday"],
                "home": r["home_team"],
                "away": r["away_team"],
                "home_score": hs,
                "away_score": as_,
                # ESPN convention: negative when the home team is favoured.
                "home_spread": -spread_line,
                "total": total,
                "game_type": r.get("game_type", ""),
                "nflverse_game_id": r.get("game_id", ""),
                "gametime": r.get("gametime", ""),
            })
    out.sort(key=lambda g: (g["date"], g["game_id"]))
    return out


def fetch_box(g):
    """Compact box for one game; archives the raw summary for RAW_SEASONS."""
    gid, season = g["game_id"], g["season"]
    fp = os.path.join(BOX, f"{gid}.json")
    rp = os.path.join(RAW, f"{gid}.json.gz")
    need_raw = season in RAW_SEASONS
    if os.path.exists(fp) and (not need_raw or os.path.exists(rp)):
        try:
            return json.load(open(fp)), None
        except Exception:
            pass
    if need_raw and os.path.exists(rp):
        try:
            v = C.compact_box(C.load_raw(rp), "nfl", gid)
            C.write_json_atomic(fp, v)
            return v, None
        except Exception:
            pass
    try:
        raw = C.get_bytes(f"{ESPN}/summary?event={gid}")
        d = json.loads(raw)
    except Exception as e:
        return None, f"{gid}: {str(e)[:80]}"
    if need_raw:
        C.save_raw(rp, raw)
    v = C.compact_box(d, "nfl", gid)
    C.write_json_atomic(fp, v)
    return v, None


def main():
    games = schedule()
    print(f"{len(games)} completed games with an ESPN id and a market line "
          f"(seasons {SEASONS})", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(fetch_box, games))
    errs = [e for _, e in res if e]
    for e in errs[:20]:
        print("  ! box", e, flush=True)
    boxes = [b for b, _ in res]
    print(f"{sum(1 for b in boxes if b)}/{len(games)} box scores in {time.time()-t0:.0f}s "
          f"({len(errs)} fetch errors)", flush=True)

    grows, prows, wide = [], [], []
    for g, b in zip(games, boxes):
        grows.append({k: g[k] for k in ("game_id", "season", "week", "date", "home", "away",
                                        "home_score", "away_score", "home_spread", "total",
                                        "game_type")})
        if not b or len(b["teams"]) != 2:
            continue
        teams = C.usage_from_box(b, "receivingTargets")
        if len(teams) != 2:
            continue
        for w in C.player_box_rows(b):
            side = "home" if w["home_away"] == "home" else "away"
            w = {"season": g["season"], "week": g["week"], "date": g["date"],
                 "game_type": g["game_type"], "nfl_team": g[side], **w}
            wide.append(w)
        # Sides matched by the box score's own home flag, never by name.
        for t in teams:
            is_home = t["home_away"] == "home"
            opp = [x for x in teams if x is not t][0]
            base = {
                "game_id": g["game_id"], "season": g["season"], "week": g["week"],
                "date": g["date"], "team": g["home"] if is_home else g["away"],
                "is_home": int(is_home),
                "team_rush_td": int(t["rushTd"]), "team_rec_td": int(t["recTd"]),
                "opp_rush_td": int(opp["rushTd"]), "opp_rec_td": int(opp["recTd"]),
            }
            for p in t["players"]:
                if p["car"] + p["rc"] <= 0:
                    continue
                prows.append({
                    **base,
                    "player_id": p["id"], "player": p["name"],
                    "car": int(p["car"]), "tgt": int(p["rc"]),
                    "rush_yds": int(p["ry"]), "rec_yds": int(p["cy"]),
                    "rush_td": int(p["rtd"]), "rec_td": int(p["ctd"]),
                    "scored": int(p["rtd"] + p["ctd"] > 0),
                    "espn_team_id": t["id"],
                })

    def write(name, rows):
        with open(os.path.join(DATA, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"wrote data/{name}: {len(rows):,} rows", flush=True)

    write("nfl_games.csv", grows)
    write("nfl_player_games.csv", prows)
    write("nfl_player_box.csv", wide)
    write("nfl_schedule.csv", games)


if __name__ == "__main__":
    main()
