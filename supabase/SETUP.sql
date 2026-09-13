-- ============================================================================
-- diamond-predictor — the forward prediction ledger, complete setup.
--
-- Paste this whole file into the Supabase SQL editor and run it once:
--   https://supabase.com/dashboard/project/fmhtbaikwlcjzrlisesf/sql/new
--
-- It is the migrations concatenated and made re-runnable, so running it twice
-- is harmless. It creates two tables nothing has ever been able to write to:
--
--   event_predictions   match outcomes — soccer, tennis, NFL, NBA, college
--                       football — plus the `provenance` column that keeps
--                       forward rows (written before an event) from ever being
--                       averaged with reconstructed ones (replayed afterwards).
--
--   player_predictions  player picks — the touchdown-scorer boards. Same
--                       discipline, different shape: one player, a yes/no
--                       question, more than one per game.
--
-- Until this runs, both ledgers silently accept nothing and every Track Record
-- page shows an empty record for a cron that cannot write.
--
-- Generated from:
--   supabase/migrations/20260815120000_event_predictions.sql
--   supabase/migrations/20260903120000_prediction_provenance.sql
--   supabase/migrations/20260913120000_player_predictions.sql
-- ============================================================================

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

-- The updated_at trigger helper. Already present from the MLB migrations, but
-- CREATE OR REPLACE makes this file safe to run against a fresh project too.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TABLE IF NOT EXISTS public.event_predictions (
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
CREATE INDEX IF NOT EXISTS event_predictions_lookup
  ON public.event_predictions (sport, division, event_date DESC);
CREATE INDEX IF NOT EXISTS event_predictions_pending
  ON public.event_predictions (event_date)
  WHERE settled_at IS NULL;

GRANT SELECT ON public.event_predictions TO anon, authenticated;
GRANT ALL ON public.event_predictions TO service_role;

ALTER TABLE public.event_predictions ENABLE ROW LEVEL SECURITY;

-- Read-only to the world; only the service role (the cron) writes.
-- Dropped first so this file can be run twice without erroring.
DROP POLICY IF EXISTS "Public read event_predictions" ON public.event_predictions;
CREATE POLICY "Public read event_predictions"
  ON public.event_predictions FOR SELECT USING (true);

DROP TRIGGER IF EXISTS update_event_predictions_updated_at ON public.event_predictions;
CREATE TRIGGER update_event_predictions_updated_at
BEFORE UPDATE ON public.event_predictions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- Provenance: how a ledger row came to exist.
--
-- Two very different things now live in event_predictions, and the whole value
-- of the table depends on never confusing them:
--
--   forward        written the morning of the event, before it was played.
--                  Cannot be improved afterwards. The real record.
--
--   reconstructed  computed after the fact by replaying the model over a match
--                  that had already finished, using ONLY the ratings that
--                  existed before that match. Honest arithmetic — the replay
--                  scores each match before folding its result in — but it was
--                  produced today, so it cannot prove the model was not tuned
--                  with knowledge of the period it covers.
--
-- The distinction is not a nicety. A reconstruction is a backtest: repeatable,
-- and therefore capable of being repeated until it looks good. A forward row is
-- not. Averaging them would quietly launder the second into the first, so every
-- read path splits on this column and every chart says which it is showing.
--
-- `forward` is the default, so the tracking cron needs no change: anything it
-- writes is by definition written before the event.

alter table public.event_predictions
  add column if not exists provenance text not null default 'forward';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'event_predictions_provenance_check'
  ) then
    alter table public.event_predictions
      add constraint event_predictions_provenance_check
      check (provenance in ('forward', 'reconstructed'));
  end if;
end $$;

-- When the model itself was run. For a forward row this is the morning of the
-- event; for a reconstructed one it is the day the backfill ran, which is what
-- makes the row's retroactivity visible in the data rather than only in a
-- column name.
alter table public.event_predictions
  add column if not exists computed_at timestamptz not null default now();

-- The Track Record pages always filter on (sport, division, provenance).
create index if not exists event_predictions_provenance_idx
  on public.event_predictions (sport, division, provenance, event_date);

comment on column public.event_predictions.provenance is
  'forward = written before the event (the real record); reconstructed = replayed afterwards from point-in-time ratings (a backtest). Never average the two.';


-- ============================================================================
-- Player-level picks (touchdown scorers). Same discipline, different shape:
-- one player, a yes/no question, and more than one per game. See
-- supabase/migrations/20260913120000_player_predictions.sql for why it is its
-- own table rather than another set of nullable columns on event_predictions.
-- ============================================================================

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
