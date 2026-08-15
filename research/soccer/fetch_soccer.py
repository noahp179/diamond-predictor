"""
Collect match and player data for one competition from ESPN's public soccer API.

One scoreboard call returns a whole season (306-380 matches depending on the
league); one summary call per match returns both team rosters with per-player
match stats (shots, shots on target, goals, assists, cards, fouls, saves) plus
the closing 1X2 moneylines.

Unlike the MLB work, the market price IS available here — every model in the
bake-off can be benchmarked against the closing line.

Outputs (research/soccer/data/<league>):
  matches.csv        one row per match: teams, score, result, 1X2 odds
  player_matches.csv one row per (match, player): stats + starter/sub status

Raw JSON is cached under the scratchpad, keyed by league, so re-runs are
instant and a re-fetch of one competition never invalidates another.

Usage: python3 fetch_soccer.py --league laliga
"""

import argparse
import json
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import requests

from leagues import SEASONS, add_league_arg, get as get_league

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_ROOT = os.environ.get(
    "SOCCER_CACHE",
    "/tmp/claude-0/-home-user-diamond-predictor/8eb2dd74-712a-5179-bb60-2ffb42ffa173/scratchpad/soccer",
)
SESSION = requests.Session()

# Set by main() once the league is known.
LEAGUE = None
DATA = None
CACHE = None
BASE = None


def get(url, tries=4, timeout=45):
    for a in range(tries):
        try:
            r = SESSION.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(0.7 * (a + 1))
    return None


def season_events(season):
    d = get(f"{BASE}/scoreboard?dates={season}0801-{season + 1}0601&limit=1000")
    out = []
    for e in (d or {}).get("events", []):
        c = e["competitions"][0]
        if not c["status"]["type"]["completed"]:
            continue
        home = next(x for x in c["competitors"] if x["homeAway"] == "home")
        away = next(x for x in c["competitors"] if x["homeAway"] == "away")
        try:
            hs, as_ = int(home["score"]), int(away["score"])
        except (TypeError, ValueError):
            continue
        out.append(dict(
            matchId=e["id"], season=season, date=e["date"][:10],
            home_id=home["team"]["id"], away_id=away["team"]["id"],
            home=home["team"]["abbreviation"], away=away["team"]["abbreviation"],
            home_name=home["team"].get("displayName", ""),
            away_name=away["team"].get("displayName", ""),
            home_goals=hs, away_goals=as_,
            result="H" if hs > as_ else ("A" if as_ > hs else "D"),
            venue=(c.get("venue") or {}).get("fullName", ""),
            neutral=bool(c.get("neutralSite")),
        ))
    return out


def summary(match_id):
    fp = os.path.join(CACHE, f"{match_id}.json")
    if os.path.exists(fp):
        try:
            return json.load(open(fp))
        except Exception:
            pass
    d = get(f"{BASE}/summary?event={match_id}")
    if d:
        json.dump(d, open(fp, "w"))
    return d


def american_to_prob(ml):
    """American moneyline -> implied probability (with the vig still in)."""
    try:
        ml = float(ml)
    except (TypeError, ValueError):
        return None
    return 100 / (ml + 100) if ml > 0 else (-ml) / (-ml + 100)


def parse_odds(d):
    for pc in (d or {}).get("pickcenter", []) or []:
        h = (pc.get("homeTeamOdds") or {}).get("moneyLine")
        a = (pc.get("awayTeamOdds") or {}).get("moneyLine")
        dr = (pc.get("drawOdds") or {}).get("moneyLine")
        ph, pa, pd_ = american_to_prob(h), american_to_prob(a), american_to_prob(dr)
        if ph and pa and pd_:
            s = ph + pa + pd_          # de-vig by normalising
            return dict(odds_home=h, odds_away=a, odds_draw=dr,
                        mkt_home=ph / s, mkt_draw=pd_ / s, mkt_away=pa / s,
                        overround=s, total_line=pc.get("overUnder"))
    return {}


NUMERIC = ["totalShots", "shotsOnTarget", "totalGoals", "goalAssists", "yellowCards",
           "redCards", "foulsCommitted", "foulsSuffered", "saves", "shotsFaced",
           "goalsConceded", "ownGoals", "appearances", "subIns"]


def parse_players(match, d):
    rows = []
    for side in (d or {}).get("rosters", []) or []:
        team_id = (side.get("team") or {}).get("id")
        home_away = side.get("homeAway")
        for p in side.get("roster", []) or []:
            ath = p.get("athlete") or {}
            stats = {s.get("name"): s.get("value") for s in (p.get("stats") or [])}
            if not ath.get("id"):
                continue
            rec = dict(
                matchId=match["matchId"], season=match["season"], date=match["date"],
                player_id=ath["id"], name=ath.get("displayName", ""),
                team_id=team_id, is_home=int(home_away == "home"),
                opp_id=match["away_id"] if home_away == "home" else match["home_id"],
                pos=(p.get("position") or {}).get("abbreviation", ""),
                starter=int(bool(p.get("starter"))),
                subbed_in=int(bool(p.get("subbedIn"))),
                subbed_out=int(bool(p.get("subbedOut"))),
                formation_place=p.get("formationPlace"),
            )
            for k in NUMERIC:
                try:
                    rec[k] = float(stats.get(k) or 0)
                except (TypeError, ValueError):
                    rec[k] = 0.0
            # ESPN gives no minutes; approximate from the substitution flags so
            # per-90 rates are possible. Starters who finish get 90.
            rec["mins_est"] = (
                90.0 if rec["starter"] and not rec["subbed_out"]
                else 65.0 if rec["starter"]
                else 25.0 if rec["subbed_in"]
                else 0.0
            )
            rows.append(rec)
    return rows


def main():
    global LEAGUE, DATA, CACHE, BASE
    ap = add_league_arg(argparse.ArgumentParser(description=__doc__))
    LEAGUE = get_league(ap.parse_args().league)
    DATA = os.path.join(HERE, "data", LEAGUE.slug)
    CACHE = os.path.join(CACHE_ROOT, LEAGUE.slug)
    BASE = f"https://site.api.espn.com/apis/site/v2/sports/soccer/{LEAGUE.espn}"
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    print(f"{LEAGUE.name} ({LEAGUE.country}) — ESPN {LEAGUE.espn}, "
          f"{LEAGUE.teams} clubs\n", flush=True)

    matches = []
    for s in SEASONS:
        ev = season_events(s)
        print(f"{s}-{str(s + 1)[2:]}: {len(ev)} completed matches", flush=True)
        matches += ev
    print(f"total matches: {len(matches)}", flush=True)
    if not matches:
        raise SystemExit(f"no completed matches for {LEAGUE.slug}; check the ESPN code")

    results, t0 = {}, time.time()
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(summary, m["matchId"]): m for m in matches}
        done = 0
        for fut in as_completed(futs):
            results[futs[fut]["matchId"]] = fut.result()
            done += 1
            if done % 250 == 0:
                print(f"  {done}/{len(matches)} ({time.time() - t0:.0f}s)", flush=True)

    players, odds_hits = [], 0
    for m in matches:
        d = results.get(m["matchId"])
        o = parse_odds(d)
        if o:
            odds_hits += 1
        m.update(o)
        players += parse_players(m, d)

    md = pd.DataFrame(matches)
    pd_df = pd.DataFrame(players)
    md.insert(1, "league", LEAGUE.slug)
    pd_df.insert(1, "league", LEAGUE.slug)
    md.to_csv(os.path.join(DATA, "matches.csv"), index=False)
    pd_df.to_csv(os.path.join(DATA, "player_matches.csv"), index=False)
    print(f"\nmatches: {len(md):,}  with odds: {odds_hits:,} ({odds_hits / len(md):.1%})")
    print(f"player-matches: {len(pd_df):,}  starters: {int(pd_df.starter.sum()):,}")
    print(f"home win {(md.result == 'H').mean():.3f} | draw {(md.result == 'D').mean():.3f} | "
          f"away {(md.result == 'A').mean():.3f}")
    print(f"goals/match {(md.home_goals + md.away_goals).mean():.2f}")


if __name__ == "__main__":
    main()
