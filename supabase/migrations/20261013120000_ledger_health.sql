-- ledger_health: is every ledger keeping up?
--
-- WHY
-- From late September 2026 the settler fell behind by about a day a day: rows
-- were written every morning and almost none were scored, so the Track Record
-- pages froze while every status flag stayed green ("writable", "ledgerReady").
-- Nothing showed it except the age of the oldest unsettled row, and nothing
-- reported that.
--
-- This view does, for all three ledgers, one row per sport and division (or
-- market). Read it any time:
--
--   select * from public.ledger_health order by oldest_pending;
--
-- What healthy looks like: `pending_over_3_days` is 0 or a handful (postponed
-- matches, walkovers), and `last_settled_at` is from this morning's cron. A
-- growing `pending_over_3_days` means the settler is not keeping up.
--
-- security_invoker so the underlying tables' row-level security applies to
-- whoever reads it — the tables are world-readable, so this changes nothing
-- for anyone, but it keeps Supabase's linter quiet and the view honest.

create or replace view public.ledger_health
with (security_invoker = true) as
select
  'event_predictions'::text as ledger,
  sport,
  division as slice,
  count(*) as rows,
  count(*) filter (where settled_at is not null) as settled,
  count(*) filter (where settled_at is null and event_date <= current_date) as pending,
  count(*) filter (where settled_at is null and event_date < current_date - 3) as pending_over_3_days,
  min(event_date) filter (where settled_at is null and event_date <= current_date) as oldest_pending,
  max(settled_at) as last_settled_at,
  max(predicted_at) as last_predicted_at
from public.event_predictions
where provenance = 'forward'
group by sport, division
union all
select
  'player_predictions', sport, market,
  count(*),
  count(*) filter (where settled_at is not null),
  count(*) filter (where settled_at is null and event_date <= current_date),
  count(*) filter (where settled_at is null and event_date < current_date - 3),
  min(event_date) filter (where settled_at is null and event_date <= current_date),
  max(settled_at),
  max(predicted_at)
from public.player_predictions
where provenance = 'forward'
group by sport, market
union all
select
  'parlay_predictions', sport, market,
  count(*),
  count(*) filter (where settled_at is not null),
  count(*) filter (where settled_at is null and slate_date <= current_date),
  count(*) filter (where settled_at is null and slate_date < current_date - 3),
  min(slate_date) filter (where settled_at is null and slate_date <= current_date),
  max(settled_at),
  max(predicted_at)
from public.parlay_predictions
where provenance = 'forward'
group by sport, market;

grant select on public.ledger_health to anon, authenticated;

comment on view public.ledger_health is
  'One row per ledger slice: rows, settled, pending, how stale the oldest pending row is, and when the settler last wrote. pending_over_3_days growing = the settler is falling behind.';
