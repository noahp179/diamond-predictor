import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { SoccerShell } from "@/components/SoccerShell";
import { StatBar, Stat, Note } from "@/components/SportShell";
import { getSoccerProps } from "@/lib/soccer.functions";
import { boardPicks } from "@/lib/props-board";
import { leagueOf, type LeagueSlug } from "@/lib/soccer-leagues";
import { PremiumWall } from "@/components/Locked";

export const Route = createFileRoute("/soccer/$league/props")({
  head: ({ params }) => {
    const l = leagueOf(params.league);
    return {
      meta: [
        { title: `${l.name} Player Props — Diamond Edge` },
        {
          name: "description",
          content: `${l.name} player props — shots, shots on target, goals, assists, cards and fouls, each its own calibrated model backtested on a season it never saw.`,
        },
      ],
    };
  },
  component: SoccerPropsPage,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}`;

const TIER_CLS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

function SoccerPropsPage() {
  const { league } = Route.useParams();
  const slug = league as LeagueSlug;
  const l = leagueOf(league);
  const [date, setDate] = useState(todayISO());
  const [market, setMarket] = useState("all");
  const [strongOnly, setStrongOnly] = useState(false);
  const run = useServerFn(getSoccerProps);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["soccer", "props", slug, date],
    queryFn: () => run({ data: { league: slug, date } }),
    // Building season form is a cold, expensive replay on the server; once it
    // is warm it is instant, so hold the result rather than re-asking.
    staleTime: 10 * 60_000,
  });

  const markets = data?.markets ?? [];
  // Same one-row-per-player rule the MLB board uses: every market is priced
  // independently, so without it a forward fills the card at 1+, 2+ and 3+
  // shots and nobody else gets a row.
  const fixtures = useMemo(
    () =>
      (data?.fixtures ?? [])
        .map((f) => ({ ...f, picks: boardPicks(f.picks, market, strongOnly) }))
        .filter((f) => f.picks.length > 0),
    [data, market, strongOnly],
  );
  const shown = fixtures.flatMap((f) => f.picks);
  const strongCount = (data?.fixtures ?? []).flatMap((f) =>
    boardPicks(f.picks, market, true),
  ).length;
  const active = markets.find((m) => m.key === market);

  return (
    <SoccerShell
      league={slug}
      current="props"
      eyebrow={`Diamond Edge · ${l.name} Props`}
      title="Player Props"
      blurb={`Ten markets per player — 1+/2+/3+ shots, 1+/2+ on target, goal, assist, goal involvement, card and 2+ fouls — each its own logistic over season-to-date form, a six-match window, last season, and the opponent's concession rates. Fitted on ${l.name} alone and scored on a season it never saw.`}
      date={date}
      onDateChange={setDate}
      statBar={
        <StatBar>
          <Stat label="Fixtures" value={`${fixtures.length}`} />
          <Stat label="Picks" value={`${shown.length}`} />
          <Stat label="Strong picks" value={`${strongCount}`} />
          <Stat
            label={active ? "Market AUC" : "Markets"}
            value={active ? active.auc.toFixed(3) : `${markets.length}`}
          />
        </StatBar>
      }
      footerNote={`Data · ESPN soccer API · per-league logistic prop models`}
    >
      {!isLoading && data?.locked && (
        <PremiumWall tier={data.tier} title={`${l.name} player props`} />
      )}

      {isLoading && (
        <>
          <Note>
            Building season form for {l.name}. ESPN publishes no season-to-date shot or foul totals,
            so every completed match this season is being replayed to get them. This is slow once,
            then cached.
          </Note>
          <div className="h-56 animate-pulse border border-border bg-card" />
        </>
      )}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load {l.name} props.
        </div>
      )}
      {!isLoading && !data?.locked && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !data?.locked && markets.length > 0 && (
        <div className="mb-6 border border-border bg-card">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
            {[{ key: "all", label: "Top picks", auc: 0, base: 0 }, ...markets].map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMarket(m.key)}
                aria-pressed={market === m.key}
                className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                  market === m.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {market === m.key ? "▸ " : ""}
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {active
                ? `${active.label} · base rate ${pct(active.base)} · held-out AUC ${active.auc.toFixed(3)}`
                : "One row per player, at their biggest edge over an average starter"}
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
              {strongOnly ? "▸ " : ""}Strong only ({strongCount})
            </button>
          </div>
        </div>
      )}

      {!isLoading && !data?.locked && fixtures.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {fixtures.map((f) => (
            <div key={f.matchId} className="border border-border bg-card p-5">
              <div className="mb-2 font-mono text-sm uppercase tracking-widest text-foreground">
                {f.matchup}
              </div>
              <div>
                {f.picks.map((p) => {
                  const cls = TIER_CLS[p.tier ?? "Lean"] ?? TIER_CLS.Lean;
                  return (
                    <div
                      key={`${p.playerId}-${p.market}`}
                      className="flex items-center gap-3 border-t border-border py-3 first:border-t-0"
                    >
                      <span className="w-6 shrink-0 font-mono text-[11px] text-primary/70">
                        {p.pos || "—"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-display text-lg leading-tight">
                          {p.player}
                        </div>
                        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                          {p.team} v {p.opponent}
                          {market === "all" ? ` · ${p.label}` : ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-display text-2xl leading-none">{pct(p.prob)}</div>
                        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          {signed(p.edge)} vs avg
                        </div>
                      </div>
                      <div
                        className={`w-20 shrink-0 border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${cls}`}
                        title={
                          p.tierHitRate != null
                            ? `${p.tier}: picks in this tier hit ${pct(p.tierHitRate)} of the time on the held-out season.`
                            : "No backtested tier."
                        }
                      >
                        <div className="text-xs leading-none">{p.tier ?? "—"}</div>
                        <div className="mt-0.5">
                          {p.tierHitRate != null ? pct(p.tierHitRate) : "—"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && !data?.locked && !isError && fixtures.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No fixtures to project</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Pick a matchday. Props need a fixture and enough season history for the model to read.
          </p>
        </div>
      )}
    </SoccerShell>
  );
}
