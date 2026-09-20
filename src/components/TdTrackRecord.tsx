import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import {
  AccuracyTrend,
  BucketAccuracy,
  ChartCard,
  EmptyChart,
  VolumeChart,
} from "@/components/LedgerCharts";
import { Note } from "@/components/AppShell";
import { ParlayRecord } from "@/components/ParlayRecord";
import { getTdLedger } from "@/lib/tracking.functions";

/**
 * The touchdown-scorer record, as an analytics section on the Track Record page.
 *
 * WHY THIS IS SEPARATE FROM THE LEDGER ABOVE IT. The rest of that page reads
 * `event_predictions` — one row per game, "did the model pick the winner". This
 * reads `player_predictions` — one row per NAME on a card, "did he score". They
 * are different tables, different markets and different base rates, and the one
 * thing that must never happen is a reader averaging them into a single "site
 * accuracy". So they are stacked as two sections with their own headings and
 * their own claims, never merged into one series.
 *
 * WHY THE BUCKETS DIFFER from the game-outcome calibration chart above. A
 * game-outcome pick is by construction the side above the coin flip, so nothing
 * under 50% is ever printed and the bands start there. A touchdown pick is the
 * opposite: the lead name on a card runs about 65% and the fourth about 35%.
 * Bucketed with the game bands every call lands in "<55%" and the chart becomes
 * one bar. See PLAYER_BANDS in ledger-stats.ts.
 *
 * The compact version of this lives on the TD Scorers page, beside the board it
 * describes. This is the fuller one, for the page whose whole job is the record.
 */

/** Below this many settled picks, a hit rate is a fortnight's luck. */
const MEANINGFUL_N = 150;

const pct = (x: number | null | undefined, d = 1) =>
  x == null ? "—" : `${(x * 100).toFixed(d)}%`;
const num = (x: number | null | undefined, d = 4) => (x == null ? "—" : x.toFixed(d));

function Row({
  label,
  claimed,
  live,
  sample,
  note,
}: {
  label: string;
  claimed: string;
  live: string;
  sample: string;
  note?: string;
}) {
  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="px-5 py-3">
        {label}
        {note && <div className="mt-0.5 text-[10px] normal-case text-muted-foreground">{note}</div>}
      </td>
      <td className="px-3 py-3 text-right text-muted-foreground">{claimed}</td>
      <td className="px-3 py-3 text-right text-foreground">{live}</td>
      <td className="px-5 py-3 text-right text-muted-foreground">{sample}</td>
    </tr>
  );
}

export function TdTrackRecord({ sport }: { sport: "cfb" | "nfl" }) {
  const run = useServerFn(getTdLedger);
  const { data, isLoading, isError } = useQuery({
    queryKey: [sport, "td-ledger"],
    queryFn: () => run({ data: { sport } }),
    staleTime: 5 * 60_000,
  });

  const s = data?.summary;
  const claim = data?.claim;
  const n = s?.n ?? 0;
  const enough = n >= MEANINGFUL_N;
  const lead = data?.byRank.find((r) => r.label === "Pick 1") ?? null;

  return (
    <section className="mt-16">
      <div className="mb-4 border-t border-border pt-8">
        <h2 className="font-display text-3xl">Touchdown scorers</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          A separate ledger from the one above: that one records one call per game — did the model
          pick the winner — and this one records every <em>name</em> the touchdown board printed,
          scored from the box score afterwards. Different markets with different base rates, so they
          are never averaged into a single figure for the site.
        </p>
      </div>

      {isLoading && <div className="h-40 animate-pulse border border-border bg-card" />}

      {!isLoading && (isError || !data) && (
        <Note>
          <strong className="text-foreground">The touchdown record could not be read.</strong> This
          is not an empty record — the picks may well be there and the request for them did not
          return.
        </Note>
      )}

      {!isLoading && data?.status === "not-provisioned" && (
        <Note>
          <strong className="text-foreground">Touchdown picks are not being recorded.</strong> The{" "}
          <code className="font-mono text-[11px]">player_predictions</code> table does not exist, so
          nothing has ever been stored and nothing will be until{" "}
          <code className="font-mono text-[11px]">supabase/SETUP.sql</code> is applied. A setup step,
          not something that resolves by waiting.
        </Note>
      )}

      {!isLoading && data?.status === "unreadable" && (
        <Note>
          <strong className="text-foreground">The touchdown record could not be read.</strong> The
          table exists but the request failed, so this section is blank for a reason that has nothing
          to do with the model.
        </Note>
      )}

      {!isLoading && data?.status === "ok" && n === 0 && (
        <Note>
          <strong className="text-foreground">Nothing settled yet.</strong> Picks are written the
          morning of each game and scored once it finishes.
          {(s?.pending ?? 0) > 0 ? (
            <>
              {" "}
              {s!.pending} {s!.pending === 1 ? "pick is" : "picks are"} recorded and waiting on
              results.
            </>
          ) : (
            <> Nothing has been recorded yet — the first run happens on the next daily cycle.</>
          )}
        </Note>
      )}

      {!isLoading && n > 0 && !enough && (
        <Note>
          <strong className="text-foreground">Too early to read anything into this.</strong> {n}{" "}
          settled {n === 1 ? "pick" : "picks"} is short of the {MEANINGFUL_N} it takes for a hit rate
          to separate a good model from a good fortnight. Shown because hiding it would be worse.
        </Note>
      )}

      {/* Claimed against actual, three ways, because the board makes three
          different claims and collapsing them hides the one that matters. */}
      {claim && (
        <div className="mb-8 border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h3 className="font-display text-2xl">Claimed against actual</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Left: the held-out backtest ({claim.source}). Right: what has actually been recorded.
              Never averaged.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse font-mono text-[11px]">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                  <th className="px-5 py-3 font-normal">Metric</th>
                  <th className="px-3 py-3 text-right font-normal">Backtest</th>
                  <th className="px-3 py-3 text-right font-normal">Live ledger</th>
                  <th className="px-5 py-3 text-right font-normal">Settled</th>
                </tr>
              </thead>
              <tbody>
                <Row
                  label="Lead pick scored"
                  note="the name the card leads with"
                  claimed={pct(claim.leadHit)}
                  live={enough ? pct(lead?.hitRate) : "—"}
                  sample={lead ? String(lead.n) : "0"}
                />
                <Row
                  label="Any shown pick scored"
                  note="every name on the card, lead and tail together"
                  claimed={pct(claim.anyHit)}
                  live={enough ? pct(s?.hitRate) : "—"}
                  sample={String(n)}
                />
                <Row
                  label="Games with a hit"
                  note="at least one of the card's names scored"
                  claimed={pct(claim.gameHit)}
                  live={enough ? pct(s?.gameHitRate) : "—"}
                  sample={String(s?.games ?? 0)}
                />
                <Row
                  label="Brier"
                  claimed="—"
                  live={enough ? num(s?.brier) : "—"}
                  sample=""
                  note="lower is better; the backtest did not publish one per pick"
                />
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* The slips are a different unit from the picks above — a slip is right
          only if every leg is — so they get their own table rather than a
          column in that one. */}
      <ParlayRecord sport={sport} />

      {n === 0 && data?.status === "ok" && (
        <p className="mb-8 border border-dashed border-border px-5 py-4 text-sm text-muted-foreground">
          The charts — hit rate as picks settle, hit rate by stated probability, and volume per game
          day — appear once the ledger has settled its first pick. Nothing is drawn from replayed
          history to fill the gap.
        </p>
      )}

      {n > 0 && (
        <>
          <ChartCard
            title="Are the picked players scoring?"
            subtitle="The live hit rate across every shown pick as they settle, against the rate the backtest claimed for the same cut of the board. Early points swing hard because the denominator is tiny."
            footer="Cumulative, not per-day. One Saturday or Sunday is far too small a sample to read on its own."
          >
            {(data?.running.length ?? 0) > 0 ? (
              <AccuracyTrend
                running={data!.running}
                claim={claim?.anyHit ?? null}
                meaningfulN={MEANINGFUL_N}
                seriesName="live hit rate, all shown picks"
              />
            ) : (
              <EmptyChart>
                Nothing has settled yet, so there is no line to draw.
              </EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="Is a 60% pick a 60% pick?"
            subtitle="Every settled pick bucketed by the probability printed next to it, against how often that bucket actually scored. The bands run lower than the game-outcome chart above because a touchdown pick is not the favoured side of anything — the lead name on a card is around 65% and the fourth around 35%."
            footer="Taller actual than stated means the board was under-confident in that bucket; shorter means over-confident, which is the expensive direction. A bucket holding a handful of picks will disagree wildly however good the model is."
          >
            {(data?.calibration.length ?? 0) > 0 ? (
              <BucketAccuracy calibration={data!.calibration} />
            ) : (
              <EmptyChart>
                Calibration needs settled picks spread across probability bands. Nothing to plot
                yet.
              </EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="How fast is this filling up?"
            subtitle="Picks settled per game day, with that day's hit rate riding on top. The bars are the honest context for every other number in this section."
            footer="A single slate is almost never a meaningful sample, which is why the daily rate is drawn thin and the volume solid."
          >
            {(data?.daily.length ?? 0) > 0 ? (
              <VolumeChart daily={data!.daily} barName="picks settled" />
            ) : (
              <EmptyChart>Nothing has settled yet.</EmptyChart>
            )}
          </ChartCard>

          {/* Rank is the board's own ordering, so this is the check that the
              order means something: pick 1 should beat pick 2 should beat pick 3.
              If it does not, the ranking is decoration. */}
          {(data?.byRank.length ?? 0) > 0 && (
            <div className="mb-8 border border-border bg-card">
              <div className="border-b border-border px-5 py-4">
                <h3 className="font-display text-2xl">Does the order mean anything?</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  The board ranks the names it prints. If pick 1 does not beat pick 2, the ranking is
                  decoration — this is the check.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] border-collapse font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                      <th className="px-5 py-3 font-normal">Pick</th>
                      <th className="px-3 py-3 text-right font-normal">Scored</th>
                      <th className="px-3 py-3 text-right font-normal">Settled</th>
                      <th className="px-5 py-3 text-right font-normal">Hit rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.byRank.map((r) => (
                      <tr key={r.label} className="border-b border-border/60 last:border-b-0">
                        <td className="px-5 py-3">{r.label}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{r.hits}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{r.n}</td>
                        <td className="px-5 py-3 text-right text-foreground">{pct(r.hitRate, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!enough && (
                <div className="border-t border-border px-5 py-4 font-mono text-[11px] text-muted-foreground">
                  With {n} settled the ordering here is not yet evidence of anything — it is shown so
                  it can be watched, not concluded from.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
