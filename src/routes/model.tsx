import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { getMetrics } from "@/lib/mlb.functions";
import { PARK_FACTORS } from "@/lib/park-factors";

export const Route = createFileRoute("/model")({
  head: () => ({
    meta: [
      { title: "Model Card — Diamond Edge" },
      { name: "description", content: "How Diamond Edge predicts MLB games: data sources, features, scoring, and park factors." },
    ],
  }),
  component: ModelPage,
});

function ModelPage() {
  const fetchMetrics = useServerFn(getMetrics);
  const { data } = useQuery({ queryKey: ["metrics"], queryFn: () => fetchMetrics() });

  const parks = Object.entries(PARK_FACTORS).sort((a, b) => b[1] - a[1]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Model Card · {data?.modelVersion ?? "baseline"}
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">The Math</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Diamond Edge is intentionally simple and fully transparent. Every prediction
              ships with the exact log-odds adjustments that produced it.
            </p>
          </div>
          <Link to="/" className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest hover:border-primary">
            ← Today's slate
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <Section title="Data sources">
          <ul className="space-y-2 font-mono text-sm">
            <li><span className="text-primary">·</span> MLB Stats API — schedule, teams, probable pitchers, live scores, final box.</li>
            <li><span className="text-primary">·</span> MLB Stats API — season standings (W-L, win%) and pitcher season ERA.</li>
            <li><span className="text-primary">·</span> Static park-factor table (community-sourced averages) for venue effects.</li>
          </ul>
        </Section>

        <Section title="Features &amp; log-odds construction">
          <ol className="space-y-3 text-sm leading-relaxed">
            <li>
              <span className="font-mono text-primary">1.</span> Composite <span className="text-foreground">team strength</span>: 40% Pythagorean
              expectation (RS<sup>1.83</sup> / (RS<sup>1.83</sup>+RA<sup>1.83</sup>)), 30% season W%,
              20% last-10 form, 10% home/away split record. Converted to log-odds and differenced.
            </li>
            <li>
              <span className="font-mono text-primary">2.</span> <span className="text-foreground">Run-differential per game</span> gap,
              weighted by <code className="font-mono text-primary">×0.12</code>. Captures dominance not visible in W%.
            </li>
            <li>
              <span className="font-mono text-primary">3.</span> Fixed <span className="text-foreground">home-field edge</span> of <code className="font-mono text-primary">+0.18</code> log-odds (~MLB 54%).
            </li>
            <li>
              <span className="font-mono text-primary">4.</span> <span className="text-foreground">Starting pitcher ERA</span> gap regressed to league 4.20,
              weighted by <code className="font-mono text-primary">×0.16</code>.
            </li>
            <li>
              <span className="font-mono text-primary">5.</span> <span className="text-foreground">Park factor</span> as a logit multiplier
              (<code className="font-mono text-primary">×(1 + (pf − 100)/200)</code>).
            </li>
            <li>
              <span className="font-mono text-primary">6.</span> Sigmoid → probability, hard-clamped to <code className="font-mono text-primary">[0.10, 0.90]</code>.
            </li>
          </ol>
        </Section>

        <Section title="Scoring rules">
          <div className="grid gap-4 md:grid-cols-3">
            <Metric label="Accuracy" value={data?.accuracy != null ? `${(data.accuracy * 100).toFixed(1)}%` : "—"} hint="P(home) ≥ 0.5 ↔ pick home" />
            <Metric label="Brier" value={data?.brier != null ? data.brier.toFixed(3) : "—"} hint="mean (p − y)², lower is better" />
            <Metric label="Log loss" value={data?.logLoss != null ? data.logLoss.toFixed(3) : "—"} hint="−[y·ln p + (1−y)·ln(1−p)]" />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Predictions are <span className="text-foreground">frozen at first publish</span> — scores only update once
            MLB marks the game Final. In-progress games are never settled.
          </p>
        </Section>

        <Section title={`Park factors (${parks.length} venues)`}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs md:grid-cols-3">
            {parks.map(([name, pf]) => (
              <div key={name} className="flex justify-between border-b border-border/40 py-1">
                <span className="truncate pr-2 text-muted-foreground">{name}</span>
                <span className={pf > 100 ? "text-signal" : pf < 100 ? "text-chalk" : "text-foreground"}>
                  {pf}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            100 = league average. &gt;100 favors hitters; &lt;100 favors pitchers.
          </p>
        </Section>

        <Section title="Pipeline">
          <pre className="overflow-auto bg-secondary/40 p-4 font-mono text-xs leading-relaxed text-foreground">
{`schedule → standings + pitcher ERA → predict()
   ↓                                       ↓
games table  ←──────  predictions table (frozen at publish)
                          ↓
               settleFinished()  (only when MLB status = Final)
                          ↓
                  recomputeDailyMetrics()`}
          </pre>
        </Section>

        <Section title="Honest limitations">
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>· No bullpen ERA, lineup handedness, injury, or travel/rest features yet.</li>
            <li>· Coefficients are hand-tuned, not fit by gradient descent on backtests.</li>
            <li>· Weather (wind, temp) is not incorporated.</li>
            <li>· Park factors are static priors, not season-adjusted.</li>
          </ul>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-border bg-card">
      <div className="border-b border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border border-border bg-secondary/30 p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-3xl">{value}</div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{hint}</div>
    </div>
  );
}