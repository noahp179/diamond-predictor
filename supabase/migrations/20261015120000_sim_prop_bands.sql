-- sim_prop_bands: the Analytics pages' one read. Every simulation pick in the
-- ledger, counted per market, per confidence band (0-10%, 10-20%, ... 90-100%,
-- by the probability the board showed) and per rank on the game's card: how
-- many settled, how many came in, what they were priced at in total, how many
-- were voided (the player did not play) and how many still wait on a result.
-- A few hundred rows a sport, however long the ledger grows.

create or replace view public.sim_prop_bands
with (security_invoker = true) as
select
  sport,
  market,
  pick_rank,
  least(floor(prob * 10), 9)::int as band,
  count(*) filter (where settled_at is not null and scored is not null) as n,
  count(*) filter (where scored) as hits,
  coalesce(sum(prob) filter (where settled_at is not null and scored is not null), 0) as said,
  count(*) filter (where settled_at is not null and scored is null) as voids,
  count(*) filter (where settled_at is null) as pending,
  min(event_date) as first_date,
  max(event_date) filter (where settled_at is not null) as last_settled
from public.player_predictions
where model_version like '%-sim-%' and provenance = 'forward'
group by 1, 2, 3, 4;

grant select on public.sim_prop_bands to anon, authenticated;

comment on view public.sim_prop_bands is
  'Simulation picks per market, confidence band and card rank: settled, hits, total price, voids, pending. Read by the Props > Analytics pages.';
