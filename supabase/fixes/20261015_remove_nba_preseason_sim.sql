-- ============================================================================
-- 2026-10-15 — remove NBA PRESEASON games from the simulation boards' records.
--
-- Run once ONLY IF the simulation jobs ran before the preseason fix was
-- deployed (PR #42, "simulation boards skip preseason games"). Paste into the
-- Supabase SQL editor:
--   https://supabase.com/dashboard/project/fmhtbaikwlcjzrlisesf/sql/new
--
-- WHAT HAPPENED
-- The simulation jobs simulated every game that had not started, and ESPN's
-- NBA schedule still listed preseason games (season type 1) on 15 and 16
-- October. A preseason result says nothing about the boards — starters sit,
-- rotations are trial runs — so their picks must not count in the NBA record.
-- The code fix stops new ones; this removes any written before it shipped.
-- Same reasoning as 20261013_remove_nba_preseason.sql.
--
-- The 14 ids below are every NBA game ESPN listed with season type 1 on those
-- two dates, checked against its scoreboard on 15 October 2026.
--
-- Safe to run twice, or when nothing was written: it deletes only these games'
-- simulation rows.
-- ============================================================================

delete from public.player_predictions
where sport = 'nba'
  and model_version like 'nba-sim-%'
  and event_id in (
    '401908945', '401908622',                                  -- 15 Oct
    '401898406', '401898407', '401908946', '401914126', '401898408',
    '401898843', '401901822', '401906509', '401908943', '401898409',
    '401908948', '401898719'                                   -- 16 Oct
  );

delete from public.sim_props
where league = 'nba'
  and event_id in (
    '401908945', '401908622',
    '401898406', '401898407', '401908946', '401914126', '401898408',
    '401898843', '401901822', '401906509', '401908943', '401898409',
    '401908948', '401898719'
  );
