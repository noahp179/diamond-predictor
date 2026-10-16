-- ============================================================================
-- 2026-10-16 — touchdown picks for players who did not play: miss -> void.
--
-- Run once in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/fmhtbaikwlcjzrlisesf/sql/new
--
-- WHAT HAPPENED
-- The touchdown ledger (td-ledger.server.ts) graded an anytime-TD pick as a
-- miss whenever the player scored no touchdown — including when he did not
-- play at all. Checking every graded pick of the 2026 season against ESPN's
-- box scores found 36 of them (14 NFL, 22 college) for players who
-- appear in none of the box score's tables — not passing, rushing, receiving,
-- fumbles, defence or returns — several of them listed questionable or
-- doubtful. A sportsbook voids those bets, and the simulation boards grade
-- them as voids; this does the same, and the code fix stops new ones.
--
-- Every other graded touchdown pick agreed with its box score.
--
-- Safe to run twice: it only touches these rows while they still read as a
-- miss.
-- ============================================================================

update public.player_predictions
set scored = null,
    touchdowns = null,
    brier = null,
    log_loss = null,
    updated_at = now()
where market = 'anytime_td'
  and scored = false
  and id in (
    30,  -- CFB 2026-09-19 Josh Manning (KSU)
    35,  -- CFB 2026-09-19 Darius Taylor (MINN)
    37,  -- CFB 2026-09-19 Abu Sama III (WIS)
    50,  -- CFB 2026-09-19 Noah Bennee (UTAH)
    101,  -- CFB 2026-09-19 Lucky Sutton (SDSU)
    120,  -- NFL 2026-09-20 Josh Jacobs (GB)
    124,  -- NFL 2026-09-20 Sean Tucker (TB)
    126,  -- NFL 2026-09-20 Zay Flowers (BAL)
    131,  -- NFL 2026-09-20 RJ Harvey (DEN)
    136,  -- NFL 2026-09-20 Trey Lance (LAC)
    149,  -- NFL 2026-09-21 Puka Nacua (LAR)
    158,  -- NFL 2026-09-24 Josh Jacobs (GB)
    296,  -- CFB 2026-09-26 Nate Frazier (UGA)
    299,  -- CFB 2026-09-26 Kewan Lacy (MISS)
    312,  -- CFB 2026-09-26 Koby Howard (PSU)
    319,  -- CFB 2026-09-26 Mark Fletcher Jr. (MIA)
    329,  -- CFB 2026-09-26 Kenyon Clay (ARST)
    337,  -- CFB 2026-09-26 Brendon Haygood (UNT)
    405,  -- CFB 2026-09-26 Hollywood Smothers (TEX)
    526,  -- NFL 2026-09-27 Puka Nacua (LAR)
    706,  -- CFB 2026-10-03 Adam Mohammed (CAL)
    711,  -- CFB 2026-10-03 Myles Mitchell (NDSU)
    721,  -- CFB 2026-10-03 Jamal Rule (NEB)
    736,  -- CFB 2026-10-03 Colton Hinton (CCU)
    745,  -- CFB 2026-10-03 Sire Gaines (BOIS)
    747,  -- CFB 2026-10-03 Godspower Nwawuihe (ARMY)
    845,  -- NFL 2026-10-04 Breece Hall (NYJ)
    866,  -- NFL 2026-10-04 Justin Jefferson (MIN)
    952,  -- CFB 2026-10-09 LJ Martin (BYU)
    972,  -- CFB 2026-10-10 Jayden Scott (NCSU)
    974,  -- CFB 2026-10-10 Godspower Nwawuihe (ARMY)
    1115,  -- NFL 2026-10-11 Kyle Monangai (CHI)
    1128,  -- NFL 2026-10-11 Breece Hall (NYJ)
    1136,  -- NFL 2026-10-11 Stefon Diggs (WSH)
    1139,  -- NFL 2026-10-11 Trey Lance (LAC)
    1200   -- CFB 2026-10-14 Breezy Dubar (MOST)
  );
