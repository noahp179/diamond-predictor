import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { getTwoBaseParlays } from "@/lib/sports.functions";
import { PAIR_FACTOR } from "@/lib/td-parlay";
import { todayET } from "@/lib/date";

type Result = Awaited<ReturnType<typeof getTwoBaseParlays>>;
type Parlay = Result["parlays"][number];
type Leg = Parlay["legs"][number];

const SIZES = [5, 10, 15];

/**
 * How many legs a slip may take from one game.
 *
 * The default is not a number, it is "whatever the backtest chose at this
 * size" — and those differ. Two hitters in one lineup get two bases together
 * 1.02× as often as independence implies, which is nothing, so at five and ten
 * legs the best legs wherever they are is simply the best slip. At fifteen the
 * slate runs out of hitters clearing the floor, an unrestricted slip piles nine
 * legs into one game, and the opposed pairs that come with it cost more than
 * the stronger legs are worth. Picking a number here applies it at every size.
 *
 * null means "as backtested"; 0 means unrestricted, because Infinity does not
 * survive the wire.
 */
const PER_GAME: { value: number | null; label: string }[] = [
  { value: null, label: "as backtested" },
  { value: 0, label: "any" },
  { value: 1, label: "1 / game" },
  { value: 2, label: "2 / game" },
  { value: 3, label: "3 / game" },
];

/** The cap actually in force on a slip, for the card to state. */
function capLabel(n: number): string {
  return Number.isFinite(n) ? `${n} per game` : "unrestricted";
}

const pct = (p: number, dp = 0) => `${(p * 100).toFixed(dp)}%`;
const price = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());

/** "Mon Sep 22" — enough to tell the reader which day they are looking at. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** On a fifteen-leg baseball slip this is the number that matters most. */
function oneIn(n: number): string {
  if (!n) return "—";
  return `1 in ${n.toLocaleString()}`;
}

const TIER_CLASS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

function LegRow({ leg }: { leg: Leg }) {
  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex items-start gap-3">
        <span className="w-6 shrink-0 pt-1 font-mono text-sm text-primary/70 tabular-nums">
          {leg.rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-display text-lg leading-tight">{leg.player}</span>
            <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {leg.team} · {leg.matchup}
            </span>
          </div>
          {/* The reasoning is read back out of the model's own coefficients on
              the 2+ bases board, so a leg cannot say something the projection
              beside it disagrees with. */}
          {leg.reasons.length > 0 && (
            <div className="mt-1 text-sm text-muted-foreground">{leg.reasons.join(" · ")}</div>
          )}
          {leg.against && (
            <div className="mt-0.5 font-mono text-[11px] text-clay">against: {leg.against}</div>
          )}
          {(leg.sharesGame || leg.belowFloor) && (
            <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {leg.sharesGame && "shares a game with another leg"}
              {leg.sharesGame && leg.belowFloor && " · "}
              {leg.belowFloor && "below this slip's usual bar"}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-2xl leading-none">{pct(leg.prob)}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            2+ bases
          </div>
        </div>
        {leg.tier && (
          <div
            className={`shrink-0 border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${
              TIER_CLASS[leg.tier] ?? TIER_CLASS.Lean
            }`}
            title={
              leg.tierHit != null
                ? `${leg.tier}. Hitters in this tier got two or more total bases in ${pct(leg.tierHit)} of games across the held-out season.`
                : leg.tier
            }
          >
            <div className="text-sm leading-none">
              {leg.tierHit != null ? pct(leg.tierHit) : "—"}
            </div>
            <div className="mt-0.5">{leg.tier}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Five, ten or fifteen hitters to get two or more total bases, on one slip.
 *
 * The page's job is to be honest about what it is offering. A baseball leg is
 * near a coin flip — the model's whole range is 0.18 to 0.62 — so a ten-leg
 * slip is 1 in 1,261 and a fifteen-leg slip is 1 in 53,702, and neither number
 * is softened anywhere on this page. What the backtest CAN say at those
 * lengths is how many legs landed, which is why `meanLegs` is quoted beside
 * the zero wins rather than leaving a zero to speak for itself.
 */
export function MlbBaseParlayView() {
  const [date, setDate] = useState(todayET());
  const [size, setSize] = useState(5);
  const [perGame, setPerGame] = useState<number | null>(null);
  const run = useServerFn(getTwoBaseParlays);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["mlb", "base-parlay", date, perGame],
    queryFn: () => run({ data: { date, maxPerGame: perGame ?? undefined } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const parlays = data?.parlays ?? [];
  const sizes = (data?.sizes ?? SIZES) as number[];
  const activeSize = sizes.includes(size) ? size : (sizes[0] ?? 5);
  const current = parlays.find((p) => p.size === activeSize);
  const evidence = (data?.evidence ?? {}) as Record<
    number,
    {
      stated: number;
      oneIn: number;
      observed: string;
      note?: string;
      meanLegs?: number;
      cap?: number;
    }
  >;
  const ev = evidence[activeSize];

  // Quote the correction the board is actually applying rather than a number
  // typed into this file, so the sentence cannot drift from the arithmetic.
  const pair = PAIR_FACTOR.mlb ?? { sameTeam: 1, opposed: 1 };

  // The slip may be showing a different day than the one asked for, because a
  // leg on a game already under way is not a bet anybody can place.
  const shown = data?.date;
  const movedTo = shown && shown !== date ? shown : null;

  return (
    <SportShell
      sport="mlb"
      current="parlay"
      eyebrow="Diamond Edge · MLB"
      title="Base Parlays"
      blurb={
        `Five, ten or fifteen hitters to pick up two or more total bases — a double, a ` +
        `home run, or two hits — on one slip, surest first, each with the reason the ` +
        `model likes them. Two hitters in the same lineup land together ` +
        `${pair.sameTeam.toFixed(2)}× as often as the plain product implies, which is to ` +
        `say stacking a lineup costs nothing; two on opposite sides of one game come in ` +
        `at ${pair.opposed.toFixed(2)}×, a small penalty that only matters once a slip is ` +
        `long enough to collect a lot of them. Every number below is corrected for both.`
      }
      date={date}
      onDateChange={setDate}
      footerNote="Data · MLB Stats API · Open-Meteo · L2 logistic on season form, opposing starter, park and temperature · Not affiliated with MLB"
      statBar={
        <StatBar>
          <Stat label="Slip" value={`${current?.legs.length ?? 0} legs`} />
          <Stat label="All legs hit" value={current ? oneIn(current.oneIn) : "—"} />
          <Stat label="Fair price" value={current?.legs.length ? price(current.fairPrice) : "—"} />
          <Stat label="Mean leg" value={current?.legs.length ? pct(current.meanLeg, 1) : "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-64 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to build the parlays. The MLB Stats API may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {/* Moving the reader to another day is only acceptable if the page says
          so. Silently showing tomorrow's slip under today's date would trade
          one empty board for a misleading one. */}
      {!isLoading && !isError && movedTo && (
        <Note>
          Every game on {dayLabel(date)} has already started, so there is nothing left to bet —
          showing <span className="text-foreground">{dayLabel(movedTo)}</span>. Pick a date above to
          override.
        </Note>
      )}

      {/* A slate that has partly started is a smaller slate, and the longer
          slips are the ones that notice. */}
      {!isLoading && !isError && !movedTo && (data?.startedGames ?? 0) > 0 && (
        <Note>
          {data?.startedGames} game{data?.startedGames === 1 ? " has" : "s have"} already started
          and {data?.startedGames === 1 ? "is" : "are"} left out — a leg on a hitter who has already
          batted is not a bet. The slip is built from the {data?.games} game
          {data?.games === 1 ? "" : "s"} still to come.
        </Note>
      )}

      {/* Lineup cards land about two hours before first pitch. Before that the
          batting order is last game's, and a leg can be on somebody who is not
          in tonight's nine. */}
      {!isLoading && !isError && (data?.games ?? 0) > 0 && (data?.lineupsPosted ?? 0) === 0 && (
        <Note>
          No lineup cards are posted yet for these games, so the batting orders below are each
          team's most recent one. A hitter who is rested tonight can still appear on the slip —
          check back about two hours before first pitch.
        </Note>
      )}

      {!isLoading && !isError && parlays.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {sizes.map((s) => {
              const p = parlays.find((x) => x.size === s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSize(s)}
                  aria-pressed={activeSize === s}
                  className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                    activeSize === s
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s} legs
                  <span className="ml-2 text-[10px] opacity-70">
                    {p?.legs.length ? oneIn(p.oneIn) : "—"}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-2">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Legs from one game
            </span>
            {PER_GAME.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => setPerGame(o.value)}
                aria-pressed={perGame === o.value}
                className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                  perGame === o.value
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          {current && current.legs.length > 0 && (
            <div className="mb-6 border border-border bg-card px-4 py-3">
              <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                All {current.legs.length} legs hit{" "}
                <span className="text-foreground">{oneIn(current.oneIn)}</span>
                {Math.abs(current.correlationFactor - 1) > 0.001 ? (
                  <>
                    {" "}
                    — the plain product says {pct(current.combinedProb, 3)}, corrected to{" "}
                    {pct(current.adjustedProb, 3)} because{" "}
                    {[
                      current.stackedPairs.sameTeam > 0 &&
                        `${current.stackedPairs.sameTeam} same-lineup pair${current.stackedPairs.sameTeam === 1 ? "" : "s"}`,
                      current.stackedPairs.opposed > 0 &&
                        `${current.stackedPairs.opposed} opposed pair${current.stackedPairs.opposed === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" and ")}{" "}
                    share a game (×{current.correlationFactor.toFixed(3)}).
                  </>
                ) : (
                  " — no two legs share a game, so the plain product needs no correction."
                )}
              </div>

              <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Built {capLabel(current.maxPerGame)}
                {perGame == null && ev?.cap != null
                  ? " — the construction the backtest chose at this size"
                  : ""}
                .
              </div>

              {ev && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Backtest at this size:{" "}
                  <span className="text-foreground">{pct(ev.stated, 4)}</span> stated ·{" "}
                  {ev.observed}
                  {ev.note ? ` · ${ev.note}` : ""}
                </div>
              )}

              {/* The backtest describes ONE construction. A reader who has
                  changed the cap is looking at a different slip than the one
                  those numbers were measured on, and the card has to say so
                  rather than let the evidence line stand under it. */}
              {ev?.cap != null && ev.cap !== current.maxPerGame && (
                <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-clay">
                  That backtest was run {capLabel(ev.cap)}, and this slip is built{" "}
                  {capLabel(current.maxPerGame)} — a different construction, so read the line above
                  as the nearest thing measured rather than as this slip's record.
                </div>
              )}

              {/* Multiplying a per-pair factor over pairs that heavily overlap
                  is a first-order approximation, and past a handful of opposed
                  pairs nobody has checked it. */}
              {current.extrapolated && (
                <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-clay">
                  {current.stackedPairs.opposed} opposed pairs is past where that correction was
                  measured — it multiplies a pairwise factor over pairs that overlap. Treat this
                  slip's number as an estimate of an estimate.
                </div>
              )}

              {/* On the long slips zero wins is arithmetic rather than a
                  verdict, and the legs-landed figure is the only measured
                  number the backtest has to offer at that length. */}
              {ev && ev.meanLegs != null && (
                <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-clay">
                  On a typical held-out day this slip landed{" "}
                  <span className="text-foreground">
                    {ev.meanLegs.toFixed(1)} of its {activeSize} legs
                  </span>
                  {activeSize > 5
                    ? " — it was never expected to win one outright, so read that rather than the zero."
                    : "."}
                </div>
              )}

              {(current.doubledUp > 0 || current.belowFloor > 0 || current.short) && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-clay">
                  {current.short && `Only ${current.legs.length} legs available. `}
                  {current.doubledUp > 0 &&
                    `${current.doubledUp} game${current.doubledUp === 1 ? "" : "s"} contribute more than one leg, out of ${current.gamesAvailable} still to start. `}
                  {current.belowFloor > 0 &&
                    `${current.belowFloor} leg${current.belowFloor === 1 ? "" : "s"} below this slip's usual bar of ${pct(current.floor)}.`}
                </div>
              )}
            </div>
          )}

          {current && current.legs.length > 0 ? (
            <div className="border border-border bg-card p-5">
              {current.legs.map((l) => (
                <LegRow key={l.playerId} leg={l} />
              ))}
            </div>
          ) : (
            <div className="border border-border bg-card p-10 text-center">
              <div className="font-display text-3xl">No slip to build</div>
              <p className="mt-2 font-mono text-sm text-muted-foreground">
                A parlay needs games that have not started yet. Pick a date in season.
              </p>
            </div>
          )}
        </>
      )}

      {!isLoading && !isError && parlays.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to build from</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Legs are only drawn from games that have not started.
          </p>
        </div>
      )}
    </SportShell>
  );
}
