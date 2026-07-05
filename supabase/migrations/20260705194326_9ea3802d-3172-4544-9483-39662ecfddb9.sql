CREATE TABLE public.game_odds (
  game_id BIGINT PRIMARY KEY REFERENCES public.games(game_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  home_moneyline INTEGER,
  away_moneyline INTEGER,
  home_implied_prob NUMERIC,
  away_implied_prob NUMERIC,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.game_odds TO anon, authenticated;
GRANT ALL ON public.game_odds TO service_role;

ALTER TABLE public.game_odds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read game_odds" ON public.game_odds FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_game_odds_updated_at
BEFORE UPDATE ON public.game_odds
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();