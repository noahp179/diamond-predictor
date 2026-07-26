"""
Extract red-zone / goal-line usage from the cached ESPN play-by-play.

For every play we know the possessing team (drive.team), the field position
(play.start.yardsToEndzone) and the ball-carrier / target (parsed from the play
text). We attribute inside-20 / inside-10 / inside-5 carries and targets to the
player, matched to the box score by first-initial + last name.

Goal-line touches are the single most-cited missing signal for TD scoring; this
turns the cached data into that feature. Output: data/rz_usage.csv.
"""
import os, re, glob, json, warnings
import pandas as pd
import nfl_data_py as nfl

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.environ.get(
    "ESPN_CACHE",
    "/tmp/claude-0/-home-user-diamond-predictor/baf68327-288b-55a2-bd0e-f7a6ee6b3fda/scratchpad/nfltd/cache",
)

NAME = re.compile(r"([A-Z][A-Za-z]?)\.\s?([A-Za-z][A-Za-z'\-\.]+)")


def keyify(initial, last):
    return (initial[0].upper(), re.sub(r"[^a-z]", "", last.lower()))


def espn_to_gameid():
    s = nfl.import_schedules([2021, 2022, 2023, 2024])
    s = s[s["espn"].notna()]
    return {str(int(e)): g for e, g in zip(s["espn"], s["game_id"])}


def box_name_maps():
    """(game_id, team) -> {(initial,last): player_id}."""
    pg = pd.read_csv(os.path.join(DATA, "player_games.csv"))
    pg["player_id"] = pg.player_id.astype(str)
    maps = {}
    for r in pg.itertuples():
        toks = str(r.player).split()
        if len(toks) < 2:
            continue
        k = keyify(toks[0], toks[-1])
        maps.setdefault((r.game_id, r.team), {})[k] = r.player_id
    return maps


def rusher(text):
    m = NAME.search(text)
    return keyify(*m.groups()) if m else None


def target(text):
    m = re.search(r"\bto\s+([A-Z][A-Za-z]?)\.\s?([A-Za-z][A-Za-z'\-\.]+)", text)
    return keyify(*m.groups()) if m else None


def main():
    e2g = espn_to_gameid()
    maps = box_name_maps()
    rows = {}
    files = glob.glob(os.path.join(CACHE, "*.json"))
    matched = attempted = 0
    for fp in files:
        eid = os.path.basename(fp)[:-5]
        gid = e2g.get(eid)
        if not gid:
            continue
        try:
            d = json.load(open(fp))
        except Exception:
            continue
        for drv in d.get("drives", {}).get("previous", []):
            team = drv.get("team", {}).get("abbreviation")
            nm = maps.get((gid, team))
            if not nm:
                continue
            for p in drv.get("plays", []):
                y = p.get("start", {}).get("yardsToEndzone")
                t = p.get("type", {}).get("text", "") or ""
                txt = p.get("text", "") or ""
                if y is None or y > 20:
                    continue
                is_rush = t in ("Rush", "Rushing Touchdown")
                is_pass = t in ("Pass Reception", "Pass Incompletion", "Passing Touchdown")
                if not (is_rush or is_pass):
                    continue
                key = rusher(txt) if is_rush else target(txt)
                if key is None:
                    continue
                attempted += 1
                pid = nm.get(key)
                if pid is None:
                    continue
                matched += 1
                r = rows.setdefault((gid, pid), dict(
                    game_id=gid, player_id=pid,
                    rz20_car=0, rz20_tgt=0, rz10_car=0, rz10_tgt=0, rz5_car=0, rz5_tgt=0))
                if is_rush:
                    r["rz20_car"] += 1
                    if y <= 10: r["rz10_car"] += 1
                    if y <= 5: r["rz5_car"] += 1
                else:
                    r["rz20_tgt"] += 1
                    if y <= 10: r["rz10_tgt"] += 1
                    if y <= 5: r["rz5_tgt"] += 1

    df = pd.DataFrame(rows.values())
    df.to_csv(os.path.join(DATA, "rz_usage.csv"), index=False)
    print(f"games with pbp: {sum(1 for f in files if os.path.basename(f)[:-5] in e2g)}")
    print(f"RZ touches attempted={attempted:,}  matched to a player={matched:,} "
          f"({matched/max(attempted,1)*100:.1f}%)")
    print(f"rows (player-games with RZ usage): {len(df):,}")

    # sanity: does goal-line usage predict TDs?
    pg = pd.read_csv(os.path.join(DATA, "player_games.csv"))
    pg["player_id"] = pg.player_id.astype(str)
    pg["scored"] = ((pg.rush_td + pg.rec_td) > 0).astype(int)
    m = pg.merge(df, on=["game_id", "player_id"], how="left").fillna(0)
    print("\nAnytime-TD rate by inside-5 carries (same game):")
    for lo, hi, lbl in [(0, 0, "0"), (1, 1, "1"), (2, 2, "2"), (3, 99, "3+")]:
        s = m[(m.rz5_car >= lo) & (m.rz5_car <= hi)]
        if len(s): print(f"  gl carries {lbl:3s}: n={len(s):6d}  TD rate={s.scored.mean()*100:4.1f}%")


if __name__ == "__main__":
    main()
