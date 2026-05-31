
CREATE TABLE public.games (
  game_id BIGINT PRIMARY KEY,
  game_date DATE NOT NULL,
  game_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  venue TEXT,
  home_team_id INT NOT NULL,
  home_team_name TEXT NOT NULL,
  home_team_abbr TEXT NOT NULL,
  away_team_id INT NOT NULL,
  away_team_name TEXT NOT NULL,
  away_team_abbr TEXT NOT NULL,
  home_score INT,
  away_score INT,
  winner TEXT CHECK (winner IN ('home','away')),
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX games_date_idx ON public.games(game_date);
CREATE INDEX games_status_idx ON public.games(status);

CREATE TABLE public.predictions (
  game_id BIGINT NOT NULL REFERENCES public.games(game_id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,
  home_win_prob NUMERIC(5,4) NOT NULL,
  away_win_prob NUMERIC(5,4) NOT NULL,
  home_win_pct NUMERIC(5,4),
  away_win_pct NUMERIC(5,4),
  home_pitcher_id BIGINT,
  home_pitcher_name TEXT,
  home_pitcher_era NUMERIC(5,2),
  away_pitcher_id BIGINT,
  away_pitcher_name TEXT,
  away_pitcher_era NUMERIC(5,2),
  rationale JSONB,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  brier NUMERIC(6,5),
  log_loss NUMERIC(6,4),
  correct BOOLEAN,
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (game_id, model_version)
);
CREATE INDEX predictions_settled_idx ON public.predictions(settled_at);

CREATE TABLE public.daily_metrics (
  metric_date DATE NOT NULL,
  model_version TEXT NOT NULL,
  games INT NOT NULL,
  settled INT NOT NULL,
  correct INT NOT NULL,
  accuracy NUMERIC(5,4),
  brier NUMERIC(6,5),
  log_loss NUMERIC(6,4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_date, model_version)
);

-- Grants: data is public read-only; writes go through service role
GRANT SELECT ON public.games TO anon, authenticated;
GRANT SELECT ON public.predictions TO anon, authenticated;
GRANT SELECT ON public.daily_metrics TO anon, authenticated;
GRANT ALL ON public.games TO service_role;
GRANT ALL ON public.predictions TO service_role;
GRANT ALL ON public.daily_metrics TO service_role;

ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "games are public" ON public.games FOR SELECT USING (true);
CREATE POLICY "predictions are public" ON public.predictions FOR SELECT USING (true);
CREATE POLICY "metrics are public" ON public.daily_metrics FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER games_touch BEFORE UPDATE ON public.games
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
