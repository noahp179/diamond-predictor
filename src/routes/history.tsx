import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { getMetrics, getSettledPredictions } from "@/lib/mlb.functions";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Track Record — Diamond Edge" },
      { name: "description", content: "Historical accuracy, Brier score, and log loss for every MLB prediction." },
    ],
  }),
  component: HistoryPage,
});

function pct(n: number | null | undefined) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function HistoryPage() {
  const fetchMetrics = useServerFn(getMetrics);
  const fetchSettled = useServerFn(getSettledPredictions);
  const { data: metricsData, isLoading: metricsLoading } = useQuery({ queryKey: ["metrics"], queryFn: () => fetchMetrics() });
  const { data: settledData, isLoading: settledLoading } = useQuery({
    queryKey: ["settled-predictions"],
    queryFn: () => fetchSettled(),
    staleTime: 5 * 60_000,
  });

  const daily = (metricsData?.daily ?? []).map((d: any) => ({
    date: d.metric_date,
    accuracy: d.accuracy != null ? Number(d.accuracy) * 100 : null,
    brier: d.brier != null ? Number(d.brier) : null,
    settled: d.settled,
  }));

  const settledGames = (settledData?.predictions ?? []).map((p: any) => {
    const g = p.games as any;
    const predictedWinner = Number(p.home_win_prob) >= 0.5 ? g?.home_team_abbr : g?.away_team_abbr;
    const predictedProb = Number(p.home_win_prob) >= 0.5 ? Number(p.home_win_prob) : 1 - Number(p.home_win_prob);
    return {
      gameId: p.game_id,
      date: g?.game_date ?? "—",
      home: g?.home_team_abbr ?? "—",
      away: g?.away_team_abbr ?? "—",
      homeScore: g?.home_score,
      awayScore: g?.away_score,
      predictedWinner: predictedWinner ?? "—",
      predictedProb,
      winner: g?.winner,
      correct: p.correct,
      brier: p.brier != null ? Number(p.brier).toFixed(3) : "—",
      logLoss: p.log_loss != null ? Number(p.log_loss).toFixed(3) : "—",
    };
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Track Record · {metricsData?.modelVersion ?? "baseline"}
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">Box Score</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Every prediction we've made, scored against the final box. Brier &amp; log-loss are
              proper scoring rules — lower is better.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/model"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Recommended
            </Link>
            <Link
              to="/"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              ← Today's slate
            </Link>
          </div>
        </div>
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-border md:grid-cols-4">
            <Stat label="Settled" value={`${metricsData?.settled ?? 0}`} />
            <Stat label="Accuracy" value={pct(metricsData?.accuracy)} />
            <Stat label="Brier" value={metricsData?.brier != null ? metricsData.brier.toFixed(3) : "—"} />
            <Stat label="Log loss" value={metricsData?.logLoss != null ? metricsData.logLoss.toFixed(3) : "—"} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        {/* Recent settled predictions table */}
        {settledLoading ? (
          <div className="h-48 animate-pulse border border-border bg-card" />
        ) : settledGames.length > 0 ? (
          <section className="border border-border bg-card">
            <div className="border-b border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Settled Predictions ({settledGames.length} games)
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Matchup</th>
                    <th className="px-4 py-2.5 font-medium">Predicted</th>
                    <th className="px-4 py-2.5 font-medium">Final Score</th>
                    <th className="px-4 py-2.5 font-medium">Result</th>
                    <th className="px-4 py-2.5 font-medium text-right">Brier</th>
                  </tr>
                </thead>
                <tbody>
                  {settledGames.map((g: any) => (
                    <tr key={g.gameId} className="border-b border-border/20 hover:bg-secondary/10">
                      <td className="whitespace-nowrap px-4 py-3 font-mono_Configural">
                        <span className="font-mono text-xs text-muted-foreground">{g.date}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="font-display">{g.away} @ {g.home}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="font-display">{g.predictedWinner}</span>
                        <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                          {(g.predictedProb * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                        {g.homeScore != null && g.awayScore != null
                          ? `${g.awayScore}–${g.homeScore}`
                          : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={`inline-block rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
                            g.correct
                              ? "bg-emerald-500/10 text-emerald-600"
                              : "bg-red-500/10 text-red-500"
                          }`}
                        >
                          {g.correct ? "✓ Correct" : "✗ Miss"}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                        {g.brier}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className="border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No settled games yet</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              The pipeline scores predictions as games go final. Check back tomorrow.
            </p>
          </div>
        )}

        {/* Charts */}
        {metricsLoading && <div className="h-72 animate-pulse border border-border bg-card" />}
        {!metricsLoading && daily.length === 0 && (
          <div className="border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No daily metrics yet</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              Once predictions settle, daily accuracy and Brier charts will appear here.
            </p>
          </div>
        )}
        {daily.length > 0 && (
          <>
            <ChartCard title="Daily accuracy">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={daily}>
                  <defs>
                    <linearGradient id="accFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-signal)" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="var(--color-signal)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={11} />
                  <YAxis domain={[0, 100]} stroke="var(--color-muted-foreground)" fontSize={11} unit="%" />
                  <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }} />
                  <Area type="monotone" dataKey="accuracy" stroke="var(--color-signal)" fill="url(#accFill)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Daily Brier score (lower is better)">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={daily}>
                  <defs>
                    <linearGradient id="brierFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-chalk)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--color-chalk)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={11} />
                  <YAxis stroke="var(--color-muted-foreground)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }} />
                  <Area type="monotone" dataKey="brier" stroke="var(--color-chalk)" fill="url(#brierFill)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl text-foreground">{value}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-border bg-card">
      <div className="border-b border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
