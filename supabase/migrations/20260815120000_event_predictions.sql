-- Forward-tested prediction ledger for the event-shaped sports.
--
-- The existing `predictions` table is MLB-shaped: it hangs off `games` and
-- assumes a two-way home/away outcome with team columns. Neither soccer nor
-- tennis fits. Soccer is three-way (home / draw / away) and tennis is two
-- players with no home side at all, so forcing them into that table would mean
-- either lying about the schema or adding six nullable columns to it.
--
-- This table is deliberately event-shaped instead: two subjects, an optional
-- draw, and the metrics that make sense for whichever it is. It is the same
-- IDEA as `predictions` — write down what the model said BEFORE the event, then
-- score it afterwards — which is the only kind of record that cannot be
-- flattered after the fact. A backtest can always be re-run until it looks
-- good; a row written yesterday cannot.
--
-- `UNIQUE (model_version, event_id)` is what enforces that. A prediction is
-- written once and never overwritten, so a later run cannot quietly improve an
-- earlier call.

CREATE TABLE public.event_predictions (
  id BIGSERIAL PRIMARY KEY,

  -- Which model, and which surface of the site it belongs to.
  sport TEXT NOT NULL,                    -- 'soccer' | 'tennis'
  division TEXT NOT NULL,                 -- 'epl' | 'seriea' | 'atp' | 'wta'
  model_version TEXT NOT NULL,            -- e.g. 'soccer-elo-gd-v1'

  -- Which event.
  event_id TEXT NOT NULL,                 -- the provider's competition id
  event_date DATE NOT NULL,
  subject_a TEXT NOT NULL,                -- home side, or player A
  subject_b TEXT NOT NULL,
  context TEXT,                           -- competition, venue, surface, round

  -- What the model said, recorded before the event resolved.
  prob_a NUMERIC NOT NULL,
  prob_draw NUMERIC,                      -- NULL for two-way sports
  prob_b NUMERIC NOT NULL,
  pick TEXT NOT NULL,                     -- 'a' | 'draw' | 'b'
  pick_prob NUMERIC NOT NULL,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What happened. NULL until the event settles.
  result TEXT,                            -- 'a' | 'draw' | 'b'
  correct BOOLEAN,
  brier NUMERIC,                          -- multiclass, so comparable across sports
  log_loss NUMERIC,
  rps NUMERIC,                            -- three-way only; NULL for tennis
  final_score TEXT,
  settled_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT event_predictions_unique UNIQUE (model_version, event_id),
  CONSTRAINT event_predictions_pick_valid CHECK (pick IN ('a', 'draw', 'b')),
  CONSTRAINT event_predictions_result_valid CHECK (result IS NULL OR result IN ('a', 'draw', 'b'))
);

-- The two reads the site makes: a division's ledger newest-first, and the
-- pending rows the settler has to chase.
CREATE INDEX event_predictions_lookup
  ON public.event_predictions (sport, division, event_date DESC);
CREATE INDEX event_predictions_pending
  ON public.event_predictions (event_date)
  WHERE settled_at IS NULL;

GRANT SELECT ON public.event_predictions TO anon, authenticated;
GRANT ALL ON public.event_predictions TO service_role;

ALTER TABLE public.event_predictions ENABLE ROW LEVEL SECURITY;

-- Read-only to the world; only the service role (the cron) writes.
CREATE POLICY "Public read event_predictions"
  ON public.event_predictions FOR SELECT USING (true);

CREATE TRIGGER update_event_predictions_updated_at
BEFORE UPDATE ON public.event_predictions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
