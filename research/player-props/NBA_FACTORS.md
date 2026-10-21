# NBA simulator — every factor worth testing

A catalog of everything that could make a possession-by-possession NBA sim more
realistic, the way coaching tendencies, fourth-down tables and personnel did for
the NFL engine. Each factor lists why it moves box scores or results, where the
data comes from, how it would enter the engine, and whether `src/lib/sim/nba.ts`
already has it.

**Status:** ✅ in the engine · ◐ partly / crude version · ○ not modeled

**Prior evidence** (what the public research says before we test it):
**S** strong, repeatedly measured · **M** mixed or small · **W** weak / folklore,
test anyway.

---

## What the engine does today (for reference)

- Possession loop; whoever uses a possession is drawn in proportion to
  per-minute 2PA / 3PA / FTA / TOV, raised to `ROLE_POW` 1.5.
- Shooting percentages regressed, times the defense's opponent splits (odds ratios
  on 2P%, 3P%, 3PA rate; rate ratios on FT rate, forced TOV, OREB).
- Rebounds from the five-on-five OREB vs DREB rates; OREB share guessed from
  position, because ESPN doesn't split rebounds.
- Rotation: top nine at season MPG, the tenth man at half, scaled to 240, capped at
  40. Starters open halves, closers in close fourths, bench in blowouts.
- Foul trouble, foul-outs, intentional fouling, "down 3 → shoot a three", OT.
- League pace times each team's relative pace; flat home edge; back-to-back yes/no;
  score effects; random game-to-game swings in minutes and usage.
- Inputs: ESPN season stats, blended with last season over ~30 games; ESPN injury
  report.

---

## 1. Availability, minutes and rotation — the biggest lever for props

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Official injury report (Out / Doubtful / Questionable / Probable) | Who plays is most of a prop's error | NBA official injury report PDFs (5pm/1pm/… ET snapshots, reachable from here); ESPN injuries | Remove Out/Doubtful. Questionable → play with probability ~p (historical: Q plays ~60–70%, P ~95%) | ◐ (ESPN; Q handling crude) | S |
| Game-time decisions / late scratches | NBA news lands 30–90 min before tip; our runs are mornings | Injury report 30 min pre-tip; starting lineups (`cdn.nba.com` live boxscore, ESPN) | A late re-run slot, or run the sim per "who's out" scenario and pick at tip | ○ | S |
| Minutes restriction after injury return | First 3–5 games back are capped (often 15–25 min) | Games missed in a row (from game logs) + beat-writer text | Cap target minutes for N games after an absence ≥ X games | ○ | S |
| Recent minutes vs season minutes | Roles change mid-season: trades, promotions, demotions | Game logs (ESPN / nba stats `playergamelogs`) | Minutes = blend of last 5/10 and season, weights fitted | ◐ (season only) | S |
| Redistribution when a starter sits | Who absorbs the 34 minutes: backup at the same position, not the whole bench | Positions, depth charts, on/off minute splits, history of games with that player out | Give the vacated minutes by position and history ("with X out, Y played 31") | ◐ (spread pro rata) | S |
| Usage redistribution when a star sits | Shots don't spread evenly; the #2 option takes the most | On/off usage splits (`leaguedashplayerstats` with on/off, pbpstats WOWY) | Per-player usage bump fitted from "star out" games | ◐ (ROLE_POW only) | S |
| Coach's rotation depth | Some coaches play 8, some 11 | Distinct players ≥ 10 min per game, by team | Team-specific depth instead of fixed 9 + half | ○ | M |
| Starter designation | Starters get stints at fixed times; affects first-quarter props | Starting lineups (last N games, confirmed pre-game) | Use actual starters, not "top-5 minutes" | ◐ | M |
| Stint patterns | Starters sit ~6–7 min into Q1, return mid-Q2; affects 1Q/1H props | Play-by-play substitutions | Substitution clock per player from typical stint map | ○ | M |
| Load management / rest on back-to-backs | Stars sit the second night, especially older | B2B schedule + age + history; the 65-game award rule since 2023-24 | Probability of rest per player | ○ | M |
| Two-way / G-League call-ups | 10th–15th men appear/disappear | Transactions feed | Roster availability | ○ | W |
| Garbage-time minutes | Deep bench props only hit in blowouts | Spread, score margin | ✅ (blowout bench) | ✅ | S |
| Foul trouble | Starters sit with 2 in Q1, 3 in the first half | PF per minute | ✅ | ✅ | S |
| Overtime | Extra 5 minutes for starters | — | ✅ | ✅ | S |
| Ejections / technical fouls | Rare; a few players carry high T rates | Tech/flagrant logs | Small per-game ejection hazard | ○ | W |

## 2. Player offensive profile

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Shot location mix (rim, short mid, long mid, corner 3, above-break 3) | Efficiency differs a lot by zone; defenses differ by zone | `shotchartdetail`, `leaguedashplayershotlocations` (nba stats); pbpstats | Replace "two vs three" with five zones, each with its own make% and defense factor | ○ (2 vs 3 only) | S |
| Shot creation: assisted vs unassisted, catch-and-shoot vs pull-up | Pull-ups go in less; catch-and-shoot depends on teammates creating | nba stats tracking (`CatchShoot`, `PullUpShot`), assisted share | A shooter's chance of shooting depends on whether a creator is on the floor | ○ | S |
| Shot clock | Late-clock shots are worse; teams differ in how long they take | nba stats shot clock splits | Draw a time used, then shot quality by time left | ○ (seconds sampled flat) | M |
| Free-throw rate / foul drawing | Driving players get to the line | FTA per FGA, drives | ✅ (FTA per minute) | ✅ | S |
| And-ones | Bonus points for finishers | PBP | ✅ (flat rate) | ◐ | M |
| Play types (Synergy): P&R ball handler, roll man, iso, post-up, spot-up, transition, cutter, handoff, putback, off-screen | The richest scheme layer; offense and defense both have per-play-type efficiency | nba stats `synergyplaytypes` (offense and defense, team and player) | Choose a play type per possession by team frequency → who finishes and how efficiently, versus the defense's per-play-type rate | ○ | S |
| Transition vs half-court | Transition is ~1.1–1.2 PPP vs ~0.95; driven by turnovers and long rebounds | Synergy transition, pbpstats "possession start" (after steal / dead ball / make / miss) | Possession start type changes speed and shot quality | ○ | S |
| Putbacks / second chance | Offensive boards produce short, high-% shots | PBP | Shot after an OREB comes from the rim zone | ◐ | S |
| Free-throw % (regressed by attempts) | Late-game fouling, props | — | ✅ | ✅ | S |
| Three-point % regression | 3P% is noisy; true talent takes ~750 attempts to stabilize | Career 3P%, FT% (FT% predicts 3P%) | Regress 3P% toward a prior built from career + FT% | ◐ (regressed toward league) | S |
| Hot hand | Real but small; streak players shoot harder shots | PBP | Small within-game make-% autocorrelation | ○ | M |
| Clutch performance | Mostly noise; but who takes the last shot isn't | Clutch splits | Closing-time usage concentration on the star | ◐ | W (skill) / S (usage) |

## 3. Defense — individual and team

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Team defense vs each shot type | Some defenses give up threes, some the rim | Opponent shot location / play type allowed | ✅ for 2P/3P/3PA rate; ○ for zones | ◐ | S |
| Opponent 3P% is mostly luck | Defenses control 3PA allowed much more than 3P% allowed | Opp 3PA rate, opp 3P% | Regress the defense's 3P% factor hard, keep its 3PA rate factor | ○ (taken at face value) | S |
| Rim protection | Shots at the rim fall less near elite shot blockers | nba stats `defense dashboard` (rim DFG%), blocks | Rim-zone make % adjusted by the best rim protector on the floor | ○ | S |
| Individual matchups | Who guards whom: a star facing an elite wing | `boxscorematchupsv3` (partial possessions, by defender) | Weight a scorer's make % by his usual defenders' quality | ○ | M |
| Defensive lineup on the floor | Team defense changes when the anchor sits | On/off defensive rating | Defense factor by who is on the floor, not team-wide | ○ | M |
| Steals and blocks per player | Steal and block props | Per-minute STL/BLK | ✅ | ✅ | S |
| Forced turnovers by scheme (pressure, trapping) | Some schemes trade fouls/threes for turnovers | Forced TOV rate, opponent TOV rate | ✅ (team factor) | ✅ | S |
| Switching vs drop vs blitz on pick-and-roll | Drop coverage gives up pull-up mid-range; switching gives isolations | Synergy defensive P&R frequencies; scheme labels (BBall Index, Cleaning the Glass descriptions) | Changes the shot-zone mix allowed in P&R possessions | ○ | M |
| Zone defense frequency | Zone gives up more threes, fewer drives | Synergy "vs zone" | Shot mix shift for possessions vs zone | ○ | M |
| Positional defense ("DvP") | Fantasy staple, very noisy | Opp stats by position | Test only; probably regress to nothing | ○ | W |

## 4. Rebounding

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Real OREB / DREB per player | We guess OREB share from position | nba stats box score (OREB/DREB split) | Use actual split | ◐ (guessed) | S |
| Rebound chances / contested share | Separates "rebounder" from "stands near the rim" | nba stats tracking `Rebounding` (chances, contested) | Rebound weighting by chances | ○ | M |
| Long vs short misses | Threes produce long rebounds → guards, transition | Shot zone of the miss | Rebound distribution depends on miss zone | ○ | M |
| Team crash vs get-back philosophy | Some coaches send nobody to the glass | Team OREB% and opponent transition frequency | ✅ team OREB odds; ○ trade-off with transition defense | ◐ | M |
| Team rebounds | Out of bounds etc., not credited | — | ✅ (12%) | ✅ | S |

## 5. Playmaking and turnovers

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Assist rate by passer | Assist props | AST per minute | ✅ | ✅ | S |
| Assisted share by shot zone | Corner threes ~95% assisted, rim ~60%, pull-ups ~0% | Shot charts with assist flag | Assist chance depends on zone and shot type | ◐ (flat ~62%) | S |
| Potential assists / passes made | Passing volume vs teammates' finishing | nba stats tracking `Passing` | Passer's assists depend on who's finishing | ○ | M |
| Live-ball vs dead-ball turnovers | Live-ball TOs feed transition | PBP | Turnover type → next possession speed and efficiency | ○ | S |
| Turnover risk by play type | Post-ups and drives turn over more | Synergy | Via play type | ○ | M |

## 6. Fouls and free throws

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Shooting foul vs non-shooting foul, team bonus | Free throws in the bonus; late-quarter FTs | PBP | Team foul count per quarter → bonus FTs | ○ | M |
| Foul drawing vs foul committing by player | Fouls props, foul trouble | PF / PFD per minute | ✅ PF; ◐ PFD | ◐ | S |
| Intentional fouling late | Late FT props, totals | — | ✅ | ✅ | S |
| Hack-a-player on poor FT shooters | Rare now (rule changes) | — | Skip | ○ | W |
| Coach's challenge | ~0.5 points of swing a game | Challenge logs | Ignore unless very cheap | ○ | W |

## 7. Physical attributes

Little of this adds information beyond the player's stats once he has a few
hundred minutes. It earns its place for rookies, players back from long injury,
players changing roles, and as a prior for regression.

| Factor | Use | Data | Status | Prior |
|---|---|---|---|---|
| Height, weight, wingspan, standing reach | Prior for rebounding, rim protection, block rate; matchup size gaps | NBA Draft Combine anthropometrics (`draftcombinestats`), `commonplayerinfo` | ○ | M (as prior) |
| Max vertical, lane agility, sprint | Prior for transition, steals; rookies | Draft Combine athletic testing | ○ | W |
| Age and aging curve | Decline from ~29–30; young players improve in-season | Birth date | Age-adjusted projection and in-season trend | ○ | S |
| Speed / distance per game | Fatigue model, transition involvement | nba stats tracking `SpeedDistance` | ○ | M |
| Workload (minutes last 7 days, games last 7 days) | Fatigue → shooting, rest risk | Schedule, game logs | ○ | M |
| Injury history / type | Return-from-injury performance dip (e.g. lower-body soft tissue) | Injury logs (ProSportsTransactions, ESPN) | ○ | M |
| Size mismatch on the floor | Bigger lineups rebound more; smaller ones shoot more threes | Heights of the five on the floor | ○ | M |

## 8. Coaching — the NFL-tendencies analogue

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Pace philosophy | Totals and every counting stat | Team pace; seconds per possession after makes/misses/turnovers (pbpstats) | ✅ team pace; ○ by possession start type | ◐ | S |
| Shot diet | 3PA rate, rim rate, mid-range avoidance | Team shot location frequencies | Team-level zone mix on top of players' | ○ | S |
| Offensive scheme by play-type frequency | Spot-up heavy vs iso heavy vs post | Synergy team offense frequency | Play-type distribution per team | ○ | S |
| Defensive scheme | Drop / switch / blitz / zone; gives up a particular shot mix | Synergy team defense; opp shot locations | Opponent zone mix and efficiency | ◐ (opp splits) | S |
| Rotation tightness, star minutes | Some coaches ride stars 38 minutes | Team minutes distribution | Team-specific cap and depth | ○ | M |
| Closing lineup choice | Who's on the floor in the last 5 minutes of a close game | PBP lineups in clutch | Closing five from data, not top-5 minutes | ◐ | M |
| Blowout pull threshold | When starters come out (margin and time) | PBP substitution vs margin | Team-specific threshold | ◐ (league-wide) | M |
| Two-for-one at quarter ends | A few extra possessions per game | PBP end-of-quarter | Shoot quickly when 30–40 s left | ○ | M |
| Timeout use | Stops runs; ATO plays efficiency | PBP timeouts | Mostly ignore | ○ | W |
| Fouling up 3 late | Changes end-game totals | PBP | Team tendency | ○ | M |
| Coach changes mid-season | Pace and rotation reset | Coaching changes | Reset team tendencies to the new coach's history | ○ | M |
| Tanking / development minutes | Late-season young-player minutes | Standings, team status | Rotation shift for eliminated teams | ○ | M |

## 9. Lineups and interactions

| Factor | Why it matters | Data | How it enters | Status | Prior |
|---|---|---|---|---|---|
| Spacing | Shooters on the floor open the paint for drivers | Lineup 3PA rate, number of 30%+ volume shooters | Rim make % up with spacing | ○ | M |
| Diminishing returns of usage | Two ball-dominant players can't both keep their usage | Lineup usage data | ✅ ROLE_POW; test a lineup-specific version | ◐ | S |
| Diminishing returns of rebounding | Two great rebounders share boards | Lineup rebounding | ✅ REB_POW | ✅ | S |
| Lineup net rating (5-man, 2-man) | Some combos are much better than parts | `leaguedashlineups`, pbpstats | Too noisy for 5-man; 2-man pairs maybe | ○ | W–M |
| RAPM / EPM / LEBRON-style ratings | Best public single-number player impact | Public RAPM (nbarapm.com), EPM (dunksandthrees, paid), BBall Index | Team-strength check / prior for efficiency | ○ | S |
| Teammate quality on assist and usage rates | A role player on a new team | Season split by team | Recompute rates on the new team after a trade | ◐ | M |

## 10. Game state and in-game dynamics

| Factor | Why it matters | Status | Prior |
|---|---|---|---|
| Score effects (leading teams ease off) | Margin spread | ✅ | S |
| Garbage time | Bench props, unders for stars | ✅ | S |
| End-of-quarter heaves | Lower FG%, extra 3PA | ○ | M |
| Late-game "down 3 → three", "down 2 → tie" | Totals, threes | ✅ | S |
| Intentional fouling late | FT props | ✅ | S |
| Momentum / runs | Mostly randomness | ○ (test, expect nothing) | W |
| Pace in the fourth (slows) and in close games | Totals, Q4 props | ○ | M |
| Overtime fatigue | Starters' efficiency in OT | ○ | W |

## 11. Schedule, fatigue and travel

| Factor | Why it matters | Data | Status | Prior |
|---|---|---|---|---|
| Back-to-back | ~1.5–2.5 points | ESPN schedule | ✅ (binary) | S |
| Rest days (0/1/2/3+) and rest difference | Continuous version of the above | Schedule | ○ | S |
| 3 games in 4 nights, 4 in 6, 5 in 7 | Cumulative load | Schedule | ○ | M |
| Travel distance last 24–72 h | Fatigue | Arena coordinates + schedule | ○ | M |
| Time zones crossed and direction (east-bound worse) | Circadian effect | Arena time zones | ○ | M |
| Road-trip length / homestand length | Fatigue, "last game of a long road trip" | Schedule | ○ | M |
| Altitude (Denver, Utah) | Visitors' late-game fatigue, Nuggets home edge | Venue | ○ | M |
| Early / unusual tip times (noon Sundays, holiday games) | Shooting dips anecdotally | Tip time | ○ | W |
| Previous game went to OT / high minutes | Next-day minutes and efficiency | Box scores | ○ | M |
| All-Star break / post-break | Rest effect | Calendar | ○ | W |
| International games (Paris, Mexico City) | Travel, neutral site | Schedule | ◐ (neutral flag) | W |

## 12. Venue and environment

| Factor | Why it matters | Data | Status | Prior |
|---|---|---|---|---|
| Team-specific home edge | Varies by team (Denver, Utah historically high) | Home/road splits, multi-season | ◐ (flat 1.25%) | M |
| Crowd/attendance | Part of home edge | Attendance | ○ | W |
| Arena shooting backgrounds | Folklore of "bad shooting arenas" | 3P% by arena, multi-year | ○ | W |
| Home scorer bias (assists, blocks, steals, rebounds) | Home official scorers credit more assists and blocks in some arenas; real for props | Box score stats home vs away by arena, multi-season | ○ | **M–S for props** |
| Neutral site (NBA Cup knockout games in Las Vegas, international) | No home edge | Schedule | ✅ | S |

## 13. Officiating

| Factor | Why it matters | Data | Status | Prior |
|---|---|---|---|---|
| Referee crew foul rate | Crews differ in fouls called per game → FTs, totals, foul trouble | Referee assignments (official.nba.com, posted 9am ET game day, reachable from here); historical crew stats from PBP | ○ | M |
| Crew home-whistle tendency | Small home-edge variation | Same | ○ | W |
| Crew pace | Slightly faster/slower games | Same | ○ | W |
| Last Two Minute reports | Not predictive, skip | — | ○ | W |
| Point-of-emphasis seasons (e.g. 2023-24 physicality shift mid-season) | League-wide FT rate shifts | League FT rate by month | ◐ (season env) | M |

## 14. Motivation and context

| Factor | Why it matters | Data | Status | Prior |
|---|---|---|---|---|
| Playoff seeding locked → rest | Starters sit the last week | Standings, clinch scenarios | ○ | S (late season) |
| Tanking | Effort and lineups late in the season | Standings, lottery odds | ○ | M |
| Play-in / bubble urgency | Stars play more minutes | Standings | ○ | M |
| NBA Cup group games | Point differential matters as a tiebreaker → starters stay in blowouts | Schedule flags | ○ | M |
| Revenge game (vs former team) | Folklore; usage bump? | Transactions | ○ | W |
| Contract year | Small or none | Contracts | ○ | W |
| Stat incentives / milestones late season | Bonus thresholds, 65-game award rule, stat chasing (e.g. triple-double hunting) | Contracts (Spotrac), game counts | ○ | M for specific players |
| National TV | Stars play, folklore of effort | Broadcast schedule | ○ | W |
| Playoffs | Tighter rotations, slower pace, stars 40+ minutes | ✅ flag exists; ◐ rotation not tightened | ◐ | S |

## 15. Form, variance and regression

| Factor | Why it matters | Status | Prior |
|---|---|---|---|
| Blending last season with this season | Early-season reliability | ✅ (~30 games) | S |
| Per-stat stabilization rates | Usage stabilizes fast, 3P% slow, FT% medium | ○ (one rate for everything) | S |
| Recent form (last 5/10 games) | Mostly minutes and role, little in efficiency | ○ | M (minutes) / W (shooting) |
| Game-to-game volatility per player | Some players are boom/bust; wider prop distributions | ◐ (one league-wide MIN_FORM / USE_FORM) | M |
| Correlated swings within a team | One star's hot night takes shots from others | ✅ (usage share) | S |
| Shared pace noise | Totals and both teams' counting stats move together | ✅ | S |

## 16. Market information

| Factor | Why it matters | Data | Status | Prior |
|---|---|---|---|---|
| Point spread and total | Most efficient single predictor of the game | ESPN odds (already in `line`) | ◐ (shown, not fed) | S |
| Player prop lines | Encode late news and minutes expectations | Odds API (paid) or books' public pages | ○ | S |
| Line movement | Late news signal | Repeated snapshots | ○ | M |
| Use: calibrate the sim to the line, or test sim vs line as a benchmark | — | — | ○ | S |

## 17. Roster change dynamics

| Factor | Why it matters | Status | Prior |
|---|---|---|---|
| Trades: rates on the new team only, after N games | Old role ≠ new role | ◐ (season totals across teams) | S |
| Rookies: college / draft-position prior | No NBA stats early | ○ | M |
| International players / returning from a season out | Priors | ○ | M |
| Mid-season signings, 10-day contracts | Minutes | ○ | W |

## 18. Season and rules context

| Factor | Status |
|---|---|
| League environment by season (pace, 3PA rate, FT rate) | ✅ (season env) |
| League trends within a season (scoring rises Oct → Mar) | ○ |
| Rule changes (e.g. take-foul rule, challenge rules) | ◐ via season env |

---

## Data sources — what's reachable

| Source | What it has | Reachable from this sandbox | Notes |
|---|---|---|---|
| ESPN site/core APIs | Rosters, season stats, injuries, schedule, odds, box scores | ✅ (current pipeline) | No OREB split, no tracking |
| NBA official injury report PDFs (`ak-static.cms.nba.com`) | Official statuses several times a day | ✅ (HTTP 200) | Needs PDF parsing |
| Referee assignments (official.nba.com) | Crews per game, posted ~9am ET | ✅ (HTTP 200) | Need history for crew tendencies |
| stats.nba.com | Tracking, Synergy play types, shot charts, lineups, matchups, combine | ✗ timed out here | Known to block cloud IPs (Vercel too); fetch offline from a home machine, commit JSON like `nfl-coaching.json` |
| cdn.nba.com live data | Play-by-play, box scores, starting lineups | ✗ 403 here | May work from Vercel or locally |
| pbpstats.com API | Possession starts, WOWY, lineups | ✗ timed out here | Same offline-fetch approach |
| Basketball-Reference | History, PBP, shot locations | Scraping restricted by its terms | Avoid in prod |
| nbarapm.com, dunksandthrees (EPM) | Impact metrics | Untested | EPM full data is paid |
| Odds APIs | Prop lines | Paid | Only if we want the market benchmark |

**Practical route:** a research script (like `build-nfl-coaching.ts`) that pulls
from stats.nba.com / pbpstats on a machine that isn't blocked, writes
`nba-coaching.json` / `nba-profiles.json`, and gets committed. The live morning job
keeps using ESPN plus the injury PDF and referee page.

---

## How to test each factor

Same harness as the NFL and MLB work: replay 2025-26 (and 2024-25 for a holdout)
game by game with as-of data, toggle one factor at a time.

- **Props:** Brier / log loss on every market we publish; calibration by decile;
  MAE on minutes, points, rebounds, assists, threes.
- **Games:** margin SD vs real (~13), total MAE, win-probability Brier, beating or
  matching the closing spread and total.
- **Minutes model separately:** most of the props error is minutes. Test the
  availability and rotation factors (section 1) on minutes MAE before running
  full sims; it's much cheaper.
- **Keep a factor only if** it improves the holdout season, not just the fit season.
  Record the effect in `SIMULATOR.md` with its measured size, as we did for B2B
  and score effects.
- **CPU:** every factor has to fit the 10,000-run, 270 s budget. Lookups computed
  in `prepareNba` are free; per-possession work (zones, play types) costs. Measure
  ms per game before and after.

## Suggested order (largest expected gain first)

1. **Minutes and availability:** Questionable probabilities, recent-minutes blend,
   positional redistribution, minutes restrictions after absences, a late
   pre-tip re-run.
2. **Real OREB/DREB split** (we guess it today).
3. **Shot zones** (rim / mid / corner 3 / above-break 3) with zone defense factors,
   plus regressing opponent 3P% allowed.
4. **Possession start type** (after steal, defensive rebound, make): transition
   frequency and efficiency.
5. **Synergy play types** for both offense and defense: the closest thing to
   NFL coaching schemes.
6. **Rest-days and travel** as continuous factors, replacing the B2B flag.
7. **Referee crews** (FT rate, totals) and **home scorer bias** (assists, blocks,
   steals for props).
8. **Team-specific coaching:** rotation depth, star minutes cap, blowout threshold,
   closing lineups, two-for-ones.
9. **Per-stat stabilization and player-specific volatility.**
10. **Market:** spread/total as a benchmark and possibly a prior.
11. The W-rated folklore (revenge games, national TV, arena backgrounds, hot hand,
    momentum), one quick test each, expected to wash out.
