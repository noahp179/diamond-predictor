-- stack_predictions: MLB team stacks and team totals, as the board offered them.
--
-- WHY A FOURTH TABLE
-- ------------------
-- A stack card is several legs that must ALL hit — "Dodgers over 4.5 runs AND
-- Ohtani 2+ total bases" — priced together with the correlation between them.
-- It is not one player's yes/no (player_predictions), and it is not a slip
-- built from a slate's best legs (parlay_predictions, one per size per day): a
-- slate carries several cards per team. Squeezing it into either would mean
-- smuggling the legs into a text column or the team into `market`, which is
-- exactly the kind of small lie the other ledgers' notes warn against.
--
-- A team total ("over 4.5 runs") is stored here too, as a one-leg card, so the
-- whole Team Stacks board has one record.
--
-- Same discipline as every ledger: written before first pitch, scored from the
-- box score afterwards, never revised. UNIQUE (model_version, event_id,
-- team_id, card_key) makes it write-once.

create table if not exists public.stack_predictions (
  id bigserial primary key,

  sport text not null default 'mlb',
  model_version text not null,            -- e.g. 'mlb-stacks-v1'

  event_id text not null,                 -- MLB gamePk
  event_date date not null,
  team_id text not null,
  team text not null,
  matchup text,

  -- Which card. 'total:r5' for a team total; 't+<id>', 't+<id>+<id>' or
  -- '<id>+<id>' for a stack (t = the team's over-4.5 leg).
  card_key text not null,
  kind text not null,                     -- 'stack' | 'total'
  -- Every leg, so the card settles from the box score without re-deriving it:
  --   {"kind":"team","line":4.5,"label":"LAD over 4.5 runs","prob":0.52}
  --   {"kind":"batter","playerId":"660271","market":"tb2","label":"...","prob":0.44}
  legs jsonb not null,
  leg_count int not null,
  prob numeric not null,                  -- P(every leg hits), as displayed
  independent_prob numeric,               -- what independence would have said
  tier text,
  predicted_at timestamptz not null default now(),

  -- What happened. NULL until the game is final.
  legs_hit int,
  won boolean,                            -- NULL with settled_at set = void
  brier numeric,
  log_loss numeric,
  final_score text,
  settled_at timestamptz,

  provenance text not null default 'forward',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint stack_predictions_unique unique (model_version, event_id, team_id, card_key),
  constraint stack_predictions_kind_valid check (kind in ('stack', 'total')),
  constraint stack_predictions_provenance_check check (provenance in ('forward', 'reconstructed')),
  constraint stack_predictions_prob_valid check (prob >= 0 and prob <= 1)
);

create index if not exists stack_predictions_lookup
  on public.stack_predictions (sport, kind, provenance, event_date desc);
create index if not exists stack_predictions_pending
  on public.stack_predictions (event_date)
  where settled_at is null;

grant select on public.stack_predictions to anon, authenticated;
grant all on public.stack_predictions to service_role;

alter table public.stack_predictions enable row level security;

drop policy if exists "Public read stack_predictions" on public.stack_predictions;
create policy "Public read stack_predictions"
  on public.stack_predictions for select using (true);

drop trigger if exists update_stack_predictions_updated_at on public.stack_predictions;
create trigger update_stack_predictions_updated_at
before update on public.stack_predictions
for each row execute function public.update_updated_at_column();

comment on table public.stack_predictions is
  'MLB team stacks and team totals as offered, written before first pitch and settled from the box score. A card wins iff every leg hits; a batter who did not bat voids the card.';

-- ledger_health gains the stacks ledger.
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
group by sport, market
union all
select
  'stack_predictions', sport, kind,
  count(*),
  count(*) filter (where settled_at is not null),
  count(*) filter (where settled_at is null and event_date <= current_date),
  count(*) filter (where settled_at is null and event_date < current_date - 3),
  min(event_date) filter (where settled_at is null and event_date <= current_date),
  max(settled_at),
  max(predicted_at)
from public.stack_predictions
where provenance = 'forward'
group by sport, kind;

grant select on public.ledger_health to anon, authenticated;
