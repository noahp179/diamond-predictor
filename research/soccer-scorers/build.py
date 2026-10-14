"""
Turn the cached match summaries (data/raw/<comp>/<id>.json, from fetch.py) into
two tidy tables:

  data/matches.csv          one row per match: comp, season, date, sides, final
                            score and the 90-minute score (extra time removed)
  data/player_matches.csv   one row per named player per match (starters AND
                            bench, as ESPN lists them) with:
      starter / subbed_in / subbed_out / formation_place / slot position
      ESPN box-score stats (totalGoals, ownGoals, totalShots, ...)
      on_min, off_min   minute on and off the pitch (regulation time, 0..90)
      mins              regulation minutes played
      expo              share of the match's goal intensity he was on the pitch
                        for (minutes weighted by the minute-of-match goal-rate
                        profile the UCL simulator fitted; 45' and 90' carry
                        their stoppage time) -- this is "m" realised
      goals90           non-own goals in regulation time (incl. stoppage,
                        extra time excluded)          <- the outcome
      pens90            of which penalties
      og                own goals
      team_goals_on     his team's non-own goals scored while he was on the
                        pitch (regulation), for the exposure-based share

ESPN gives no minutes column; minutes come from the clock on each player's
substitution / red-card plays (and the match keyEvents as a fallback).

Usage: python3 build.py
"""

import glob
import json
import os
import re

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

LEAGUE_OF = {"eng.1": "epl", "esp.1": "laliga", "ger.1": "bundesliga", "ita.1": "seriea",
             "fra.1": "ligue1", "uefa.champions": "ucl"}


def season_of(date):
    y, m = int(date[:4]), int(date[5:7])
    return y if m >= 7 else y - 1


# Goal intensity by minute (1..90), from the simulator's fitted minute effects
# (src/lib/ucl-sim.json): minute 45 and 90 hold their half's stoppage time.
SIM = json.load(open(os.path.join(ROOT, "src", "lib", "ucl-sim.json")))
W = np.zeros(91)
for (lo, hi), b in zip(SIM["buckets"], SIM["bucket"]):
    W[lo:hi + 1] = np.exp(b)
W_TOT = W[1:].sum()
CUM = np.cumsum(W)  # CUM[t] = sum of W[1..t]


def parse_clock(s):
    """"78'" -> (78, 0); "45'+2'" -> (45, 2); "105'+1'" -> (105, 1). None if unparsable."""
    if not s:
        return None
    m = re.match(r"\s*(\d+)'?\s*(?:\+\s*(\d+)'?)?", str(s))
    if not m:
        return None
    return int(m.group(1)), int(m.group(2) or 0)


def cover_before(t):
    """Intensity share of minutes 1..t, with minute t itself half-covered."""
    if t <= 0:
        return 0.0
    t = min(t, 90)
    return (CUM[t - 1] + 0.5 * W[t]) / W_TOT


def parse_match(fp):
    d = json.load(open(fp))
    if not d.get("completed"):
        return None, []
    comp = d["comp"]
    mid = os.path.basename(fp)[:-5]
    date = (d.get("date") or "")[:10]
    teams = {t["homeAway"]: t for t in d.get("teams", [])}
    if "home" not in teams or "away" not in teams:
        return None, []
    home, away = teams["home"]["id"], teams["away"]["id"]
    try:
        hg, ag = int(teams["home"]["score"]), int(teams["away"]["score"])
    except (TypeError, ValueError):
        return None, []

    ev = d.get("events", [])
    # Substitutions from keyEvents: participants are [on, off].
    sub_on, sub_off, red_at = {}, {}, {}
    et = any(e["type"] in ("start-extra-time", "end-extra-time") or (e.get("period") or 0) >= 3 for e in ev)
    for e in ev:
        c = parse_clock(e.get("clock"))
        if c is None:
            continue
        if e["type"] == "substitution" and len(e.get("who", [])) >= 2:
            sub_on.setdefault(e["who"][0], c[0])
            sub_off.setdefault(e["who"][1], c[0])
        elif "red" in e["type"] and e.get("who"):
            red_at.setdefault(e["who"][0], c[0])

    rows = []
    goal_minutes = {home: [], away: []}   # non-own goals of each side in regulation (minute)
    side_of = {}
    for side in d.get("rosters", []):
        tid = side["team"]
        is_home = int(side.get("homeAway") == "home")
        opp = away if is_home else home
        for p in side["players"]:
            st = p.get("stats") or {}
            plays = p.get("plays") or []
            g90 = gall = pen90 = og = 0
            p_sub = []
            p_red = None
            gmins = []
            for pl in plays:
                c = parse_clock(pl.get("clock"))
                base = c[0] if c else None
                if pl.get("sub") and base is not None:
                    p_sub.append(base)
                if pl.get("red") and base is not None and p_red is None:
                    p_red = base
                if pl.get("score"):
                    if pl.get("og"):
                        og += 1
                        continue
                    gall += 1
                    if base is None or base <= 90:
                        g90 += 1
                        gmins.append(base if base is not None else 45)
                        if pl.get("pen"):
                            pen90 += 1
            starter = bool(p.get("starter"))
            sin, sout = bool(p.get("subIn")), bool(p.get("subOut"))
            pid = p["id"]
            # minute on / off in regulation; `start` = on from kick-off,
            # `end` = still on at the final whistle (neither subbed off nor sent off)
            if starter:
                on, start = 0, True
            elif sin:
                on, start = sub_on.get(pid, p_sub[0] if p_sub else 65), False
            else:
                on, start = None, False
            off, end = 90, True
            if on is not None:
                if sout:
                    cand = sub_off.get(pid)
                    if cand is None and p_sub and (starter or len(p_sub) > 1):
                        cand = p_sub[-1]
                    off, end = (cand if cand is not None else (65 if starter else 85)), False
                r = red_at.get(pid, p_red)
                if r is not None and (end or r < off):
                    off, end = r, False
                if off > 90:          # went off in extra time: on for all of regulation
                    end = True
                on_c, off_c = min(on, 90), min(off, 90)
                mins = max(0, off_c - on_c)
                lo = 0.0 if start else cover_before(on_c)
                hi = 1.0 if end else cover_before(off_c)
                expo = max(0.0, hi - lo) if on <= 90 else 0.0
            else:
                on_c = off_c = None
                mins, expo = 0, 0.0
            rows.append(dict(
                matchId=mid, comp=comp, league=LEAGUE_OF.get(comp, comp), season=season_of(date),
                date=date, kickoff=d.get("date"), team_id=tid, opp_id=opp, is_home=is_home,
                player_id=pid, name=p.get("name", ""), pos=p.get("pos", ""),
                starter=int(starter), subbed_in=int(sin), subbed_out=int(sout),
                formation_place=float(p.get("fp") or 0),
                **{k: float(st.get(k) or 0) for k in ("totalGoals", "ownGoals", "totalShots", "shotsOnTarget",
                                                        "goalAssists", "yellowCards", "redCards",
                                                        "foulsCommitted", "appearances")},
                on_min=on_c, off_min=off_c, on_start=int(start), off_end=int(on is not None and end),
                mins=mins, expo=round(expo, 4),
                goals90=g90, goals_all=gall, pens90=pen90, og=og, goal_min="|".join(map(str, gmins)),
            ))
            side_of[pid] = tid
            goal_minutes.setdefault(tid, []).extend(gmins)

    # Own goals count for the OTHER side in the score, never for a scorer.
    for r in rows:
        tid = r["team_id"]
        gm = goal_minutes.get(tid, [])
        if r["on_min"] is None:
            r["team_goals_on"] = 0
            continue
        tot = 0.0
        for g in gm:   # a goal in the very minute he came on / went off counts half
            f_lo = 1.0 if (r["on_start"] or g > r["on_min"]) else (0.5 if g == r["on_min"] else 0.0)
            f_hi = 1.0 if (r["off_end"] or g < r["off_min"]) else (0.5 if g == r["off_min"] else 0.0)
            tot += f_lo * f_hi
        r["team_goals_on"] = tot

    # 90-minute score: if extra time was played, count regulation goals from keyEvents.
    hg90, ag90 = hg, ag
    if et:
        h = a = 0
        for e in ev:
            if not e.get("scoring") or e.get("shootout"):
                continue
            c = parse_clock(e.get("clock"))
            per = e.get("period") or 0
            if (per and per <= 2) or (c and c[0] <= 90 and not per):
                if e.get("team") == home:
                    h += 1
                elif e.get("team") == away:
                    a += 1
        hg90, ag90 = h, a
    match = dict(matchId=mid, comp=comp, league=LEAGUE_OF.get(comp, comp), season=season_of(date),
                 date=date, kickoff=d.get("date"), neutral=int(bool(d.get("neutral"))),
                 home_id=home, away_id=away, home=teams["home"].get("abbr"), away=teams["away"].get("abbr"),
                 home_name=teams["home"].get("name"), away_name=teams["away"].get("name"),
                 hg=hg, ag=ag, hg90=hg90, ag90=ag90, et=int(et), n_players=len(rows))
    return match, rows


def main():
    files = sorted(glob.glob(os.path.join(DATA, "raw", "*", "*.json")))
    matches, players = [], []
    for i, fp in enumerate(files):
        m, rows = parse_match(fp)
        if m is None:
            continue
        matches.append(m)
        players += rows
        if (i + 1) % 2000 == 0:
            print(f"  {i + 1}/{len(files)}", flush=True)
    md = pd.DataFrame(matches).sort_values(["date", "matchId"]).reset_index(drop=True)
    pm = pd.DataFrame(players)
    md.to_csv(os.path.join(DATA, "matches.csv"), index=False)
    pm.to_csv(os.path.join(DATA, "player_matches.csv.gz"), index=False, compression="gzip")

    # ---- sanity checks
    print(f"matches {len(md):,}  player rows {len(pm):,}")
    print(md.groupby(["comp", "season"]).size().unstack(0).to_string())
    st = pm[pm.starter == 1]
    print("\nstarters with zero minutes:", int((st.mins <= 0).sum()))
    agree = (np.minimum(pm.goals90, 1) == np.minimum(pm.totalGoals, 1))
    print(f"goals90>=1 agrees with ESPN totalGoals>=1 on {agree.mean():.4%} of rows "
          f"({(~agree).sum()} disagree; extra-time goals explain some in the UCL)")
    # team non-own goals vs final score (domestic: no extra time)
    tg = pm.groupby(["matchId", "team_id"]).goals90.sum()
    og = pm.groupby(["matchId", "team_id"]).og.sum()
    chk = []
    for r in md.itertuples():
        h = tg.get((r.matchId, r.home_id), 0) + og.get((r.matchId, r.away_id), 0)
        a = tg.get((r.matchId, r.away_id), 0) + og.get((r.matchId, r.home_id), 0)
        chk.append((h == r.hg90) and (a == r.ag90))
    md["score_ok"] = chk
    print("\n90-min score reconstructed from player goal logs:")
    print(md.groupby("comp").score_ok.mean().round(4).to_string())
    print("\nstarter exposure mean by comp:", st.groupby("comp").expo.mean().round(3).to_dict())
    print("starter outcome rate (goals90>=1) by comp/season:")
    print(st.assign(y=(st.goals90 > 0).astype(int)).groupby(["comp", "season"]).y.mean().unstack(0).round(4).to_string())


if __name__ == "__main__":
    main()
