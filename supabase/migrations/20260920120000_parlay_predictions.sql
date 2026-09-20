
-- ---------------------------------------------------------------- parlays
--
-- A slip is not a pick, and it cannot be reconstructed from picks.
--
-- Every leg of a touchdown parlay is already a row in player_predictions, so
-- it is tempting to derive the slip's result by re-running the builder and
-- looking its legs up. That does not work and would quietly lie: the board is
-- rebuilt live on every request, from whatever the slate and the injury report
-- say at that moment, and the date it lands on depends on a forward scan. Two
-- runs a day apart produce different slips. The only honest record of what the
-- board offered is a row written when it offered it.
--
-- So the composition is frozen here — the legs, the stated probability, the
-- correlation factor applied, and the construction it was built at — and the
-- outcome is filled in later.
--
-- SETTLEMENT READS player_predictions RATHER THAN THE BOX SCORE. Each leg is
-- already being settled there against an ESPN athlete id. Scoring a slip a
-- second way would create two sources for one fact, and the first time they
-- disagreed there would be no way to tell which was right. A slip wins iff
-- every one of its legs is settled and scored.

CREATE TABLE IF NOT EXISTS public.parlay_predictions (
  id BIGSERIAL PRIMARY KEY,

  sport TEXT NOT NULL,                    -- 'cfb' | 'nfl'
  market TEXT NOT NULL,                   -- 'anytime_td' | 'first_td' | 'td2'
  model_version TEXT NOT NULL,

  slate_date DATE NOT NULL,               -- the day the slip's games are on
  size INT NOT NULL,                      -- legs asked for: 5 | 10 | 15 | 20
  max_per_game INT NOT NULL,              -- the construction; 0 means unrestricted

  -- What the slip actually was. `legs` carries the athlete and event ids so
  -- settlement is a join rather than a name match, and enough display fields
  -- that an old slip can be read back without re-deriving anything.
  legs JSONB NOT NULL,
  leg_count INT NOT NULL,                 -- may be < size on a thin slate
  short BOOLEAN NOT NULL DEFAULT false,   -- true when the slate could not fill it

  -- The numbers the card printed, kept apart. `stated_prob` is what a reader
  -- saw; `combined_prob` is the plain product before the correlation
  -- correction. Storing both is what makes it possible to ask later whether
  -- the correction helped.
  stated_prob NUMERIC NOT NULL,
  combined_prob NUMERIC NOT NULL,
  correlation_factor NUMERIC NOT NULL,
  fair_price INT,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What happened. NULL until every leg has settled.
  legs_hit INT,
  won BOOLEAN,
  settled_at TIMESTAMPTZ,

  provenance TEXT NOT NULL DEFAULT 'forward',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One slip per sport, market, size and construction per slate. Re-running
  -- the cron the same morning must not write a second row, and the board only
  -- offers one slip per combination.
  CONSTRAINT parlay_predictions_unique
    UNIQUE (model_version, slate_date, market, size, max_per_game),
  CONSTRAINT parlay_predictions_provenance_check
    CHECK (provenance IN ('forward', 'reconstructed')),
  CONSTRAINT parlay_predictions_prob_valid
    CHECK (stated_prob >= 0 AND stated_prob <= 1)
);

CREATE INDEX IF NOT EXISTS parlay_predictions_lookup
  ON public.parlay_predictions (sport, market, provenance, slate_date DESC);
CREATE INDEX IF NOT EXISTS parlay_predictions_pending
  ON public.parlay_predictions (slate_date)
  WHERE settled_at IS NULL;

GRANT SELECT ON public.parlay_predictions TO anon, authenticated;
GRANT ALL ON public.parlay_predictions TO service_role;

ALTER TABLE public.parlay_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read parlay_predictions" ON public.parlay_predictions;
CREATE POLICY "Public read parlay_predictions"
  ON public.parlay_predictions FOR SELECT USING (true);

DROP TRIGGER IF EXISTS update_parlay_predictions_updated_at ON public.parlay_predictions;
CREATE TRIGGER update_parlay_predictions_updated_at
BEFORE UPDATE ON public.parlay_predictions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.parlay_predictions IS
  'Touchdown parlay slips as offered, frozen before the slate and settled from player_predictions. A slip wins iff every leg scored.';
