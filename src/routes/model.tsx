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
              ships with the exact percentage-point swing each factor contributed.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/model-v2"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Model V2 ✦
            </Link>
            <Link to="/" className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest hover:border-primary">
              ← Today's slate
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <Section title="Data sources">
          <ul className="space-y-2 font-mono text-sm">
            <li><span className="text-primary">·</span> MLB Stats API — schedule, teams, probable pitchers, live scores, final box.</li>
            <li><span className="text-primary">·</span> MLB Stats API — standings (W-L, win%, L10, splits, RS/RA) and pitcher season ERA.</li>
            <li><span className="text-primary">·</span> MLB Stats API — team season hitting (OPS) and pitching (full-staff ERA/WHIP).</li>
            <li><span className="text-primary">·</span> MLB Stats API — prior 5 days of finals to compute per-team rest days.</li>
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
              <span className="font-mono text-primary">4.</span> <span className="text-foreground">Starting pitcher ERA</span>, Bayesian-shrunk toward the league
              4.20 with a 30-IP prior so small April samples don't dominate, then differenced and weighted by
              <code className="font-mono text-primary"> ×0.20</code> (≈ 5pp win-prob per 1.00 ERA gap, in line with public
              starter-value research). Half weight when only one starter is announced.
            </li>
            <li>
              <span className="font-mono text-primary">5.</span> <span className="text-foreground">Full-staff team ERA</span> gap
              (bullpen + rotation depth proxy, distinct from named starter),
              weighted by <code className="font-mono text-primary">×0.10</code>.
            </li>
            <li>
              <span className="font-mono text-primary">6.</span> <span className="text-foreground">Team OPS</span> gap (offense quality),
              weighted by <code className="font-mono text-primary">×2.5</code>. A .060 OPS edge ≈ 0.15 logit.
            </li>
            <li>
              <span className="font-mono text-primary">7.</span> <span className="text-foreground">Rest-days</span> advantage,
              <code className="font-mono text-primary">±0.04</code> logit/day, capped at ±2 days.
            </li>
            <li>
              <span className="font-mono text-primary">8.</span> <span className="text-foreground">Park factor</span> as a logit multiplier
              (<code className="font-mono text-primary">×(1 + (pf − 100)/200)</code>).
            </li>
            <li>
              <span className="font-mono text-primary">9.</span> <span className="text-foreground">Calibration shrink</span> ×0.92 toward
              0 logit — hand-tuned models tend to overshoot; mild shrinkage improves Brier / log-loss.
            </li>
            <li>
              <span className="font-mono text-primary">10.</span> Sigmoid → probability, hard-clamped to <code className="font-mono text-primary">[0.15, 0.85]</code>.
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
            <li>· Coefficients are hand-tuned, not fit by gradient descent on backtests.</li>
            <li>· No lineup handedness, injury, travel distance, or weather (wind, temp) features.</li>
            <li>· Bullpen signal is staff-wide ERA, not leverage-weighted relief ERA.</li>
            <li>· Park factors are static priors, not season-adjusted.</li>
            <li>· No betting-market or Elo prior is blended in (would likely improve calibration further).</li>
            <li>· Rationale "pp" values are the marginal win-prob swing at the point each factor was applied; order matters because the sigmoid is non-linear.</li>
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