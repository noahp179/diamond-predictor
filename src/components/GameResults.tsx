import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { Result } from "@/components/BoardRecord";
import { getSimResults } from "@/lib/sim-props.functions";
import type { ResultGame } from "@/lib/sim-props.server";
import type { SimPropsLeague } from "@/lib/sim-props-shared";

/**
 * Game by game — every tracked game that has finished, with what happened
 * next to what the board said before it: the box score's touchdown / goal
 * scorers (NBA: top scorers) and the chance the board had given each, then
 * every recorded pick with its real number. Each game links to ESPN's box
 * score so any line can be checked by hand.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;
const day = (iso: string | null) =>
  iso
    ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : "";
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

export function GameResults({ league }: { league: SimPropsLeague }) {
  const [pages, setPages] = useState(1);
  return (
    <div>
      {Array.from({ length: pages }, (_, i) => (
        <Page
          key={i}
          league={league}
          offset={i * 8}
          last={i === pages - 1}
          onMore={() => setPages(pages + 1)}
        />
      ))}
    </div>
  );
}

function Page({
  league,
  offset,
  last,
  onMore,
}: {
  league: SimPropsLeague;
  offset: number;
  last: boolean;
  onMore: () => void;
}) {
  const load = useServerFn(getSimResults);
  const { data, isLoading } = useQuery({
    queryKey: ["sim-results", league, offset],
    queryFn: () => load({ data: { league, offset } }),
    staleTime: 5 * 60_000,
  });
  if (isLoading) return <div className="h-24 animate-pulse bg-secondary/40" />;
  if (!data?.games.length)
    return offset === 0 ? (
      <p className="px-5 py-5 text-sm text-muted-foreground sm:px-6">
        {data?.note ?? "No tracked game has finished yet."}
      </p>
    ) : null;
  return (
    <>
      <ol>
        {data.games.map((g) => (
          <GameRow key={g.eventId} g={g} nba={league === "nba"} />
        ))}
      </ol>
      {last && data.more && (
        <div className="border-t border-border px-5 py-3 sm:px-6">
          <button
            type="button"
            onClick={onMore}
            className="border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            Earlier games
          </button>
        </div>
      )}
    </>
  );
}

function GameRow({ g, nba }: { g: ResultGame; nba: boolean }) {
  const [open, setOpen] = useState(false);
  const pending = g.picks.filter((p) => p.result === "pending").length;
  return (
    <li className="border-t border-border first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="grid w-full grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-secondary/30 sm:grid-cols-[7rem_1fr_auto] sm:px-6"
      >
        <span className="font-mono text-[11px] text-muted-foreground">{day(g.date)}</span>
        <span className="min-w-0">
          <span className="text-foreground">
            {open ? "▾ " : "▸ "}
            {g.score || g.matchup}
          </span>
        </span>
        <span className="col-span-2 font-mono text-[11px] text-muted-foreground sm:col-span-1 sm:text-right">
          {g.graded
            ? `${g.hits} of ${g.graded} picks came in`
            : g.picks.length
              ? `${g.picks.length} picks`
              : "no picks recorded"}
          {pending ? ` · ${pending} pending` : ""}
        </span>
      </button>
      {open && (
        <div className="space-y-5 border-t border-border/50 bg-background/40 px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {g.simulated
                ? "Simulated before the game — every player's chance below is the board's own number from that morning."
                : "Not simulated — only the players the earlier board picked have a number."}
            </span>
            <a
              href={g.boxUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono uppercase tracking-widest text-primary hover:underline"
            >
              Box score ↗
            </a>
          </div>

          <div>
            <h4 className="mb-2 font-display text-lg">{g.stars.title}</h4>
            {g.stars.rows.length ? (
              <table className="w-full border-collapse font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                    <th className="py-1.5 pr-3 font-normal">Player</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{g.stars.noun}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">
                      {nba ? "Projected" : "Board's chance"}
                    </th>
                    {!nba && <th className="py-1.5 pr-3 text-right font-normal">Ranked</th>}
                    <th className="py-1.5 text-right font-normal">Picked</th>
                  </tr>
                </thead>
                <tbody>
                  {g.stars.rows.map((s) => (
                    <tr key={`${s.player}-${s.team}`} className="border-b border-border/40">
                      <td className="py-1.5 pr-3 normal-case text-foreground">
                        {s.player} <span className="text-muted-foreground">{s.team}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.value}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {s.proj != null ? s.proj.toFixed(1) : s.prob != null ? pct(s.prob) : "—"}
                      </td>
                      {!nba && (
                        <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                          {s.rank && s.of ? `${ordinal(s.rank)} of ${s.of}` : "—"}
                        </td>
                      )}
                      <td className="py-1.5 text-right">{s.picked ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-muted-foreground">Nobody — a shutout.</p>
            )}
          </div>

          <div>
            <h4 className="mb-2 font-display text-lg">Every pick recorded before the game</h4>
            {g.picks.length ? (
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full min-w-[620px] border-collapse font-mono text-[11px]">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                      <th className="py-1.5 pr-3 font-normal">Bet</th>
                      <th className="py-1.5 pr-3 font-normal">Player</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Said</th>
                      <th className="py-1.5 pr-3 font-normal">What happened</th>
                      <th className="py-1.5 text-right font-normal">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.picks.map((p, i) => (
                      <tr key={i} className="border-b border-border/40">
                        <td className="py-1.5 pr-3 normal-case">
                          {p.market}
                          {p.model !== "Simulation" && (
                            <span className="block text-[9px] uppercase tracking-widest text-muted-foreground">
                              {p.model}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 normal-case text-foreground">
                          {p.player} <span className="text-muted-foreground">{p.team}</span>
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{pct(p.prob)}</td>
                        <td className="py-1.5 pr-3 normal-case text-muted-foreground">
                          {p.actual}
                        </td>
                        <td className="py-1.5 text-right">
                          <Result r={p.result} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No picks were recorded for this game.</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
