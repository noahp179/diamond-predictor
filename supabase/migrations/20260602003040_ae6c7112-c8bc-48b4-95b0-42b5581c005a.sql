-- Recompute correct/brier/log_loss for every settled prediction
-- using the games table's current (now-trustworthy) winner.
WITH joined AS (
  SELECT p.game_id, p.home_win_prob, g.winner, g.status
  FROM public.predictions p
  JOIN public.games g ON g.game_id = p.game_id
  WHERE p.settled_at IS NOT NULL
)
UPDATE public.predictions p
SET
  correct = CASE
    WHEN j.winner IS NULL THEN NULL
    ELSE ((p.home_win_prob >= 0.5) = (j.winner = 'home'))
  END,
  brier = CASE
    WHEN j.winner IS NULL THEN NULL
    ELSE ROUND((p.home_win_prob - CASE WHEN j.winner='home' THEN 1 ELSE 0 END)::numeric ^ 2, 5)
  END,
  log_loss = CASE
    WHEN j.winner IS NULL THEN NULL
    ELSE ROUND((
      -(
        CASE WHEN j.winner='home' THEN 1 ELSE 0 END * LN(GREATEST(LEAST(p.home_win_prob, 0.999999), 0.000001))
        + CASE WHEN j.winner='home' THEN 0 ELSE 1 END * LN(GREATEST(LEAST(1 - p.home_win_prob, 0.999999), 0.000001))
      )
    )::numeric, 4)
  END,
  settled_at = CASE WHEN j.winner IS NULL THEN NULL ELSE p.settled_at END
FROM joined j
WHERE p.game_id = j.game_id;

-- Force daily metrics to rebuild
DELETE FROM public.daily_metrics;
