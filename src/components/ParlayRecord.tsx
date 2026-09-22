import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { Note } from "@/components/AppShell";
import { getParlayLedger } from "@/lib/tracking.functions";
import { SIZE_EVIDENCE } from "@/lib/td-parlay";

/**
 * The record of the 5/10/15/20 touchdown slips, as offered.
 *
 * THE WHOLE DESIGN PROBLEM HERE IS THAT ZERO IS THE EXPECTED ANSWER.
 *
 * A five-leg college slip is about 1 in 5. A twenty-leg one is about 1 in
 * 2,400, and the NFL twenty-leg is 1 in 74 million. Over a first season this
 * table will read 0, 0, 0, 0 down the "won" column, and every one of those
 * zeros will be exactly what the model predicted. A hit-rate column would be
 * worse than useless — it would be 0% next to a claim of 0.0014%, inviting the
 * reading that the board is broken when it is working.
 *
 * So the unit of comparison is WINS AGAINST EXPECTED WINS: the sum of the
 * stated probabilities over precisely the slips that settled. "0 won, 0.04
 * expected" is a sentence a reader can evaluate. "0%" is not.
 *
 * And because even that says almost nothing for years at the long sizes, the
 * table also carries mean legs hit. Every twenty-leg slip losing is certain;
 * whether they average 8 legs or 16 is the difference between a board worth
 * reading and one that is not, and it is visible immediately.
 */

const pct = (x: number | null | undefined, d = 2) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const oneIn = (p: number | null | undefined) =>
  p == null || p <= 0 ? "—" : `1 in ${Math.round(1 / p).toLocaleString()}`;

/** "five, ten, fifteen and twenty-leg" — written out, from whatever sizes the
 *  board actually offers, so a sport that stops at fifteen does not describe
 *  itself with a twenty-leg slip it has never built. */
const WORD: Record<number, string> = { 5: "five", 10: "ten", 15: "fifteen", 20: "twenty" };
function sizeList(sizes: number[]): string {
  const words = sizes.map((n) => WORD[n] ?? String(n));
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function ParlayRecord({ sport }: { sport: "cfb" | "nfl" | "mlb" }) {
  const run = useServerFn(getParlayLedger);
  const { data, isLoading, isError } = useQuery({
    queryKey: [sport, "parlay-ledger"],
    queryFn: () => run({ data: { sport } }),
    staleTime: 5 * 60_000,
  });

  const evidence = SIZE_EVIDENCE[sport] ?? {};
  const t = data?.totals;
  const anySettled = (t?.slips ?? 0) > 0;
  const sizes = (data?.bySize ?? []).map((r) => r.size);
  const legName = sport === "mlb" ? "hitter" : "scorer";

  return (
    <div className="mb-8 border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h3 className="font-display text-2xl">The slips themselves</h3>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Each day's {sizes.length ? sizeList(sizes) : "five, ten and fifteen"}-leg slips, frozen as
          the board offered them and scored once every leg has a result. A slip wins only if all of
          its legs do, so it is settled from the same pick ledger above — the two cannot disagree.
          {sport === "mlb" && (
            <>
              {" "}
              A slip carrying a {legName} who never came to the plate is voided rather than lost: a
              sportsbook would re-price it over the legs that stood, and this record has no way to
              say what that slip was worth.
            </>
          )}
        </p>
      </div>

      {isLoading && <div className="h-32 animate-pulse bg-card" />}

      {!isLoading && (isError || !data) && (
        <div className="px-5 py-4 font-mono text-[11px] text-muted-foreground">
          The parlay record could not be read. This is not an empty record.
        </div>
      )}

      {!isLoading && data?.status === "not-provisioned" && (
        <div className="px-5 py-4 font-mono text-[11px] text-muted-foreground">
          Slips are not being recorded. The{" "}
          <code className="text-foreground">parlay_predictions</code> table does not exist yet —
          apply{" "}
          <code className="text-foreground">
            supabase/migrations/20260920120000_parlay_predictions.sql
          </code>{" "}
          and the next daily run starts writing. A setup step, not something that resolves by
          waiting.
        </div>
      )}

      {!isLoading && data?.status === "unreadable" && (
        <div className="px-5 py-4 font-mono text-[11px] text-muted-foreground">
          The table exists but could not be read, so this is blank for a reason unrelated to the
          model.
        </div>
      )}

      {!isLoading && data?.status === "ok" && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse font-mono text-[11px]">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                  <th className="px-5 py-3 font-normal">Slip</th>
                  <th className="px-3 py-3 text-right font-normal">Backtest</th>
                  <th className="px-3 py-3 text-right font-normal">Offered</th>
                  <th className="px-3 py-3 text-right font-normal">Settled</th>
                  <th className="px-3 py-3 text-right font-normal">Won</th>
                  <th className="px-3 py-3 text-right font-normal">Expected</th>
                  <th className="px-3 py-3 text-right font-normal">Legs hit</th>
                  <th className="px-5 py-3 text-right font-normal">Backtest legs</th>
                </tr>
              </thead>
              <tbody>
                {(data.bySize ?? []).map((r) => {
                  const ev = evidence[r.size];
                  return (
                    <tr key={r.size} className="border-b border-border/60 last:border-b-0">
                      <td className="px-5 py-3 text-foreground">{r.size} legs</td>
                      <td className="px-3 py-3 text-right text-muted-foreground">
                        {ev ? oneIn(ev.stated) : "—"}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground">
                        {r.stated != null ? oneIn(r.stated) : "—"}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground">
                        {r.slips}
                        {r.pending > 0 && <span className="ml-1 opacity-60">+{r.pending}</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-foreground">{r.won}</td>
                      <td className="px-3 py-3 text-right text-muted-foreground">
                        {r.expected.toFixed(r.expected < 1 ? 3 : 1)}
                      </td>
                      <td className="px-3 py-3 text-right text-foreground">
                        {r.meanLegsHit != null && r.meanLegs != null
                          ? `${r.meanLegsHit.toFixed(1)} / ${r.meanLegs.toFixed(0)}`
                          : "—"}
                      </td>
                      {/* What the same construction averaged on held-out days.
                          At ten legs and up this is the only column with a real
                          sample in it: wins are zero by arithmetic, legs landed
                          is measured every single day. */}
                      <td className="px-5 py-3 text-right text-muted-foreground">
                        {ev?.meanLegs != null ? `${ev.meanLegs.toFixed(1)} / ${r.size}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t border-border px-5 py-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {anySettled ? (
              <>
                <span className="text-foreground">{t!.won}</span> of {t!.slips} settled slips came
                in, against <span className="text-foreground">{t!.expected.toFixed(2)}</span>{" "}
                expected from what they claimed.{" "}
                {t!.expected < 1
                  ? "Under one expected win, a zero here is arithmetic working, not a model failing — which is why this row exists instead of a hit-rate column."
                  : "Expected is the sum of the stated probabilities over exactly these slips, so it is the only fair thing to compare the win count against."}{" "}
                Mean legs hit is where the signal is long before a long slip ever lands.
              </>
            ) : (
              <>
                Nothing has settled yet
                {(t?.pending ?? 0) > 0
                  ? ` — ${t!.pending} slip${t!.pending === 1 ? " is" : "s are"} recorded and waiting on results.`
                  : ". Slips are frozen the morning of each slate and scored once every leg has a result."}{" "}
                At these odds the honest expectation for a first season is zero wins at the long
                sizes, so this table is built to be read by expected count and legs hit rather than
                by a hit rate.
              </>
            )}
          </div>
        </>
      )}

      {!isLoading && data?.status === "ok" && !data.writable && (
        <div className="border-t border-border px-5 py-3">
          <Note>
            The table is readable but this deployment has no service-role key, so nothing new is
            being written from here.
          </Note>
        </div>
      )}
    </div>
  );
}
