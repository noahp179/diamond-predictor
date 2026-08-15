"""
Collect singles matches for one tour from ESPN's public tennis API.

Two passes, because the feed is organised by tournament rather than by day:

  1. Scan every other date across the season to DISCOVER tournament ids. A
     tournament appears in the scoreboard on any date inside its window.
  2. Fetch each tournament once. One call returns the entire draw — every
     round, every day, including the final — so this is cheap: a season is
     roughly 60-110 tournaments per tour rather than 365 days.

Both tour feeds carry both singles draws (the ATP feed includes womens-singles
and vice versa), so the two are unioned and deduplicated by competition id.
Neither feed alone is complete: in 2025 the ATP feed saw 61 tournaments and the
WTA feed 106.

What the feed does NOT have, and what that costs:
  * no surface        — supplied by the table in tours.py, and validated in the
                        bake-off rather than asserted
  * no serve stats    — `statistics` is empty on every competitor, so aces and
                        double faults cannot be modelled at all
  * no rankings       — only `curatedRank`, the SEED in this draw, which is
                        missing for unseeded players and is a coarse proxy

What it does have is set-by-set linescores, which is enough for the match
winner and for every market derivable from a scoreline: straight sets, total
games, set handicaps, whether a tiebreak happened.

Outputs research/tennis/data/<tour>/matches.csv, one row per singles match.

Usage: python3 fetch_tennis.py --tour wta
"""

import argparse
import datetime
import json
import os
import time
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from tours import SEASONS, add_tour_arg, get as get_tour, surface_of

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://site.api.espn.com/apis/site/v2/sports/tennis"
WORKERS = 16


def get_json(url, tries=4):
    for a in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                return json.load(r)
        except Exception:
            time.sleep(0.6 * (a + 1))
    return {}


def discover(season):
    """Tournament ids active in a season, from either feed."""
    d0 = datetime.date(season, 1, 1)
    dates = [(d0 + datetime.timedelta(days=i)).strftime("%Y%m%d") for i in range(0, 366, 2)]
    jobs = [(feed, dt) for feed in ("atp", "wta") for dt in dates]

    def one(job):
        feed, dt = job
        d = get_json(f"{API}/{feed}/scoreboard?dates={dt}")
        return [(e.get("id"), dt) for e in d.get("events", []) if e.get("id")]

    found = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for rows in ex.map(one, jobs):
            for tid, dt in rows:
                found.setdefault(tid, dt)
    return found


def parse_tournament(tour, event, season):
    """Every completed singles match in one tournament, for this tour's draw."""
    name = event.get("name", "")
    venue = (event.get("venue") or {}).get("displayName", "")
    surface = surface_of(name)
    rows = []

    for g in event.get("groupings", []):
        if (g.get("grouping") or {}).get("slug") != tour.grouping:
            continue
        comps = g.get("competitions", [])
        draw = len(comps)
        for c in comps:
            if not ((c.get("status") or {}).get("type") or {}).get("completed"):
                continue
            cs = c.get("competitors") or []
            if len(cs) != 2:
                continue
            win = next((x for x in cs if x.get("winner")), None)
            los = next((x for x in cs if not x.get("winner")), None)
            if win is None or los is None or win.get("id") == los.get("id"):
                continue

            # Sets and games, from the linescores. A retirement leaves a partial
            # scoreline; it is kept (the winner is still the winner) but flagged,
            # because a retirement is not evidence about who plays better.
            def games(x):
                return [float(ls.get("value") or 0) for ls in (x.get("linescores") or [])]

            wg, lg = games(win), games(los)
            sets = min(len(wg), len(lg))
            w_sets = sum(1 for i in range(sets) if wg[i] > lg[i])
            l_sets = sum(1 for i in range(sets) if lg[i] > wg[i])
            tb = sum(
                1
                for ls in (win.get("linescores") or []) + (los.get("linescores") or [])
                if ls.get("tiebreak") is not None
            )
            note = " ".join(n.get("text", "") for n in (c.get("notes") or []))
            retired = any(k in note.lower() for k in ("ret.", "retired", "walkover", "w/o", "def."))

            rows.append(dict(
                matchId=c.get("id"), season=season, date=(c.get("date") or "")[:10],
                tournamentId=event.get("id"), tournament=name, venue=venue,
                surface=surface, drawSize=draw,
                round=(c.get("round") or {}).get("displayName", ""),
                roundId=(c.get("round") or {}).get("id", ""),
                # The feed's format.regulation.periods says 5 on every match,
                # qualifiers included, so it is unusable. Best-of is recovered
                # from the scoreline instead: only a best-of-five can reach a
                # third set win.
                bestOf=5 if max(w_sets, l_sets) >= 3 else 3,
                winner_id=win.get("id"),
                winner=(win.get("athlete") or {}).get("displayName", ""),
                winner_country=((win.get("athlete") or {}).get("flag") or {}).get("alt", ""),
                winner_seed=(win.get("curatedRank") or {}).get("current"),
                loser_id=los.get("id"),
                loser=(los.get("athlete") or {}).get("displayName", ""),
                loser_country=((los.get("athlete") or {}).get("flag") or {}).get("alt", ""),
                loser_seed=(los.get("curatedRank") or {}).get("current"),
                w_sets=w_sets, l_sets=l_sets,
                w_games=sum(wg[:sets]), l_games=sum(lg[:sets]),
                sets_played=sets, tiebreaks=tb // 2 if tb else 0,
                retired=int(retired),
                score=note,
            ))
    return rows


def main():
    ap = add_tour_arg(argparse.ArgumentParser(description=__doc__))
    tour = get_tour(ap.parse_args().tour)
    data = os.path.join(HERE, "data", tour.slug)
    os.makedirs(data, exist_ok=True)
    print(f"{tour.name} — ESPN {tour.espn}, draw {tour.grouping}\n", flush=True)

    all_rows = []
    for season in SEASONS:
        found = discover(season)
        print(f"{season}: {len(found)} tournaments discovered", end="", flush=True)

        def one(item):
            tid, dt = item
            d = get_json(f"{API}/{tour.espn}/scoreboard?dates={dt}")
            out = []
            for e in d.get("events", []):
                if e.get("id") == tid:
                    out += parse_tournament(tour, e, season)
            return out

        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            season_rows = [r for rows in ex.map(one, found.items()) for r in rows]
        # Tournaments can surface in both feeds; matches are unique by id.
        all_rows += season_rows
        print(f" -> {len(season_rows):,} matches", flush=True)

    df = pd.DataFrame(all_rows).drop_duplicates(subset="matchId")
    df = df[df.date != ""].sort_values(["date", "matchId"]).reset_index(drop=True)
    df.insert(1, "tour", tour.slug)
    df.to_csv(os.path.join(data, "matches.csv"), index=False)

    print(f"\n{len(df):,} unique singles matches, {df.date.min()} -> {df.date.max()}")
    print(f"players: {len(set(df.winner_id) | set(df.loser_id)):,}   "
          f"tournaments: {df.tournamentId.nunique():,}   retirements: {df.retired.sum():,}")
    cov = df.surface.value_counts(normalize=True)
    print("surface coverage: " + "  ".join(f"{k} {v:.1%}" for k, v in cov.items()))
    print("best-of: " + "  ".join(f"{k} {v:,}" for k, v in df.bestOf.value_counts().items()))
    unmapped = (df[df.surface == "unknown"].tournament.value_counts().head(8))
    if len(unmapped):
        print("\nlargest unmapped tournaments (surface left unknown, not guessed):")
        for n, c in unmapped.items():
            print(f"  {c:>5,}  {n[:60]}")


if __name__ == "__main__":
    main()
