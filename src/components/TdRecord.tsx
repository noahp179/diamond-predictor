import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { getTdLedger } from "@/lib/tracking.functions";

/**
 * The live touchdown record — did the players we picked actually score?
 *
 * Shown next to what the backtest claimed, never instead of it. The two are
 * different kinds of number: a backtest can be re-run until it looks good, a
 * row written before kickoff cannot. Putting them side by side is the only
 * presentation that does not quietly pass one off as the other, and below a
 * few hundred settled picks the page says so rather than implying a difference
 * of a few points means anything.
 */
const MEANINGFUL_N = 150;

const pct = (p: number | null | undefined) => (p == null ? "—" : `${Math.round(p * 100)}%`);

export function TdRecord({ sport }: { sport: "cfb" | "nfl" }) {
  const run = useServerFn(getTdLedger);
  const { data, isLoading } = useQuery({
    queryKey: [sport, "td-ledger"],
    queryFn: () => run({ data: { sport } }),
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <div className="mt-10 h-40 animate-pulse border border-border bg-card" />;
  if (!data) return null;

  const s = data.summary;
  const thin = s.n < MEANINGFUL_N;

  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-display text-3xl">Did they score?</h2>
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Picks recorded before kickoff, settled from the box score
        </span>
      </div>

      {data.status === "not-provisioned" ? (
        <div className="border border-border bg-card p-6 font-mono text-sm text-muted-foreground">
          The ledger table does not exist yet, so nothing is being recorded — this is not an empty
          record, it is no record. Apply <span className="text-foreground">supabase/SETUP.sql</span>{" "}
          and the next daily run starts writing.
        </div>
      ) : s.n === 0 ? (
        <div className="border border-border bg-card p-6 font-mono text-sm text-muted-foreground">
          Nothing settled yet.{" "}
          {s.pending > 0
            ? `${s.pending} pick${s.pending === 1 ? "" : "s"} recorded and waiting on results.`
            : "Picks are written the morning of each slate and scored once the games finish."}{" "}
          The backtest claimed {pct(data.claim.anyHit)} of picks score — this section will say
          whether that holds up, however it turns out.
        </div>
      ) : (
        <>
          <div className="grid gap-px border border-border bg-border sm:grid-cols-4">
            <Cell
              label="Picks settled"
              value={`${s.n}`}
              sub={s.pending ? `${s.pending} pending` : undefined}
            />
            <Cell
              label="Scored"
              value={pct(s.hitRate)}
              sub={`${s.hits} of ${s.n} · backtest said ${pct(data.claim.anyHit)}`}
              accent
            />
            <Cell
              label="Games with a hit"
              value={pct(s.gameHitRate)}
              sub={`${s.gamesWithHit} of ${s.games}`}
            />
            <Cell
              label="Brier"
              value={s.brier != null ? s.brier.toFixed(3) : "—"}
              sub="lower is better"
            />
          </div>

          {thin && (
            <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {s.n} settled picks is too few to separate a good model from a lucky one — treat this
              as a running total, not a verdict, until it passes {MEANINGFUL_N}.
            </p>
          )}

          {(data.byRank.length > 0 || data.byTier.length > 0) && (
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              {data.byRank.length > 0 && (
                <Breakdown
                  title="By pick"
                  caption={`The lead pick is the one the card leads with. Backtest: ${pct(data.claim.leadHit)}.`}
                  rows={data.byRank}
                />
              )}
              {data.byTier.length > 0 && (
                <Breakdown
                  title="By tier"
                  caption="Whether the tiers separate live the way they did in the backtest."
                  rows={data.byTier}
                />
              )}
            </div>
          )}

          {data.recent.length > 0 && (
            <div className="mt-8">
              <div className="mb-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Most recent picks
                {s.firstDate ? ` · recording since ${s.firstDate}` : ""}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse font-mono text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-normal">Date</th>
                      <th className="py-2 pr-3 font-normal">Player</th>
                      <th className="py-2 pr-3 font-normal">Game</th>
                      <th className="py-2 pr-3 text-right font-normal">Said</th>
                      <th className="py-2 text-right font-normal">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.slice(0, 25).map((r, i) => (
                      <tr key={`${r.date}-${r.player}-${i}`} className="border-b border-border/50">
                        <td className="py-2 pr-3 text-muted-foreground">{r.date}</td>
                        <td className="py-2 pr-3 text-foreground">
                          {r.player}
                          <span className="text-muted-foreground">
                            {" "}
                            {r.team}
                            {r.rank > 1 ? ` · #${r.rank}` : ""}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{r.matchup}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{pct(r.prob)}</td>
                        <td className="py-2 text-right">
                          {r.scored == null ? (
                            <span className="text-muted-foreground">pending</span>
                          ) : r.scored ? (
                            <span className="text-grass">✓ {r.touchdowns ?? 1} TD</span>
                          ) : (
                            <span className="text-clay">✗ none</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Cell({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-card px-4 py-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 font-display text-3xl ${accent ? "text-primary" : "text-foreground"}`}>
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Breakdown({
  title,
  caption,
  rows,
}: {
  title: string;
  caption: string;
  rows: { label: string; n: number; hits: number; hitRate: number | null }[];
}) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="font-mono text-[11px] uppercase tracking-widest text-foreground">{title}</div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{caption}</div>
      <div className="mt-3">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between border-t border-border/60 py-2 font-mono text-xs"
          >
            <span className="text-foreground">{r.label}</span>
            <span className="text-muted-foreground">
              <span className="text-foreground tabular-nums">{pct(r.hitRate)}</span> · {r.hits}/
              {r.n}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
