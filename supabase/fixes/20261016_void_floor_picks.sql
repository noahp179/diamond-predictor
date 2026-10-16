-- ============================================================================
-- 2026-10-16 — two simulation picks of players who could not do it: miss -> void.
--
-- Run once in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/fmhtbaikwlcjzrlisesf/sql/new
--
-- WHAT HAPPENED
-- Below the lowest point of a market's calibration map, the boards held the
-- map's bottom value flat, so a player the simulator gave no chance at all
-- was shown at that value: defencemen at 29% for 20+ saves, a tight end and a
-- running back at 20% for 2+ touchdown passes. On markets with only two real
-- candidates (two starting goalies, two quarterbacks) that put a third
-- "pick" in the ledger. 19 such picks were written on 15-16 October; 17 are
-- voids already (the player has no line in that stat) or will be when their
-- games are graded. The two below — Tyler Badie, SEA @ DEN, for 2+ and 3+
-- touchdown passes — were graded as misses. The code fix (calibrate in
-- sim-props-shared.ts now scales to zero below the map) stops new ones.
--
-- Safe to run twice.
-- ============================================================================

update public.player_predictions
set scored = null,
    brier = null,
    log_loss = null,
    updated_at = now()
where id in (2005, 2008)
  and model_version in ('nfl-sim-ptd2-v1', 'nfl-sim-ptd3-v1')
  and player = 'Tyler Badie';
