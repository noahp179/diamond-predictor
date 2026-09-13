-- Forward-tested ledger for PLAYER picks, starting with anytime touchdown
-- scorers.
--
-- WHY A THIRD TABLE
-- -----------------
-- The other two are both game-shaped. `predictions` hangs off `games` and
-- assumes a home/away outcome; `event_predictions` is two subjects with an
-- optional draw. A touchdown pick is neither: the subject is one player, the
-- question is yes/no, and a single game carries more than one of them.
--
-- It could have been forced into `event_predictions` — a TD pick really is a
-- two-outcome event, so the probability columns would work — but `subject_b`
-- would have had to hold the string "did not score", and the player id would
-- have had to be smuggled into `event_id` to get past its UNIQUE constraint.
-- Both are the kind of small lie that a year later nobody can read the table
-- without being told about.
--
-- The discipline is identical to the other two, and it is the only part that
-- matters: a row is written the morning of the game, BEFORE it is played, and
-- scored afterwards. UNIQUE (model_version, event_id, player_id) enforces
-- write-once, so a later run cannot quietly improve an earlier call.
--
-- `market` is here so the table outlives touchdowns. Every prop board on the
-- site — NFL receptions and rushing yards, MLB total bases — has the same
-- shape and the same gap, and none of them should need a fourth table.

CREATE TABLE IF NOT EXISTS public.player_predictions (
  id BIGSERIAL PRIMARY KEY,

  sport TEXT NOT NULL,                    -- 'cfb' | 'nfl'
  market TEXT NOT NULL,                   -- 'anytime_td'
  model_version TEXT NOT NULL,            -- e.g. 'cfb-td-logistic-v1'

  -- Which game, and who.
  event_id TEXT NOT NULL,                 -- ESPN event id
  event_date DATE NOT NULL,
  player_id TEXT NOT NULL,                -- ESPN athlete id — settled on this,
                                          -- never on the name
  player TEXT NOT NULL,
  team TEXT NOT NULL,
  position TEXT,
  matchup TEXT,                           -- 'KENT @ OSU', for reading the row

  -- Where the pick sat on the card. 1 is the lead pick; the college board shows
  -- a 2 only when the model says it is worth showing, so the rank is itself a
  -- thing worth scoring separately.
  pick_rank INT NOT NULL,
  prob NUMERIC NOT NULL,                  -- P(scores), as displayed
  tier TEXT,                              -- 'Strong' | 'Solid' | 'Lean'
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What happened. NULL until the game settles.
  scored BOOLEAN,                         -- rushing or receiving TD
  touchdowns INT,
  brier NUMERIC,
  log_loss NUMERIC,
  final_score TEXT,
  settled_at TIMESTAMPTZ,

  -- Same meaning as on event_predictions: 'forward' is a row written before the
  -- game. Nothing here writes 'reconstructed' today, and the read path filters
  -- on it anyway so that a future backfill cannot be averaged in by accident.
  provenance TEXT NOT NULL DEFAULT 'forward',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT player_predictions_unique UNIQUE (model_version, event_id, player_id),
  CONSTRAINT player_predictions_provenance_check CHECK (provenance IN ('forward', 'reconstructed')),
  CONSTRAINT player_predictions_prob_valid CHECK (prob >= 0 AND prob <= 1)
);

-- The two reads: a sport's ledger newest-first, and the rows the settler chases.
CREATE INDEX IF NOT EXISTS player_predictions_lookup
  ON public.player_predictions (sport, market, provenance, event_date DESC);
CREATE INDEX IF NOT EXISTS player_predictions_pending
  ON public.player_predictions (event_date)
  WHERE settled_at IS NULL;

GRANT SELECT ON public.player_predictions TO anon, authenticated;
GRANT ALL ON public.player_predictions TO service_role;

ALTER TABLE public.player_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read player_predictions" ON public.player_predictions;
CREATE POLICY "Public read player_predictions"
  ON public.player_predictions FOR SELECT USING (true);

DROP TRIGGER IF EXISTS update_player_predictions_updated_at ON public.player_predictions;
CREATE TRIGGER update_player_predictions_updated_at
BEFORE UPDATE ON public.player_predictions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.player_predictions IS
  'Player-level picks written before the game and scored after it. Settled on ESPN athlete id, never on player name.';
