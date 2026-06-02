-- Clear winner on games that aren't actually final
UPDATE public.games
SET winner = NULL
WHERE winner IS NOT NULL
  AND status !~* 'final|game over|completed';

-- Unsettle predictions for those games so they get re-evaluated
UPDATE public.predictions p
SET correct = NULL, brier = NULL, log_loss = NULL, settled_at = NULL
FROM public.games g
WHERE p.game_id = g.game_id
  AND p.settled_at IS NOT NULL
  AND g.status !~* 'final|game over|completed';

-- Recompute daily metrics from scratch by clearing them; pipeline will refill
DELETE FROM public.daily_metrics;
