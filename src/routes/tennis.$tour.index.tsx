import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AppShell, StatBar, Stat, Note } from "@/components/AppShell";
import { getTennisSlate } from "@/lib/tennis.functions";
import { tourOf, type TourSlug } from "@/lib/tennis-tours";

export const Route = createFileRoute("/tennis/$tour/")({
  head: ({ params }) => {
    const t = tourOf(params.tour);
    return {
      meta: [
        { title: `${t.name} — Diamond Edge` },
        {
          name: "description",
          content: `${t.name} singles match probabilities from a two-year rating replay, with the held-out backtest published.`,
        },
      ],
    };
  },
  component: TennisDrawPage,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

type Slate = Awaited<ReturnType<typeof getTennisSlate>>;
type Match = Slate["matches"][number];

const SURFACE_CLS: Record<string, string> = {
  clay: "text-clay border-clay/40",
  grass: "text-emerald-600 border-emerald-600/40",
  hard: "text-primary border-primary/40",
  unknown: "text-muted-foreground border-border",
};

function TennisDrawPage() {
  const { tour } = Route.useParams();
  const slug = tour as TourSlug;
  const t = tourOf(tour);
  const [date, setDate] = useState(todayISO());
  const run = useServerFn(getTennisSlate);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["tennis", "slate", slug, date],
    queryFn: () => run({ data: { tour: slug, date } }),
    // The replay is expensive cold and cached warm; hold the result.
    staleTime: 10 * 60_000,
  });

  const matches = data?.matches ?? [];
  const priced = matches.filter((m) => m.probA != null);
  const settled = priced.filter((m) => m.winner);
  const right = settled.filter((m) => (m.probA! >= 0.5 ? "a" : "b") === m.winner).length;

  return (
    <AppShell
      sport="tennis"
      view="slate"
      league={slug}
      eyebrow={`Diamond Edge · ${t.name}`}
      title={t.name === "ATP" ? "ATP Draw" : "WTA Draw"}
      blurb={`Every ${t.long.toLowerCase()} match on the date, priced by a model that replays the previous two years of tour results up to that morning. There are no teams in tennis, so there is nothing to look up — the ratings have to be rebuilt from the matches themselves.`}
      date={date}
      onDateChange={setDate}
      statBar={
        <StatBar>
          <Stat label="Matches" value={`${matches.length}`} />
          <Stat label="Priced" value={`${priced.length}`} />
          <Stat label="Settled today" value={settled.length ? `${right}/${settled.length}` : "—"} />
          <Stat
            label="Held-out accuracy"
            value={data ? `${(data.backtest.acc * 100).toFixed(1)}%` : "—"}
          />
        </StatBar>
      }
      footerNote="Data · ESPN tennis API · logistic over a two-year rating replay"
    >
      {isLoading && (
        <>
          <Note>
            Replaying two years of {t.name} results to rebuild every player&apos;s rating. Slow
            once, then cached.
          </Note>
          <div className="h-56 animate-pulse border border-border bg-card" />
        </>
      )}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load the {t.name} draw.
        </div>
      )}
      {!isLoading && data?.note && <Note>{data.note}</Note>}

      {!isLoading && (data?.tournaments.length ?? 0) > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {data!.tournaments.map((x) => (
            <span
              key={x.id}
              className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest ${SURFACE_CLS[x.surface] ?? SURFACE_CLS.unknown}`}
            >
              {x.name} · {x.surface}
            </span>
          ))}
        </div>
      )}

      {!isLoading && matches.length > 0 && (
        <div className="grid gap-3">
          {matches.map((m) => (
            <MatchCard key={m.id} match={m} />
          ))}
        </div>
      )}

      {!isLoading && (data?.table.length ?? 0) > 0 && (
        <section className="mt-10 border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-display text-2xl">Elo ratings</h2>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              After every match in the two-year window · 1500 is where a new player starts
            </p>
          </div>
          <ol>
            {data!.table.slice(0, 25).map((r, i) => (
              <li key={r.id} className="flex items-center gap-3 border-t border-border px-5 py-2.5">
                <span className="w-6 shrink-0 font-mono text-[11px] text-primary/70">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-display text-lg">{r.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {r.country}
                </span>
                <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {r.played} m
                </span>
                <span className="w-16 shrink-0 text-right font-display text-xl">
                  {Math.round(r.rating)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </AppShell>
  );
}

function MatchCard({ match: m }: { match: Match }) {
  const p = m.probA;
  const favA = p != null && p >= 0.5;
  const called = m.winner ? (favA ? "a" : "b") === m.winner : null;

  return (
    <div className="border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {m.round} · {m.tournament}
          <span className={SURFACE_CLS[m.surface] ? " text-foreground" : ""}> · {m.surface}</span>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest">
          {m.winner ? (
            <>
              <span className="text-muted-foreground">{m.scoreline ? "Final" : "Complete"}</span>
              {called != null && (
                <span className={`ml-2 ${called ? "text-emerald-600" : "text-red-500"}`}>
                  {called ? "✓ called" : "✗ missed"}
                </span>
              )}
            </>
          ) : (
            <span className="text-foreground">Scheduled</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border">
        <Side player={m.a} prob={p} won={m.winner === "a"} lead={favA} />
        <Side player={m.b} prob={p == null ? null : 1 - p} won={m.winner === "b"} lead={!favA} />
      </div>

      {p != null && (
        <div className="flex h-1.5 w-full overflow-hidden">
          <div className="bg-primary" style={{ width: `${p * 100}%` }} />
          <div className="bg-foreground/30" style={{ width: `${(1 - p) * 100}%` }} />
        </div>
      )}

      <div className="border-t border-border/60 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {p == null ? (
          <>Neither player has history in the window — left unpriced rather than guessed.</>
        ) : (
          <>
            Elo gap {m.eloGap! >= 0 ? "+" : ""}
            {Math.round(m.eloGap!)}
            {m.h2h && (
              <>
                {" · head-to-head "}
                {m.h2h.a}–{m.h2h.b}
                <span className="text-muted-foreground/70">
                  {" "}
                  (shown, not used — it made the model worse)
                </span>
              </>
            )}
            {m.scoreline && <> · {m.scoreline}</>}
          </>
        )}
      </div>
    </div>
  );
}

function Side({
  player,
  prob,
  won,
  lead,
}: {
  player: Match["a"];
  prob: number | null;
  won: boolean;
  lead: boolean;
}) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-display text-xl leading-tight">
            {player.name}
            {won && <span className="ml-2 text-emerald-600">✓</span>}
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {player.country}
            {player.seed != null && ` · seed ${player.seed}`}
          </div>
        </div>
        <div
          className={`shrink-0 font-display text-3xl ${lead && prob != null ? "text-primary" : "text-foreground"}`}
        >
          {prob == null ? "—" : pct(prob)}
        </div>
      </div>
    </div>
  );
}
