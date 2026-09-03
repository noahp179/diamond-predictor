import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { AppShell, StatBar, Stat, Note } from "@/components/AppShell";
import {
  AccuracyTrend,
  BucketAccuracy,
  CalibrationChart,
  ChartCard,
  EmptyChart,
  VolumeChart,
} from "@/components/LedgerCharts";
import { getReplayedHistory, getTrackLedger } from "@/lib/tracking.functions";
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
 *
 * THE THIRD THING ON THIS PAGE
 * ----------------------------
 * Because the ledger starts empty, for months the charts had nothing to draw
 * and the page was a row of "nothing to plot yet" boxes. That is honest but
 * useless: a reader learns nothing about whether the model works.
 *
 * So the page also shows a REPLAY — the model re-run over the last year of
 * completed matches, each priced with only what was known before it. That is a
 * backtest, and it lives in its own clearly-headed section below the live one,
 * with its own charts. It is never merged into the live numbers, never fills in
 * for them, and the stat bar at the top still reports the live ledger only.
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

  // Fetched separately so the slow half cannot hold up the fast half: the
  // ledger is one indexed query, the replay walks a year of results.
  const runReplay = useServerFn(getReplayedHistory);
  const { data: replay, isLoading: replayLoading } = useQuery({
    queryKey: ["replay", sport, division],
    queryFn: () => runReplay({ data: { sport, division } }),
    staleTime: 30 * 60_000,
  });
  /**
   * The replayed section has two possible sources and prefers the stored one.
   *
   * Once scripts/backfill-ledger.ts has run, the reconstruction lives in the
   * database as rows marked provenance='reconstructed', and reading them is
   * both faster and the thing the page should show — it is the same arithmetic
   * either way, but the stored version is auditable row by row. Until then the
   * page computes the replay live so it is not blank.
   */
  const stored = data?.reconstructed;
  const useStored = (stored?.summary.n ?? 0) > 0;
  const shown = useStored
    ? {
        summary: stored!.summary,
        calibration: stored!.calibration,
        running: stored!.running,
        daily: stored!.daily,
      }
    : replay;
  const r = shown?.summary;

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

      {/* An empty ledger has three quite different causes and they must not be
          reported with the same sentence. This page previously said "the first
          run happens on the next daily cycle" while the table it reads from did
          not exist, so it promised, every day for weeks, data that nothing was
          ever going to write. */}
      {!isLoading && data?.status === "not-provisioned" && (
        <Note>
          <strong className="text-foreground">The ledger is not recording.</strong> Its table does
          not exist in the database, so no prediction has ever been stored for {sport} and none will
          be until the migration{" "}
          <code className="font-mono text-[11px]">
            supabase/migrations/20260815120000_event_predictions.sql
          </code>{" "}
          is applied. This is a setup step, not something that resolves by waiting — which is what
          this page used to imply. The replayed section below is real and is not affected.
        </Note>
      )}

      {!isLoading && data?.status === "unreadable" && (
        <Note>
          <strong className="text-foreground">The ledger could not be read.</strong> The table
          exists but the request for it failed, so this section is blank for a reason that has
          nothing to do with the model. The replayed section below is unaffected.
        </Note>
      )}

      {!isLoading && data?.status === "ok" && (s?.n ?? 0) === 0 && (
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

      {/* Everything in this block is drawn from event_predictions — rows
          written the morning of an event and scored afterwards. The backtest
          appears only as a dashed reference line, never as a plotted series.

          With an empty ledger these were three stacked "nothing to plot yet"
          boxes, which is honest but says the same thing three times. One line
          says it once, and the replay below actually has something to show. */}
      {!isLoading && data?.status === "ok" && (s?.n ?? 0) === 0 && (
        <p className="mb-8 border border-dashed border-border px-5 py-4 text-sm text-muted-foreground">
          The live charts — hit rate as calls settle, calibration by confidence, and volume per day
          — appear here once the ledger has settled its first call.
        </p>
      )}

      {(s?.n ?? 0) > 0 && (
        <>
          <ChartCard
            title="Has it done what it said it would?"
            subtitle="The live hit rate as calls settle, against the backtest it was sold on. Early points swing hard because the denominator is tiny; the line is meant to steady toward the dashes, or visibly not."
            footer="Cumulative, not per-day — one matchday is far too small to read. Every point is every call settled up to that moment."
          >
            {(data?.running.length ?? 0) > 0 ? (
              <AccuracyTrend
                running={data!.running}
                claim={claim?.accuracy ?? null}
                meaningfulN={data!.meaningfulN}
              />
            ) : (
              <EmptyChart>
                Nothing has settled yet, so there is no line to draw. The first point appears once a
                recorded prediction has a result.
              </EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="Is 70% actually 70%?"
            subtitle="Every settled call bucketed by how confident the model was, next to how often that bucket actually landed. Matching heights mean the number on the card can be taken at face value."
            footer="A shorter blue bar than orange means the model was under-confident in that bucket; taller means it was over-confident, which is the expensive direction. Buckets with only a handful of calls will disagree wildly no matter how good the model is — the count is in the tooltip."
          >
            {(data?.calibration.length ?? 0) > 0 ? (
              <CalibrationChart calibration={data!.calibration} />
            ) : (
              <EmptyChart>
                Calibration needs settled calls spread across confidence bands. Nothing to plot yet.
              </EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="How fast is this filling up?"
            subtitle="Calls settled per day, with that day's hit rate riding on top. The bars are the honest context for every other number on this page."
            footer="A single day is almost never a meaningful sample, which is why the daily rate is drawn thin and the volume is drawn solid."
          >
            {(data?.daily.length ?? 0) > 0 ? (
              <VolumeChart daily={data!.daily} />
            ) : (
              <EmptyChart>
                The ledger records predictions once a day and scores them once the results are in.
                Nothing has settled yet.
              </EmptyChart>
            )}
          </ChartCard>
        </>
      )}

      {/* ------------------------------------------------------------------
          The replay. Everything below this divider is a BACKTEST — the model
          re-run over matches that have already been played, each scored with
          the ratings as they stood before it. It is separated by a full-width
          heading rather than a subtitle because the distinction is the entire
          point, and a subtitle is something a reader can skim past.
          ------------------------------------------------------------------ */}
      <section className="mb-8 mt-14 border-t-2 border-foreground pt-6">
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Below this line: replay, not live
        </p>
        <h2 className="mt-2 font-display text-3xl">Replayed over the last year of results</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          The same model, re-run over completed matches, each one priced using only the ratings that
          existed before it was played. That makes it a{" "}
          <strong className="text-foreground">backtest</strong> — the sample is large and it is
          available immediately, but it was produced after the fact, so it cannot prove the model
          was not tuned to the period it covers. The live ledger above can. Both are here because
          each answers a question the other cannot.
        </p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {useStored
            ? `Source: stored rows · provenance = reconstructed${
                r?.firstDate ? ` · ${r.firstDate} → ${r.lastDate}` : ""
              }`
            : "Source: computed live · not yet backfilled into the ledger"}
        </p>
        {!useStored && replayLoading && (
          <div className="mt-5 h-24 animate-pulse border border-border bg-card" />
        )}
        {r && r.n > 0 && (
          <StatBar>
            <Stat label="Matches replayed" value={r.n.toLocaleString()} />
            <Stat label="Replay accuracy" value={pct(r.accuracy)} />
            <Stat label="Brier ↓" value={num(r.brier)} />
            <Stat label="Log loss ↓" value={num(r.logLoss)} />
          </StatBar>
        )}
        {!replayLoading && !useStored && (r?.n ?? 0) === 0 && (
          <Note>
            The replay could not be built — the results feed was unreachable, or the league has not
            played inside the window. Nothing is being hidden; there is simply nothing to score.
          </Note>
        )}
      </section>

      {(r?.n ?? 0) > 0 && (
        <>
          <ChartCard
            title="Accuracy by confidence"
            subtitle="Every replayed call sorted into a confidence bucket: the bars are how many calls landed in each, the solid line is how often those calls were right, the dotted line is what the model claimed for them."
            footer="Read the bars first. A bucket the solid line drops out of is only interesting if the bar under it is tall — with thirty calls a ten-point gap is noise, with three thousand it is a finding. The rightmost buckets are usually the thinnest, because a model that is 90% sure is not 90% sure very often."
          >
            <BucketAccuracy calibration={shown!.calibration} />
          </ChartCard>

          <ChartCard
            title="Is 70% actually 70%, over the full replay?"
            subtitle="The same buckets as a direct comparison — what the model said against what happened. Matching heights mean the percentage on a prediction card can be taken at face value."
            footer="Taller orange than blue means the model was under-confident in that bucket; the other way round means over-confident, which is the expensive direction. Call counts are in the tooltip."
          >
            <CalibrationChart calibration={shown!.calibration} />
          </ChartCard>

          <ChartCard
            title="How the replay accumulated"
            subtitle="Cumulative hit rate across the replayed year, against the held-out backtest the model was shipped on. This line is drawn over thousands of matches, so unlike the live one above it is past the point where a good week could move it."
            footer="Left to right is chronological. A line that drifts away from the dashes late is a model that has aged — the sport moved and the ratings did not follow."
          >
            <AccuracyTrend
              running={shown!.running}
              claim={claim?.accuracy ?? null}
              meaningfulN={0}
              seriesName="replayed hit rate"
            />
          </ChartCard>

          <ChartCard
            title="Replayed volume by month"
            subtitle="How many matches the replay scored each month, with that month's hit rate on top — the shape of the sport's calendar, and whether the model held up across all of it."
            footer="Grouped by month rather than by day: a year has well over a hundred matchdays, and at that density the accuracy line is a sawtooth between 0% and 100% that hides the volume underneath it. A month is a sample; a matchday usually is not."
          >
            <VolumeChart daily={shown!.daily} by="month" />
          </ChartCard>
        </>
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
