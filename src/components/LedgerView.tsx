import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { AppShell, StatBar, Stat, Note } from "@/components/AppShell";
import { CalibrationTable } from "@/components/CalibrationTable";
import { AccuracyTrend, ChartCard, EmptyChart, ResultsOverTime } from "@/components/LedgerCharts";
import { RecordHeadline } from "@/components/RecordHeadline";
import { TdTrackRecord } from "@/components/TdTrackRecord";
import { getTrackLedger } from "@/lib/tracking.functions";
import type { DivisionSlug, SportKey } from "@/lib/nav";

/**
 * The Track Record page for every sport tracked in `event_predictions`.
 *
 * ONE RULE: every series on this page is a result that was recorded before the
 * event and scored after it. Nothing here is replayed, reconstructed, or
 * computed from a match whose outcome was already known.
 *
 * The page used to carry a second section that replayed the last year of
 * completed matches. The arithmetic was sound — each match priced before its
 * result was folded in — but it was still a backtest, and a backtest on a page
 * titled Track Record invites exactly the reading it should prevent. It is
 * gone. The held-out backtest survives in one place only: a single labelled row
 * in the table below, and a dashed reference line the live curve is measured
 * against. Neither is ever plotted as data.
 *
 * The consequence is that a new sport's page is empty until the cron has run
 * and events have finished. That is the correct thing for it to show, and it
 * says so plainly rather than filling the space with something repeatable.
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
  /** Soccer's league or tennis's tour. NFL and NBA have none. */
  division?: DivisionSlug;
  title: string;
  eyebrow: string;
}) {
  const run = useServerFn(getTrackLedger);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["ledger", sport, division ?? sport],
    queryFn: () => run({ data: { sport, division: division ?? sport } }),
    staleTime: 5 * 60_000,
  });

  const s = data?.summary;
  const claim = data?.claim;
  const enough = (s?.n ?? 0) >= (data?.meaningfulN ?? 100);
  // The gap that matters: is the model doing what it said it would?
  const drift = s?.accuracy != null && claim ? s.accuracy - claim.accuracy : null;
  const unit = sport === "soccer" || sport === "tennis" ? "matches" : "games";
  // What the model said, on average, about the side it picked — the number its
  // hit rate should land on if its percentages mean what they say.
  const cal = data?.calibration ?? [];
  const calN = cal.reduce((a, c) => a + c.n, 0);
  const expected = calN ? cal.reduce((a, c) => a + c.n * c.predicted, 0) / calN : null;
  // A pick with no skill in it: a coin flip, or one of three for soccer's
  // home/draw/away.
  const chance =
    sport === "soccer" ? { y: 1 / 3, label: "picking at random" } : { y: 0.5, label: "coin flip" };

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
          <Stat label={`${unit} finished`} value={s ? s.n.toLocaleString() : "—"} />
          <Stat label="Picked the winner" value={s?.n ? pct(s.accuracy) : "—"} />
          {claim ? (
            <Stat label="Tested on past seasons" value={pct(claim.accuracy)} />
          ) : (
            <Stat label="It said it would be right" value={pct(expected)} />
          )}
          <Stat label="Waiting on results" value={s ? s.pending.toLocaleString() : "—"} />
        </StatBar>
      }
      footerNote="Live ledger · predictions recorded before the event, scored after"
    >
      {isLoading && <div className="h-40 animate-pulse border border-border bg-card" />}

      {/* Without this the page rendered NOTHING when the query failed: every
          section below is conditional on `data`, so an error produced a blank
          frame with a stat bar of dashes and no explanation. A page whose whole
          job is honest reporting must not fail silently.

          It covers `!data` and not just `isError` because a query can settle
          into neither state — pending but not fetching — and that produced the
          same blank frame. Anything other than "we have the data" gets a
          sentence. */}
      {!isLoading && (isError || !data) && (
        <Note>
          <strong className="text-foreground">This page could not load its data.</strong> The
          request for the ledger did not return, so nothing below is missing because of the model —
          it is missing because the read did not complete.
          {error instanceof Error && error.message ? (
            <>
              {" "}
              <span className="font-mono text-[11px]">{error.message}</span>
            </>
          ) : null}
        </Note>
      )}

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
          this page used to imply.
        </Note>
      )}

      {!isLoading && data?.status === "unreadable" && (
        <Note>
          <strong className="text-foreground">The ledger could not be read.</strong> The table
          exists but the request for it failed, so this page is blank for a reason that has nothing
          to do with the model.
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
          The backtest figure below is what to expect, not what has happened — it is shown as a
          benchmark to measure against, never as a stand-in.
        </Note>
      )}

      {/* The answer first, in words: how often it picked right, what it said
          it would do, and the verdict. */}
      {(s?.n ?? 0) > 0 && (
        <section className="mb-8 border border-border bg-card">
          <div className="border-b border-border px-5 py-4 sm:px-6">
            <h2 className="font-display text-2xl">How often it picked the winner</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Every pick below was written down before the {unit === "games" ? "game" : "match"} and
              checked after it.
            </p>
          </div>
          <RecordHeadline
            hits={s!.correct}
            n={s!.n}
            unit={unit}
            verb="picked right"
            expected={expected}
            compare={[
              ...(claim ? [["Tested on past seasons", claim.accuracy] as [string, number]] : []),
              [chance.label[0].toUpperCase() + chance.label.slice(1), chance.y],
            ]}
            footnote={s?.firstDate && s?.lastDate ? `${s.firstDate} to ${s.lastDate}` : undefined}
          />
          {claim && (
            <details className="group border-t border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground sm:px-6">
                The scoring rules statisticians use
                <span className="group-open:rotate-180">▼</span>
              </summary>
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[560px] border-collapse font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                      <th className="px-5 py-3 font-normal">Measure</th>
                      <th className="px-3 py-3 text-right font-normal">Past seasons</th>
                      <th className="px-3 py-3 text-right font-normal">Live</th>
                      <th className="px-5 py-3 font-normal">What it means</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Row
                      label="Picked the winner"
                      claimed={pct(claim.accuracy)}
                      live={enough ? pct(s?.accuracy) : "—"}
                      note="higher is better"
                    />
                    <Row
                      label="Brier score"
                      claimed={num(claim.brier)}
                      live={enough ? num(s?.brier) : "—"}
                      note="lower is better · punishes confident misses"
                    />
                    <Row
                      label="Log loss"
                      claimed={num(claim.logLoss)}
                      live={enough ? num(s?.logLoss) : "—"}
                      note="lower is better · punishes very confident misses hardest"
                    />
                    {claim.rps != null && (
                      <Row
                        label="RPS"
                        claimed={num(claim.rps)}
                        live={enough ? num(s?.rps) : "—"}
                        note="lower is better · credits a near-miss (a draw for a home pick)"
                      />
                    )}
                  </tbody>
                </table>
              </div>
              {enough && drift != null && (
                <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground sm:px-6">
                  Live it is picking the winner{" "}
                  <span className={drift >= 0 ? "text-emerald-600" : "text-red-500"}>
                    {Math.abs(drift * 100).toFixed(1)} points {drift >= 0 ? "more" : "less"}
                  </span>{" "}
                  often than in testing.{" "}
                  {Math.abs(drift) < 0.03
                    ? "That is within what a few hundred results can do by chance."
                    : "That is a wide enough gap to watch, though not yet to act on."}
                </p>
              )}
            </details>
          )}
        </section>
      )}

      {/* Everything in this block is drawn from event_predictions — rows
          written the morning of an event and scored afterwards. The backtest
          appears only as a dashed reference line, never as a plotted series.

          With an empty ledger these were four stacked "nothing to plot yet"
          boxes, which is honest but says the same thing four times over. One
          line says it once. */}
      {!isLoading && data?.status === "ok" && (s?.n ?? 0) === 0 && (
        <p className="mb-8 border border-dashed border-border px-5 py-4 text-sm text-muted-foreground">
          The charts — hit rate as calls settle, accuracy by confidence, and volume per day — appear
          here once the ledger has settled its first call. Nothing is drawn from replayed history to
          fill the gap.
        </p>
      )}

      {(s?.n ?? 0) > 0 && (
        <>
          <ChartCard
            title="Is it settling where it should?"
            subtitle={`The line is how often it has picked right so far, after each result. It jumps around early, when one ${unit === "games" ? "game" : "match"} moves it a lot, and should flatten out near the dashed line it was tested at.`}
          >
            {(data?.running.length ?? 0) > 0 ? (
              <AccuracyTrend
                running={data!.running}
                claim={claim?.accuracy ?? null}
                claimLabel="tested at"
                meaningfulN={data!.meaningfulN}
                baseline={chance}
              />
            ) : (
              <EmptyChart>
                Nothing has settled yet, so there is no line to draw. The first point appears once a
                recorded prediction has a result.
              </EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="When it is sure, is it right?"
            subtitle={`Every pick grouped by how sure the model was, next to how often that group actually won. If the two dots sit together, a 70% on the slate really means about 7 in 10.`}
          >
            {cal.length > 0 ? (
              <CalibrationTable rows={cal} unit={unit} verb="won" />
            ) : (
              <EmptyChart>
                This needs settled picks spread across a few confidence groups. Nothing to show yet.
              </EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="Right and wrong over time"
            subtitle={`Each bar is the ${unit} that finished that day (or week, once there is more than a month of them): the coloured part were picked right, the grey part wrong.`}
          >
            {(data?.daily.length ?? 0) > 0 ? (
              <ResultsOverTime daily={data!.daily} />
            ) : (
              <EmptyChart>Nothing has settled yet.</EmptyChart>
            )}
          </ChartCard>
        </>
      )}

      {/* The raw ledger. */}
      {(data?.recent.length ?? 0) > 0 && (
        <section className="border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-display text-2xl">The latest {data!.recent.length} picks</h2>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {s?.firstDate} → {s?.lastDate} · model {data!.modelVersion}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse font-mono text-[11px]">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                  <th className="px-5 py-3 font-normal">Date</th>
                  <th className="px-3 py-3 font-normal">{unit === "games" ? "Game" : "Match"}</th>
                  <th className="px-3 py-3 text-right font-normal">Picked</th>
                  <th className="px-3 py-3 text-right font-normal">Its chance</th>
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
                          {r.correct ? "✓ Right" : "✗ Wrong"}
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

      {/* The touchdown board keeps its own ledger, in its own table, with its
          own base rate. It is stacked below rather than merged in: averaging
          "picked the winner" with "this man scored" would produce a site-wide
          accuracy that describes neither. Football only — no other sport has a
          player board wired to the forward ledger. */}
      {(sport === "cfb" || sport === "nfl") && <TdTrackRecord sport={sport} />}
    </AppShell>
  );
}

function Row({
  label,
  claimed,
  live,
  note,
}: {
  label: string;
  claimed: string;
  live: string;
  note: string;
}) {
  return (
    <tr className="border-b border-border/60">
      <td className="px-5 py-3 font-display text-base text-foreground">{label}</td>
      <td className="px-3 py-3 text-right text-muted-foreground">{claimed}</td>
      <td className="px-3 py-3 text-right text-foreground">{live}</td>
      <td className="px-5 py-3 normal-case text-muted-foreground">{note}</td>
    </tr>
  );
}
