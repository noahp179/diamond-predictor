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
