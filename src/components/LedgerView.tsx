import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { AppShell, StatBar, Stat, Note } from "@/components/AppShell";
import { getTrackLedger } from "@/lib/tracking.functions";
import type { DivisionSlug, SportKey } from "@/lib/nav";

/**
 * The Track Record page for soccer and tennis.
 *
 * The design rule this page follows, and the reason it looks the way it does:
 * the backtest number and the live number are never averaged, never blended and
 * never substituted for one another. The backtest is what the model CLAIMED on
 * seasons it never trained on. The ledger is what it has actually done since
 * predictions started being written down the morning of the match.
 *
 * The ledger begins empty and stays uninformative for months. A page that
 * quietly showed the backtest while it waited would be worse than no page, so
 * this one says how many calls it has, and says outright when that is too few.
 */

const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null | undefined, d = 4) => (x == null ? "—" : x.toFixed(d));

export function LedgerView({
  sport,
  division,
  title,
  eyebrow,
}: {
  sport: SportKey;
  division: DivisionSlug;
  title: string;
  eyebrow: string;
}) {
  const run = useServerFn(getTrackLedger);
  const { data, isLoading } = useQuery({
    queryKey: ["ledger", sport, division],
    queryFn: () => run({ data: { sport, division } }),
    staleTime: 5 * 60_000,
  });

  const s = data?.summary;
  const claim = data?.claim;
  const enough = (s?.n ?? 0) >= (data?.meaningfulN ?? 100);
  // The gap that matters: is the model doing what it said it would?
  const drift = s?.accuracy != null && claim ? s.accuracy - claim.accuracy : null;

  return (
    <AppShell
      sport={sport}
      view="trackRecord"
      league={division}
      eyebrow={eyebrow}
      title={title}
      blurb="Every prediction is written down the morning of the event and scored afterwards. Nothing here can be re-run: a backtest can be repeated until it looks good, a row from yesterday cannot."
      statBar={
        <StatBar>
          <Stat label="Calls settled" value={s ? s.n.toLocaleString() : "—"} />
          <Stat label="Live accuracy" value={enough ? pct(s?.accuracy) : "—"} />
          <Stat label="Backtest said" value={pct(claim?.accuracy)} />
          <Stat label="Awaiting result" value={s ? s.pending.toLocaleString() : "—"} />
        </StatBar>
      }
      footerNote="Live ledger · predictions recorded before the event, scored after"
    >
      {isLoading && <div className="h-40 animate-pulse border border-border bg-card" />}

      {!isLoading && (s?.n ?? 0) === 0 && (
        <Note>
          <strong className="text-foreground">Nothing settled yet.</strong> The ledger records
          predictions the morning of each event and scores them once the result is in, so it starts
          empty by design and fills at the rate the sport plays.
          {(s?.pending ?? 0) > 0 ? (
            <>
              {" "}
              {s!.pending} {s!.pending === 1 ? "prediction is" : "predictions are"} recorded and
              waiting on a result.
            </>
          ) : (
            <> Nothing has been recorded yet — the first run happens on the next daily cycle.</>
          )}{" "}
          The backtest figures below are what to expect, not what has happened.
        </Note>
      )}

      {!isLoading && (s?.n ?? 0) > 0 && !enough && (
        <Note>
          <strong className="text-foreground">Too early to read anything into this.</strong> {s!.n}{" "}
          settled {s!.n === 1 ? "call" : "calls"} is well short of the {data!.meaningfulN} it takes
          for a hit rate to separate a good model from a lucky fortnight. The number is shown
          because hiding it would be worse, not because it means much yet.
        </Note>
      )}

      {/* Claimed vs actual, side by side and never merged. */}
      <section className="mb-8 border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-2xl">Claimed against actual</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Left: the held-out backtest, on seasons the model never trained on. Right: what the live
            ledger has recorded. They answer different questions and are never averaged.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse font-mono text-[11px]">
            <thead>
              <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                <th className="px-5 py-3 font-normal">Metric</th>
                <th className="px-3 py-3 text-right font-normal">Backtest</th>
                <th className="px-3 py-3 text-right font-normal">Live ledger</th>
                <th className="px-5 py-3 text-right font-normal">Sample</th>
              </tr>
            </thead>
            <tbody>
              <Row
                label="Accuracy"
                claimed={pct(claim?.accuracy)}
                live={enough ? pct(s?.accuracy) : "—"}
                sample={`${claim?.n?.toLocaleString() ?? "—"} / ${s?.n ?? 0}`}
              />
              <Row
                label="Brier"
                claimed={num(claim?.brier)}
                live={enough ? num(s?.brier) : "—"}
                sample=""
              />
              <Row
                label="Log loss"
                claimed={num(claim?.logLoss)}
                live={enough ? num(s?.logLoss) : "—"}
                sample=""
              />
              {claim?.rps != null && (
                <Row
                  label="RPS"
                  claimed={num(claim.rps)}
                  live={enough ? num(s?.rps) : "—"}
                  sample=""
                />
              )}
            </tbody>
          </table>
        </div>
        {enough && drift != null && (
          <div className="border-t border-border px-5 py-4 font-mono text-[11px] text-muted-foreground">
            Live accuracy is running{" "}
            <span className={drift >= 0 ? "text-emerald-600" : "text-clay"}>
              {drift >= 0 ? "+" : ""}
              {(drift * 100).toFixed(1)} points
            </span>{" "}
            against the backtest.{" "}
            {Math.abs(drift) < 0.03
              ? "That is within the range a few hundred matches can produce by chance."
              : "That is a wide enough gap to be worth watching, though not yet to act on."}
          </div>
        )}
      </section>

      {/* Calibration: the check a hit rate cannot make. */}
      {(data?.calibration.length ?? 0) > 0 && (
        <section className="mb-8 border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-display text-2xl">Is 70% actually 70%?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Accuracy alone cannot catch a model that is confident at the wrong times. These are
              the live picks grouped by how sure the model was, against how often they landed.
            </p>
          </div>
          <div className="px-5 py-4">
            {data!.calibration.map((b) => (
              <div
                key={b.band}
                className="flex items-center gap-3 border-b border-border/50 py-2.5"
              >
                <div className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-widest text-foreground">
                  {b.band}
                </div>
                <div className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">
                  n={b.n}
                </div>
                <div className="relative h-3 min-w-0 flex-1 bg-secondary">
                  <div className="h-full bg-primary/40" style={{ width: `${b.actual * 100}%` }} />
                  <div
                    className="absolute top-0 h-3 w-0.5 bg-foreground"
                    style={{ left: `${b.predicted * 100}%` }}
                    title={`said ${(b.predicted * 100).toFixed(0)}%`}
                  />
                </div>
                <div className="w-32 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  said {(b.predicted * 100).toFixed(0)}% · hit{" "}
                  <span className="text-foreground">{(b.actual * 100).toFixed(0)}%</span>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border px-5 py-3 font-mono text-[11px] text-muted-foreground">
            The bar is what happened; the tick is what the model said. A well-calibrated model puts
            them on top of each other. Bands with only a handful of calls will scatter regardless.
          </div>
        </section>
      )}

      {/* The raw ledger. */}
      {(data?.recent.length ?? 0) > 0 && (
        <section className="border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-display text-2xl">The last {data!.recent.length} calls</h2>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {s?.firstDate} → {s?.lastDate} · model {data!.modelVersion}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse font-mono text-[11px]">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                  <th className="px-5 py-3 font-normal">Date</th>
                  <th className="px-3 py-3 font-normal">Event</th>
                  <th className="px-3 py-3 text-right font-normal">Called</th>
                  <th className="px-3 py-3 text-right font-normal">Said</th>
                  <th className="px-5 py-3 text-right font-normal">Result</th>
                </tr>
              </thead>
              <tbody>
                {data!.recent.map((r) => {
                  const picked =
                    r.pick === "a" ? r.subject_a : r.pick === "b" ? r.subject_b : "Draw";
                  return (
                    <tr
                      key={`${r.event_id}-${r.model_version}`}
                      className="border-b border-border/50"
                    >
                      <td className="px-5 py-2.5 text-muted-foreground">{r.event_date}</td>
                      <td className="px-3 py-2.5 text-foreground">
                        {r.subject_a} v {r.subject_b}
                      </td>
                      <td className="px-3 py-2.5 text-right text-foreground">{picked}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground">
                        {(Number(r.pick_prob) * 100).toFixed(0)}%
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <span className={r.correct ? "text-emerald-600" : "text-red-500"}>
                          {r.correct ? "✓" : "✗"}
                        </span>
                        {r.final_score && (
                          <span className="ml-2 text-muted-foreground">{r.final_score}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </AppShell>
  );
}

function Row({
  label,
  claimed,
  live,
  sample,
}: {
  label: string;
  claimed: string;
  live: string;
  sample: string;
}) {
  return (
    <tr className="border-b border-border/60">
      <td className="px-5 py-3 font-display text-base text-foreground">{label}</td>
      <td className="px-3 py-3 text-right text-muted-foreground">{claimed}</td>
      <td className="px-3 py-3 text-right text-foreground">{live}</td>
      <td className="px-5 py-3 text-right text-muted-foreground">{sample}</td>
    </tr>
  );
}
