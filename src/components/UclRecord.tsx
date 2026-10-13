import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { pickOf, scoreOutcome } from "@/lib/ledger-stats";
import { getUclRecord } from "@/lib/soccer.functions";

/**
 * The Champions League's replayed record, shown under the live ledger and never
 * merged into it: every match since 2017-18 as the model priced it that
 * morning, with what happened. Seasons up to 2025-26 are the walk-forward
 * backtest; 2026-27 is the shipped model on matches it never saw.
 */

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

export function UclRecord() {
  const run = useServerFn(getUclRecord);
  const { data, isLoading } = useQuery({
    queryKey: ["ucl", "record"],
    queryFn: () => run(),
    staleTime: 10 * 60_000,
  });
  const [shown, setShown] = useState(40);
  const rows = data?.rows ?? [];

  const scored = rows.map((r) => {
    const probs = { a: r.probs.home, draw: r.probs.draw, b: r.probs.away };
    const { pick } = pickOf(probs);
    return { ...r, pick, ok: pick === r.result, ...scoreOutcome(probs, r.result) };
  });
  const seasons = new Map<string, typeof scored>();
  for (const r of scored) {
    const y = Number(r.date.slice(0, 4));
    const s = Number(r.date.slice(5, 7)) >= 7 ? y : y - 1;
    const label = `${s}-${String((s + 1) % 100).padStart(2, "0")}`;
    seasons.set(label, [...(seasons.get(label) ?? []), r]);
  }
  const recent = [...scored].reverse().slice(0, shown);

  return (
    <section className="mt-10 border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="font-display text-2xl">Replayed record — every match since 2017-18</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Each match priced with the ratings as they stood that morning. Through 2025-26 this is the
          walk-forward backtest (the goal mapping refitted each season on earlier seasons only);
          from 2026-27 it is the shipped model on matches it never saw. It is a replay, not the
          ledger above — the two are kept apart on purpose.
        </p>
      </div>
      {isLoading && <div className="h-40 animate-pulse" />}
      {rows.length > 0 && (
        <>
          <table className="w-full font-mono text-[12px] tabular-nums">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-5 py-2 font-normal">Season</th>
                <th className="py-2 text-right font-normal">Matches</th>
                <th className="py-2 text-right font-normal">Called right</th>
                <th className="py-2 text-right font-normal">RPS</th>
                <th className="px-5 py-2 text-right font-normal">Brier</th>
              </tr>
            </thead>
            <tbody>
              {[...seasons.entries()].map(([label, rs]) => {
                const n = rs.length;
                const mean = (f: (r: (typeof rs)[number]) => number) =>
                  rs.reduce((s, r) => s + f(r), 0) / n;
                return (
                  <tr key={label} className="border-t border-border/50">
                    <td className="px-5 py-1.5">{label}</td>
                    <td className="py-1.5 text-right">{n}</td>
                    <td className="py-1.5 text-right text-foreground">
                      {pct(mean((r) => (r.ok ? 1 : 0)))}
                    </td>
                    <td className="py-1.5 text-right">{mean((r) => r.rps ?? 0).toFixed(4)}</td>
                    <td className="px-5 py-1.5 text-right">{mean((r) => r.brier).toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="border-t border-border px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Latest matches
          </div>
          <ol>
            {recent.map((r) => (
              <li
                key={r.eventId}
                className="grid grid-cols-[5.5rem_1fr_auto] items-baseline gap-3 border-t border-border/40 px-5 py-2 font-mono text-[12px] sm:grid-cols-[5.5rem_1fr_12rem_5rem_2rem]"
              >
                <span className="text-muted-foreground">{r.date}</span>
                <span className="truncate text-foreground">
                  {r.homeName} v {r.awayName}
                </span>
                <span className="hidden text-muted-foreground sm:inline">
                  {pct(r.probs.home, 0)} · {pct(r.probs.draw, 0)} · {pct(r.probs.away, 0)}
                </span>
                <span className="text-right">{r.finalScore || "—"}</span>
                <span className={`text-right ${r.ok ? "text-emerald-600" : "text-red-500"}`}>
                  {r.ok ? "✓" : "✗"}
                </span>
              </li>
            ))}
          </ol>
          {shown < scored.length && (
            <button
              type="button"
              onClick={() => setShown((s) => s + 80)}
              className="w-full border-t border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            >
              Show more ({(scored.length - shown).toLocaleString()} older)
            </button>
          )}
        </>
      )}
    </section>
  );
}
