"""
Data collection for the NFL anytime-TD-scorer backtest.

Sources (both reachable from this environment; GitHub *release* assets are not):
  - Game list + ESPN game ids : nflverse schedules (raw.githubusercontent.com)
  - Per-game box scores + scoring plays : ESPN summary API (site.api.espn.com)

For every game we produce three tidy tables:
  player_games.csv  - one row per (game, player): carries/targets/receptions/yards/TDs
  td_scorers.csv    - one row per touchdown actually scored (ground truth)
  team_games.csv    - one row per (game, team): offensive rush/rec TDs, points

Raw ESPN JSON is cached to a scratchpad dir so re-runs are instant and resumable.
Only the compact parsed CSVs are written into the repo.
"""
import os, re, sys, json, time, warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

warnings.filterwarnings("ignore")

SEASONS = [2021, 2022, 2023, 2024]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
CACHE_DIR = os.environ.get(
    "ESPN_CACHE",
    "/tmp/claude-0/-home-user-diamond-predictor/baf68327-288b-55a2-bd0e-f7a6ee6b3fda/scratchpad/nfltd/cache",
)
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eid}"

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def norm_name(name: str) -> str:
    """Normalize a player name for matching across ESPN text vs box score."""
    n = name.lower().strip()
    n = n.replace(".", "").replace("'", "").replace("`", "")
    n = re.sub(r"[^a-z\s-]", "", n)
    toks = [t for t in n.split() if t and t not in SUFFIXES]
    return " ".join(toks)


def get_game_list():
    import nfl_data_py as nfl
    sched = nfl.import_schedules(SEASONS)
    # keep only games that have been played (a final result) and have an espn id
    sched = sched[sched["espn"].notna() & sched["result"].notna()].copy()
    sched["espn"] = sched["espn"].astype("int64").astype(str)
    keep = ["game_id", "season", "game_type", "week", "gameday",
            "away_team", "home_team", "away_score", "home_score", "espn"]
    return sched[keep].reset_index(drop=True)


def fetch_summary(eid: str) -> dict | None:
    cache_fp = os.path.join(CACHE_DIR, f"{eid}.json")
    if os.path.exists(cache_fp):
        try:
            with open(cache_fp) as f:
                return json.load(f)
        except Exception:
            pass
    for attempt in range(4):
        try:
            r = requests.get(SUMMARY.format(eid=eid), timeout=30)
            if r.status_code == 200:
                d = r.json()
                with open(cache_fp, "w") as f:
                    json.dump(d, f)
                return d
        except Exception:
            pass
        time.sleep(1.5 * (attempt + 1))
    return None


def _to_int(x):
    try:
        return int(float(str(x).split("/")[0]))
    except Exception:
        return 0


def parse_summary(meta: dict, d: dict):
    """Return (player_rows, td_rows, team_rows) for one game."""
    gid = meta["game_id"]
    players = {}          # aid -> row
    team_of = {}          # normalized display name -> team (for scorer matching)

    bs = d.get("boxscore", {})
    for team_block in bs.get("players", []):
        tabbr = team_block.get("team", {}).get("abbreviation")
        for cat in team_block.get("statistics", []):
            cname = cat.get("name")
            if cname not in ("passing", "rushing", "receiving"):
                continue
            keys = cat.get("keys", [])
            for ath in cat.get("athletes", []):
                a = ath.get("athlete", {})
                aid = a.get("id")
                if not aid:
                    continue
                stats = dict(zip(keys, ath.get("stats", [])))
                row = players.setdefault(aid, {
                    "game_id": gid, "player_id": aid,
                    "player": a.get("displayName", ""),
                    "player_norm": norm_name(a.get("displayName", "")),
                    "team": tabbr,
                    "carries": 0, "rush_yds": 0, "rush_td": 0,
                    "targets": 0, "rec": 0, "rec_yds": 0, "rec_td": 0,
                    "pass_att": 0, "pass_td": 0,
                })
                if cname == "rushing":
                    row["carries"] = _to_int(stats.get("rushingAttempts"))
                    row["rush_yds"] = _to_int(stats.get("rushingYards"))
                    row["rush_td"] = _to_int(stats.get("rushingTouchdowns"))
                elif cname == "receiving":
                    row["rec"] = _to_int(stats.get("receptions"))
                    row["rec_yds"] = _to_int(stats.get("receivingYards"))
                    row["rec_td"] = _to_int(stats.get("receivingTouchdowns"))
                    row["targets"] = _to_int(stats.get("receivingTargets"))
                elif cname == "passing":
                    row["pass_att"] = _to_int(stats.get("passingAttempts") or
                                              (stats.get("completions/passingAttempts")))
                    row["pass_td"] = _to_int(stats.get("passingTouchdowns"))
                team_of[row["player_norm"]] = tabbr

    player_rows = list(players.values())

    # ---- ground truth: touchdown scorers (parsed from scoring-play text) ----
    # ESPN uses two text formats; classify with case-insensitive markers and
    # extract the leading name as the scorer. This table is used for reporting
    # and to surface non-box-score (defensive / special-teams) scorers. The
    # model's per-player labels and team rush/rec splits come from the box
    # score below, so they do not depend on this text parsing.
    td_rows = []
    SPLIT = re.compile(
        r"\s+\d+\s+Yd(?:s)?\b|\s+\d+\s+Yard(?:s)?\b|\s+Pass\s+From\b|"
        r"\s+Fumble\s+Recovery\b|\s+Interception\s+Return\b|\s+Fumble\s+Return\b|"
        r"\s+Blocked\b|\s+Kickoff\s+Return\b|\s+Punt\s+Return\b",
        re.I)
    for sp in d.get("scoringPlays", []):
        if sp.get("type", {}).get("abbreviation") != "TD":
            continue
        text = (sp.get("text", "") or "").strip()
        team = sp.get("team", {}).get("abbreviation")
        low = text.lower()
        if "pass from" in low:
            channel = "rec"
        elif re.search(r"\byd\s+run\b", low) or re.search(r"\byard\s+rush\b", low):
            channel = "rush"
        elif "interception return" in low:
            channel = "def"
        elif "fumble recovery" in low or "fumble return" in low or "blocked" in low:
            channel = "def"
        elif "kickoff return" in low or "punt return" in low:
            channel = "st"
        else:
            channel = "other"
        scorer = SPLIT.split(text)[0].strip().rstrip(",").strip()
        td_rows.append({
            "game_id": gid, "team": team, "scorer": scorer,
            "scorer_norm": norm_name(scorer), "channel": channel, "text": text,
        })

    # ---- team-game aggregates (from the box score; text-independent) ----
    team_rows = []
    for tabbr in {meta["home_team"], meta["away_team"]}:
        opp = meta["away_team"] if tabbr == meta["home_team"] else meta["home_team"]
        pts = meta["home_score"] if tabbr == meta["home_team"] else meta["away_score"]
        rush_td = sum(r["rush_td"] for r in player_rows if r["team"] == tabbr)
        rec_td = sum(r["rec_td"] for r in player_rows if r["team"] == tabbr)
        team_rows.append({
            "game_id": gid, "season": meta["season"], "week": meta["week"],
            "game_type": meta["game_type"], "gameday": meta["gameday"],
            "team": tabbr, "opp": opp, "points": pts,
            "rush_td": int(rush_td), "rec_td": int(rec_td),
            "off_td": int(rush_td + rec_td),
        })

    for r in player_rows:
        r.update({"season": meta["season"], "week": meta["week"],
                  "game_type": meta["game_type"], "gameday": meta["gameday"],
                  "opp": meta["away_team"] if r["team"] == meta["home_team"] else meta["home_team"]})
    return player_rows, td_rows, team_rows


def main():
    import pandas as pd
    print("Loading game list from nflverse schedules ...")
    games = get_game_list()
    print(f"  {len(games)} played games across seasons {SEASONS}")

    metas = games.to_dict("records")

    # fetch all summaries (threaded, cached)
    print("Fetching ESPN summaries (cached) ...")
    results = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(fetch_summary, m["espn"]): m for m in metas}
        done = 0
        for fut in as_completed(futs):
            m = futs[fut]
            results[m["espn"]] = fut.result()
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(metas)}  ({time.time()-t0:.0f}s)")

    all_players, all_tds, all_teams = [], [], []
    missing = 0
    for m in metas:
        d = results.get(m["espn"])
        if not d:
            missing += 1
            continue
        pr, tr, teamr = parse_summary(m, d)
        all_players += pr
        all_tds += tr
        all_teams += teamr

    print(f"  missing summaries: {missing}")
    pd.DataFrame(all_players).to_csv(os.path.join(DATA_DIR, "player_games.csv"), index=False)
    pd.DataFrame(all_tds).to_csv(os.path.join(DATA_DIR, "td_scorers.csv"), index=False)
    pd.DataFrame(all_teams).to_csv(os.path.join(DATA_DIR, "team_games.csv"), index=False)
    print(f"Wrote {len(all_players)} player-game rows, {len(all_tds)} TD rows, "
          f"{len(all_teams)} team-game rows to {DATA_DIR}")


if __name__ == "__main__":
    main()
