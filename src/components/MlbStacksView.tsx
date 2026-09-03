import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { getMlbStacks } from "@/lib/sports.functions";

type Result = Awaited<ReturnType<typeof getMlbStacks>>;
type Team = Result["teams"][number];
type Card = Team["cards"][number];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const price = (x: number) => `${x > 0 ? "+" : ""}${x}`;

/**
 * Tier styling, shared with the Player Props board. The tiers come from the
 * model file — cut on the held-out 2026 season where the card's hit rate
 * actually separates. See research/mlb-stacks/final_stacks.py.
 */
const TIER_CLS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

function CardRow({ card }: { card: Card }) {
  const cls = TIER_CLS[card.tier ?? "Lean"] ?? TIER_CLS.Lean;
  return (
    <div className="flex items-center gap-3 border-t border-border py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="font-display text-base leading-tight">
          {card.legs.map((l, i) => (
            <span key={l.label}>
              {i > 0 && <span className="px-1.5 text-muted-foreground">+</span>}
              <span className={l.kind === "team" ? "text-primary" : undefined}>{l.label}</span>
            </span>
          ))}
        </div>
        <div className="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {card.legs.length} legs · independence would say {pct1(card.independent)} ·{" "}
          <span className="text-foreground">{card.lift.toFixed(2)}×</span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-display text-2xl leading-none text-foreground">{pct1(card.prob)}</div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          breakeven {price(card.breakeven)}
        </div>
      </div>
      <div
        className={`w-20 shrink-0 border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${cls}`}
        title={
          card.tierHitRate != null
            ? `${card.tier}: cards in this tier landed ${pct1(card.tierHitRate)} of the time across the held-out 2026 season.`
            : "Tiers are measured for the two-leg card (team total + one bat); longer cards are priced by the same correlation but have no tier of their own."
        }
      >
        <div className="text-xs leading-none">{card.tier ?? "—"}</div>
        <div className="mt-0.5">{card.tierHitRate != null ? pct(card.tierHitRate) : "—"}</div>
      </div>
    </div>
  );
}

function TeamCard({ team }: { team: Team }) {
  const over = team.totals.find((t) => t.market === "r5");
  return (
    <div className="border border-border bg-card p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="font-display text-2xl leading-none">
            <span className="mr-2 font-mono text-sm text-primary/70">#{team.slateRank}</span>
            {team.team}
          </div>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {team.matchup} · {team.venue}
            {team.opposingStarter ? ` · vs ${team.opposingStarter}` : ""}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-3xl leading-none text-foreground">
            {team.expRuns.toFixed(1)}
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            proj. runs
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {team.totals.map((t) => (
          <div
            key={t.market}
            className="border border-border px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
            title={
              t.tierHitRate != null
                ? `${t.tier}: team totals in this tier cleared the line ${pct1(t.tierHitRate)} of the time on the held-out 2026 season (base ${pct1(t.base)}).`
                : undefined
            }
          >
            over {t.line} <span className="text-foreground">{pct(t.prob)}</span>
            {t.tier ? <span className="ml-1 text-primary/70">{t.tier}</span> : null}
          </div>
        ))}
        {team.park !== 1 && (
          <div className="border border-border px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            park {Math.round(team.park * 100)}
          </div>
        )}
      </div>

      {team.cards.length > 0 ? (
        <div>
          {team.cards.map((c) => (
            <CardRow key={c.key} card={c} />
          ))}
        </div>
      ) : (
        <div className="border-t border-border py-4 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          No lineup posted yet — the team total{over ? ` sits at ${pct(over.prob)}` : ""} until the
          card lands.
        </div>
      )}
    </div>
  );
}

export function MlbStacksView() {
  const [date, setDate] = useState(todayISO());
  const [strongOnly, setStrongOnly] = useState(false);
  const run = useServerFn(getMlbStacks);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["mlb", "stacks", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const allTeams = useMemo(() => data?.teams ?? [], [data]);
  const strong = useMemo(
    () => allTeams.filter((t) => t.cards.some((c) => c.tier === "Strong")),
    [allTeams],
  );
  const teams = strongOnly ? strong : allTeams;
  const strongCount = strong.length;
  const best = allTeams[0];
  const bt = data?.backtest ?? null;

  return (
    <SportShell
      sport="mlb"
      current="stacks"
      eyebrow="Diamond Edge · MLB Team Stacks"
      title="Team Stacks"
      blurb="The night's biggest offences, and the hitters off those lineups, priced together rather than one at a time. A team total and a bat from the same lineup are not independent bets — a hitter's total bases are part of his team's runs — so the two legs are combined through a correlation measured on 2024-25 and checked against the 2026 season the models never saw."
      date={date}
      onDateChange={setDate}
      footerNote="Data · MLB Stats API · team run models + the 2+ total-bases market · Not affiliated with MLB"
      statBar={
        <StatBar>
          <Stat label="Lineups" value={`${allTeams.length}`} />
          <Stat
            label="Top offence"
            value={best ? `${best.team} ${best.expRuns.toFixed(1)}` : "—"}
          />
          <Stat
            label="Correlation lift"
            value={bt ? `${(bt.pairObserved / bt.pairIndependence).toFixed(2)}×` : "—"}
          />
          <Stat label="Season" value={data?.seasonLabel || "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load team stacks. The MLB Stats API may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !isError && bt && allTeams.length > 0 && (
        <div className="mb-6 border border-border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Team total + a bat off that lineup
              </div>
              <div className="mt-1 font-display text-xl">
                {pct1(bt.pairObserved)} <span className="text-muted-foreground">actual</span>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                independence said {pct1(bt.pairIndependence)}; this model {pct1(bt.pairModel)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                The night's top-1 offence
              </div>
              <div className="mt-1 font-display text-xl">
                {bt.top1Runs.toFixed(2)} <span className="text-muted-foreground">runs</span>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                against a slate average of {bt.slateMean.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                2+ TB on a top-3 offence
              </div>
              <div className="mt-1 font-display text-xl">
                {pct1(bt.gateTop3)} <span className="text-muted-foreground">hit</span>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                against {pct1(bt.gateAll)} for every starter
              </div>
            </div>
          </div>
          <div className="mt-3 border-t border-border pt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Measured correlations · bat ↔ own team total {bt.correlation.teamHitter.toFixed(3)} ·
            bat ↔ bat, same lineup {bt.correlation.hitterHitter.toFixed(3)}
          </div>
        </div>
      )}

      {!isLoading && !isError && allTeams.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {bt?.cardTiers.map((t) => `${t.label} ${pct(t.hitRate)}`).join(" · ")}
          </div>
          <button
            type="button"
            onClick={() => setStrongOnly((v) => !v)}
            aria-pressed={strongOnly}
            className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
              strongOnly
                ? "border-primary text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {strongOnly ? "▸ " : ""}Strong cards only ({strongCount})
          </button>
        </div>
      )}

      {!isLoading && !isError && teams.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {teams.map((t) => (
            <TeamCard key={`${t.gameId}:${t.teamId}`} team={t} />
          ))}
        </div>
      )}

      {!isLoading && !isError && teams.length === 0 && allTeams.length > 0 && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No Strong cards tonight</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            No lineup produces a two-leg card in the top tier. Turn the filter off to see the whole
            slate — those cards land closer to {bt ? pct(bt.cardTiers.at(-1)?.hitRate ?? 0) : "16%"}
            .
          </p>
        </div>
      )}

      {!isLoading && !isError && allTeams.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to stack</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Pick a day with a slate. Team run models need a season of games behind them, so the
            board sharpens after the first couple of weeks.
          </p>
        </div>
      )}
    </SportShell>
  );
}
