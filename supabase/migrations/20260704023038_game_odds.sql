-- Cached real market moneylines (ESPN/DraftKings), one row per game.
-- Powers the Best Odds page's model-vs-market edge and lets Track Record
-- reconstruct historical "best odds" picks without re-fetching ESPN.
CREATE TABLE public.game_odds (
  game_id BIGINT PRIMARY KEY REFERENCES public.games(game_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'draftkings',
  home_moneyline INT,
  away_moneyline INT,
  home_implied_prob NUMERIC(5,4),
  away_implied_prob NUMERIC(5,4),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.game_odds TO anon, authenticated;
GRANT ALL ON public.game_odds TO service_role;

ALTER TABLE public.game_odds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "game odds are public" ON public.game_odds FOR SELECT USING (true);
