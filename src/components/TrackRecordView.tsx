import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import type { getNbaTrackRecord } from "@/lib/sports.functions";

type Result = Awaited<ReturnType<typeof getNbaTrackRecord>>;
type Fn = () => Promise<Result>;

function pct(n: number | null | undefined, d = 1) {
  return n == null ? "—" : `${(n * 100).toFixed(d)}%`;
}

export function TrackRecordView({
  sport,
  fetchTrackRecord,
}: {
  sport: "nfl" | "nba";
  fetchTrackRecord: Fn;
}) {
  const run = useServerFn(fetchTrackRecord as unknown as typeof getNbaTrackRecord);
  const { data, isLoading, isError } = useQuery({
    queryKey: [sport, "track-record"],
    queryFn: () => run(),
    staleTime: 10 * 60_000,
  });

  const label = sport.toUpperCase();
  const overall = data?.overall;
  const perSeason = data?.perSeason ?? [];
  const recent = data?.recent ?? [];
  const running = data?.running ?? [];

  return (
    <SportShell
      sport={sport}
      current="trackRecord"
      eyebrow={`Diamond Edge · ${label} Track Record`}
      title="Box Score"
      blurb="How the Elo model actually did — every completed game scored point-in-time, the same way the live slate is built. One model, no hindsight: the prediction for each game used only games before it."
      statBar={
        <StatBar>
          <Stat label="Games scored" value={overall?.n ? overall.n.toLocaleString() : "—"} />
          <Stat label="Win rate" value={pct(overall?.accuracy)} />
          <Stat label="Brier ↓" value={overall?.brier != null ? overall.brier.toFixed(4) : "—"} />
          <Stat
            label="Log loss ↓"
            value={overall?.logLoss != null ? overall.logLoss.toFixed(4) : "—"}
          />
        </StatBar>
      }
    >
      {isLoading && <div className="h-40 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load the {label} track record. The ESPN scoreboard may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !isError && overall && overall.n > 0 && (
        <>
          {running.length > 2 && (
            <section className="mb-10">
              <h2 className="mb-3 font-display text-3xl">Running win rate</h2>
              <Sparkline points={running} />
              <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Cumulative accuracy over {overall.n.toLocaleString()} games · settles toward{" "}
                {pct(overall.accuracy)}
              </p>
            </section>
          )}

          <section className="mb-10">
            <h2 className="mb-4 font-display text-3xl">By season</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse font-mono text-sm">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    <th className="py-2 pr-4">Season</th>
                    <th className="py-2 pr-4 text-right">Games</th>
                    <th className="py-2 pr-4 text-right">Win rate</th>
                    <th className="py-2 pr-4 text-right">Brier ↓</th>
                    <th className="py-2 text-right">Log loss ↓</th>
                  </tr>
                </thead>
                <tbody>
                  {perSeason.map((s) => (
                    <tr key={s.season} className="border-b border-border/60">
                      <td className="py-2 pr-4 text-foreground">{s.seasonLabel}</td>
                      <td className="py-2 pr-4 text-right text-muted-foreground">{s.n}</td>
                      <td className="py-2 pr-4 text-right text-foreground">{pct(s.accuracy)}</td>
                      <td className="py-2 pr-4 text-right text-muted-foreground">
                        {s.brier.toFixed(4)}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">
                        {s.logLoss.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="mb-4 font-display text-3xl">Recent games</h2>
            <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              {recent.map((g, i) => (
                <div
                  key={`${g.date}-${g.home}-${i}`}
                  className="flex items-center justify-between border-b border-border/60 py-1.5 font-mono text-sm"
                >
                  <span className="text-muted-foreground">
                    <span className="text-foreground">{g.away}</span> @{" "}
                    <span className="text-foreground">{g.home}</span>{" "}
                    <span className="text-muted-foreground">
                      {g.awayScore}–{g.homeScore}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {g.pickHome ? g.home : g.away} {Math.round(g.pickProb * 100)}%
                    </span>
                    <span className={g.correct ? "text-grass" : "text-clay"}>
                      {g.correct ? "✓" : "✗"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </SportShell>
  );
}

function Sparkline({ points }: { points: { i: number; accuracy: number }[] }) {
  const W = 720;
  const H = 120;
  const xs = points.map((p) => p.i);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const lo = 0.4;
  const hi = 0.75;
  const x = (i: number) => ((i - minX) / Math.max(1, maxX - minX)) * W;
  const y = (a: number) => H - ((Math.min(hi, Math.max(lo, a)) - lo) / (hi - lo)) * H;
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.accuracy).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-32 w-full min-w-[32rem]"
        preserveAspectRatio="none"
        role="img"
        aria-label="Running accuracy"
      >
        {/* 50% reference */}
        <line
          x1={0}
          x2={W}
          y1={y(0.5)}
          y2={y(0.5)}
          stroke="var(--color-border)"
          strokeDasharray="4 4"
        />
        <path d={d} fill="none" stroke="var(--color-primary)" strokeWidth={2} />
        <circle cx={x(last.i)} cy={y(last.accuracy)} r={3} fill="var(--color-primary)" />
      </svg>
    </div>
  );
}
