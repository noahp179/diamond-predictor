import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { getMetrics } from "@/lib/mlb.functions";

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
  const { data, isLoading } = useQuery({ queryKey: ["metrics"], queryFn: () => fetchMetrics() });

  const daily = (data?.daily ?? []).map((d: any) => ({
    date: d.metric_date,
    accuracy: d.accuracy != null ? Number(d.accuracy) * 100 : null,
    brier: d.brier != null ? Number(d.brier) : null,
    settled: d.settled,
  }));

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Track Record · {data?.modelVersion ?? "baseline"}
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">Box Score</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Every prediction we've made, scored against the final box. Brier &amp; log-loss are
              proper scoring rules — lower is better.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/model-v2"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Model V2 ✦
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
            <Stat label="Settled" value={`${data?.settled ?? 0}`} />
            <Stat label="Accuracy" value={pct(data?.accuracy)} />
            <Stat label="Brier" value={data?.brier != null ? data.brier.toFixed(3) : "—"} />
            <Stat label="Log loss" value={data?.logLoss != null ? data.logLoss.toFixed(3) : "—"} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        {isLoading && <div className="h-72 animate-pulse border border-border bg-card" />}
        {!isLoading && daily.length === 0 && (
          <div className="border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No settled games yet</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              The pipeline scores predictions as games go final. Check back tomorrow.
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