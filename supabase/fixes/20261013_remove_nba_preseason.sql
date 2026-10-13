-- ============================================================================
-- 2026-10-13 — remove the NBA preseason rows from the forward ledger.
--
-- Paste into the Supabase SQL editor and run once:
--   https://supabase.com/dashboard/project/fmhtbaikwlcjzrlisesf/sql/new
--
-- WHAT HAPPENED
-- The tracking cron recorded every NBA game that had not tipped off, and from
-- 3 October that meant PRESEASON games (ESPN season type 1). Starters sit and
-- rotations are trial runs, so a preseason result says nothing about the
-- model, but each row would have been scored into the same NBA record as the
-- real season. All 53 NBA rows in the ledger on 13 October were preseason —
-- each checked against ESPN's scoreboard (season.type = 1). None had settled,
-- so no published number moves.
--
-- The code fix (tracking.server.ts: snapshotTeamSport skips season type 1)
-- stops new ones being written. This removes the ones already there.
--
-- Safe to run twice: the second run deletes nothing.
-- ============================================================================

begin;

-- The 2026-27 regular season opens on 20 October (ESPN: the first season-type-2
-- games are on 2026-10-20; the last preseason games are on 15-16 October), so
-- every NBA row dated before then is a preseason game. A date cutoff rather
-- than a list of ids, so this also catches any the cron writes between now and
-- the code fix deploying.
delete from public.event_predictions
where sport = 'nba'
  and model_version = 'nba-elo-market-v1'
  and event_date < '2026-10-20';

-- Expect 0: no NBA rows should be left from before the regular season.
select count(*) as nba_rows_left_before_opening_night
from public.event_predictions
where sport = 'nba' and event_date < '2026-10-20';

commit;
