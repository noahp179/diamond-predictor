import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SoccerShell } from "@/components/SoccerShell";
import { StatBar, Stat, Note } from "@/components/SportShell";
import { getSoccerSlate } from "@/lib/soccer.functions";
import { leagueOf, type LeagueSlug } from "@/lib/soccer-leagues";

export const Route = createFileRoute("/soccer/$league/")({
  head: ({ params }) => {
    const l = leagueOf(params.league);
    return {
      meta: [
        { title: `${l.name} — Diamond Edge` },
        {
          name: "description",
          content:
            l.slug === "ucl"
              ? "Champions League match predictions: home, draw and away, expected goals and likely scores from one Elo rating every club in Europe, against the posted market."
              : `${l.name} match predictions: home, draw and away probabilities from a goal-difference Elo calibrated on ${l.name} seasons alone.`,
        },
      ],
    };
  },
  component: SoccerSlatePage,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

type Slate = Awaited<ReturnType<typeof getSoccerSlate>>;
type Match = Slate["matches"][number];

function SoccerSlatePage() {
  const { league } = Route.useParams();
  const slug = league as LeagueSlug;
  const l = leagueOf(league);
  const [date, setDate] = useState(todayISO());
  const run = useServerFn(getSoccerSlate);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["soccer", "slate", slug, date],
    queryFn: () => run({ data: { league: slug, date } }),
    staleTime: 60_000,
  });

  const matches = data?.matches ?? [];
  // The Champions League rates from a snapshot; before its cut-off the table
  // shows the snapshot, not that date.
  const cutoff = data && "ratings" in data ? data.ratings?.cutoff : undefined;
  const priced = matches.filter((m) => m.probs != null);
  const surest = priced.reduce<Match | null>((best, m) => {
    const p = Math.max(m.probs!.home, m.probs!.draw, m.probs!.away);
    const b = best ? Math.max(best.probs!.home, best.probs!.draw, best.probs!.away) : 0;
    return p > b ? m : best;
  }, null);

  return (
    <SoccerShell
      league={slug}
      current="slate"
      eyebrow={`Diamond Edge · ${l.name}`}
      title={l.name}
      blurb={
        slug === "ucl"
          ? "Home, draw and away, expected goals and the likeliest scores for every fixture. The clubs come from twenty leagues, so the ratings are ONE Elo across all of them — 91,000 domestic and European matches since 2013 — and the market price sits alongside for comparison. Every match can be played out on the Simulate page."
          : `Home, draw and away for every fixture. The model is a goal-difference Elo replayed over completed ${l.name} matches, then mapped to three probabilities by a calibration fitted on ${l.name} seasons alone — no other league feeds it.`
      }
      date={date}
      onDateChange={setDate}
      statBar={
        <StatBar>
          <Stat label="Fixtures" value={`${matches.length}`} />
          <Stat label="Season" value={data?.seasonLabel || "—"} />
          <Stat label="Held-out RPS" value={data ? data.backtest.rps.toFixed(4) : "—"} />
          <Stat
            label="Surest call"
            value={
              surest
                ? `${pct(Math.max(surest.probs!.home, surest.probs!.draw, surest.probs!.away))}`
                : "—"
            }
          />
        </StatBar>
      }
      footerNote={
        slug === "ucl"
          ? "Data · ESPN soccer API · cross-league Elo with Dixon-Coles scorelines · market prices as ESPN posts them"
          : `Data · ESPN soccer API · goal-difference Elo calibrated on ${l.name}`
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load {l.name} fixtures.
        </div>
      )}
      {!isLoading && data?.note && <Note>{data.note}</Note>}

      {!isLoading && matches.length > 0 && (
        <div className="grid gap-4">
          {matches.map((m) => (
            <MatchCard key={m.id} match={m} league={slug} date={date} />
          ))}
        </div>
      )}

      {!isLoading && (data?.table.length ?? 0) > 0 && (
        <section className="mt-10 border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-display text-2xl">Power ratings</h2>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {slug === "ucl"
                ? `This season's clubs · one Elo across every league · ratings as of ${cutoff && date < cutoff ? cutoff : date}`
                : "Elo after every completed match this season · 1500 is average"}
            </p>
          </div>
          <ol>
            {data!.table.slice(0, slug === "ucl" ? 36 : 20).map((r, i) => (
              <li
                key={r.team.id}
                className="flex items-center gap-3 border-t border-border px-5 py-2.5"
              >
                <span className="w-6 shrink-0 font-mono text-[11px] text-primary/70">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-display text-lg">{r.team.name}</span>
                {slug !== "ucl" && (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {r.played} pl
                  </span>
                )}
                <span className="w-16 shrink-0 text-right font-display text-xl">
                  {Math.round(r.rating)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </SoccerShell>
  );
}

function MatchCard({ match, league, date }: { match: Match; league: LeagueSlug; date: string }) {
  const p = match.probs;
  const played = match.result != null;
  // The side the model leaned on, and whether the match bore it out.
  const pick = p
    ? p.home >= p.draw && p.home >= p.away
      ? "H"
      : p.away >= p.draw
        ? "A"
        : "D"
    : null;
  const right = played && pick ? pick === match.result : null;

  return (
    <div className="border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border/60 px-5 py-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {match.venue || "Venue TBC"}
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="font-display text-2xl">{match.home.name}</span>
            <span className="font-mono text-xs text-muted-foreground">v</span>
            <span className="font-display text-2xl">{match.away.name}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {played ? "Result" : "Status"}
          </div>
          <div className="mt-1 font-mono text-sm">
            {played ? (
              <>
                <span className="text-foreground">
                  {match.homeGoals}–{match.awayGoals}
                </span>
                {right != null && (
                  <span className={`ml-2 ${right ? "text-emerald-600" : "text-red-500"}`}>
                    {right ? "✓" : "✗"}
                  </span>
                )}
              </>
            ) : (
              <span className="text-foreground">{match.status}</span>
            )}
          </div>
        </div>
      </div>

      {p ? (
        <>
          <div className="grid grid-cols-3 gap-px bg-border">
            <Outcome label={match.home.abbr} value={p.home} lead={pick === "H"} />
            <Outcome label="Draw" value={p.draw} lead={pick === "D"} />
            <Outcome label={match.away.abbr} value={p.away} lead={pick === "A"} />
          </div>
          <div className="flex h-2 w-full overflow-hidden">
            <div className="bg-primary" style={{ width: `${p.home * 100}%` }} />
            <div className="bg-foreground/30" style={{ width: `${p.draw * 100}%` }} />
            <div className="bg-foreground/60" style={{ width: `${p.away * 100}%` }} />
          </div>
        </>
      ) : (
        <div className="px-5 py-6 font-mono text-xs text-muted-foreground">
          One of these sides has no rating yet — a promoted club early in the season, most likely.
          Rather than invent a number, this fixture is left unpriced.
        </div>
      )}
      {match.price && <Scorelines match={match} league={league} date={date} />}
    </div>
  );
}

/** The Champions League's extra row: goals, scorelines and the market. */
function Scorelines({ match, league, date }: { match: Match; league: LeagueSlug; date: string }) {
  const pr = match.price!;
  const mk = match.market;
  return (
    <div className="grid gap-3 border-t border-border/60 px-5 py-4 font-mono text-[11px] text-muted-foreground sm:grid-cols-[1fr_auto]">
      <div className="space-y-1.5">
        <div>
          <span className="uppercase tracking-widest">Expected goals</span>{" "}
          <span className="text-foreground">
            {pr.xgHome.toFixed(2)} – {pr.xgAway.toFixed(2)}
          </span>
          <span className="ml-3 uppercase tracking-widest">Over 2.5</span>{" "}
          <span className="text-foreground">{pct(pr.over25)}</span>
          <span className="ml-3 uppercase tracking-widest">Both score</span>{" "}
          <span className="text-foreground">{pct(pr.btts)}</span>
        </div>
        {pr.scores.length > 0 && (
          <div>
            <span className="uppercase tracking-widest">Likeliest</span>{" "}
            {pr.scores.slice(0, 4).map((s, i) => (
              <span key={s.score} className={i === 0 ? "text-foreground" : ""}>
                {i > 0 && " · "}
                {s.score} ({(s.p * 100).toFixed(0)}%)
              </span>
            ))}
          </div>
        )}
        {mk && (
          <div>
            <span className="uppercase tracking-widest">Market</span>{" "}
            <span className="text-foreground">
              {pct(mk.home)} · {pct(mk.draw)} · {pct(mk.away)}
            </span>{" "}
            <span>
              ({mk.provider || "posted"}, {(mk.overround * 100).toFixed(1)}% margin removed)
            </span>
          </div>
        )}
      </div>
      {league === "ucl" && !match.completed && (
        <Link
          to="/soccer/$league/simulate"
          params={{ league }}
          search={{ date, game: match.id }}
          className="self-center border border-border px-3 py-2 uppercase tracking-widest text-foreground transition-colors hover:border-primary hover:text-primary"
        >
          Simulate →
        </Link>
      )}
    </div>
  );
}

function Outcome({ label, value, lead }: { label: string; value: number; lead: boolean }) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 font-display text-3xl ${lead ? "text-primary" : "text-foreground"}`}>
        {pct(value)}
      </div>
    </div>
  );
}
