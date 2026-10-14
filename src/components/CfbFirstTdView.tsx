import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { SportShell, Stat, StatBar } from "@/components/SportShell";
import { todayET } from "@/lib/date";
import backtest from "@/lib/sim-props-backtest.json";
import { getCfbTdScorers } from "@/lib/sports.functions";

/**
 * College football: who scores the first touchdown.
 *
 * Built on the touchdown model the TD Scorers board already runs: each
 * player's chance of an anytime touchdown is turned into a touchdown rate,
 * and the game's first touchdown is shared out in proportion (less the ~3%
 * that defences and kick returns score). On the 2025-26 seasons this beat the
 * game simulator for the first touchdown; the numbers are below the list.
 */

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

type Bt = {
  season: string;
  n: number;
  games: number;
  chosen: string;
  methods: Record<string, { brier: number; auc: number; top_hit: number; top_said: number }>;
};

export function CfbFirstTdView() {
  const [date, setDate] = useState(todayET());
  const load = useServerFn(getCfbTdScorers);
  const { data, isLoading } = useQuery({
    queryKey: ["cfb-first-td", date],
    queryFn: () => load({ data: { date } }),
    staleTime: 5 * 60_000,
  });
  const games = useMemo(() => data?.games ?? [], [data]);
  const ranked = useMemo(
    () =>
      games
        .flatMap((g) =>
          (g.firstTd ?? []).map((p) => ({ ...p, matchup: g.matchup, started: g.started })),
        )
        .sort((a, b) => b.prob - a.prob),
    [games],
  );
  const bt = (backtest as unknown as Record<string, Record<string, Bt>>).cfb?.first;

  return (
    <SportShell
      sport="cfb"
      current="props"
      eyebrow="Diamond Edge · College football First TD"
      title="First TD: who's most likely"
      blurb="Who scores each game's first touchdown. Every player's chance of scoring at all comes from the touchdown model; the first one is shared out between them in proportion to how often each scores — a back who scores in half his games gets a bigger slice than a receiver who scores in a fifth of his."
      date={date}
      onDateChange={setDate}
      statBar={
        <StatBar>
          <Stat label="Games" value={`${games.length}`} />
          <Stat
            label="Most likely"
            value={
              ranked[0] ? `${ranked[0].player.split(" ").slice(-1)[0]} ${pct(ranked[0].prob)}` : "—"
            }
          />
          <Stat
            label="Typical top pick"
            value={bt ? pct(bt.methods[bt.chosen]?.top_hit ?? 0) : "—"}
          />
          <Stat label="Tested games" value={bt ? bt.games.toLocaleString() : "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {!isLoading && games.length === 0 && (
        <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
          {data?.note ?? `No college games on ${date}.`}
        </div>
      )}
      {games.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {games.map((g) => (
            <section key={g.gameId} className="border border-border bg-card">
              <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
                <span className="font-mono text-xs uppercase tracking-widest">{g.matchup}</span>
                {g.started && (
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    under way
                  </span>
                )}
              </div>
              <ol>
                {(g.firstTd ?? []).map((p, i) => (
                  <li
                    key={p.playerId}
                    className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 border-t border-border/50 px-5 py-2 first:border-t-0"
                  >
                    <span className="font-mono text-xs text-primary/70">{i + 1}</span>
                    <span className="min-w-0 truncate">
                      {p.player}{" "}
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {p.team} · {p.position}
                      </span>
                    </span>
                    <span className="font-display text-xl">{pct(p.prob)}</span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      <section className="mt-10 border border-border bg-card px-5 py-5 text-sm text-muted-foreground sm:px-6">
        <h2 className="font-display text-2xl text-foreground">How it works — and how it did</h2>
        <p className="mt-3">
          A player who scores in a fraction <em>p</em> of his games scores at a rate of −ln(1−
          <em>p</em>) touchdowns a game. Add those rates up for everyone in the game; each player's
          slice of the first touchdown is his rate over the total, times 97% (the other 3% go to
          defences and kick returns).
        </p>
        {bt && (
          <p className="mt-3">
            Tested on {bt.games.toLocaleString()} games of {bt.season} it never saw, the top pick in
            each game scored the first touchdown{" "}
            <strong className="text-foreground">{pct(bt.methods[bt.chosen].top_hit, 1)}</strong> of
            the time (it said {pct(bt.methods[bt.chosen].top_said, 1)}). The game simulator, tried
            on the same games, managed {pct(bt.methods.sim?.top_hit ?? 0, 1)} — so this board uses
            the model.
          </p>
        )}
      </section>
    </SportShell>
  );
}
