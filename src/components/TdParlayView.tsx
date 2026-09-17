import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { getTdParlays } from "@/lib/sports.functions";
import { todayET } from "@/lib/date";

type Result = Awaited<ReturnType<typeof getTdParlays>>;
type Parlay = Result["parlays"][number];
type Leg = Parlay["legs"][number];

const SIZES = [5, 10, 15, 20];

/** 0 means unrestricted — Infinity does not survive the wire. */
const PER_GAME: { value: number; label: string }[] = [
  { value: 1, label: "1 / game" },
  { value: 2, label: "2 / game" },
  { value: 3, label: "3 / game" },
  { value: 0, label: "any" },
];

const pct = (p: number, dp = 0) => `${(p * 100).toFixed(dp)}%`;
const price = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());

/** "1 in 1,507,887" is the number that matters most on a long slip. */
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
              {leg.team}
              {leg.position ? ` · ${leg.position}` : ""} · {leg.matchup}
            </span>
          </div>
          {/* The reasoning is read back out of the model's own coefficients, so
              it cannot drift from the number beside it. */}
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
            to score
          </div>
        </div>
        {leg.tier && (
          <div
            className={`shrink-0 border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${
              TIER_CLASS[leg.tier] ?? TIER_CLASS.Lean
            }`}
            title={
              leg.tierHit != null
                ? `${leg.tier}. Picks in this tier scored in ${pct(leg.tierHit)} of games across the held-out seasons.`
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

export function TdParlayView({ sport }: { sport: "cfb" | "nfl" }) {
  const [date, setDate] = useState(todayET());
  const [size, setSize] = useState(5);
  const [perGame, setPerGame] = useState(2);
  const run = useServerFn(getTdParlays);
  const { data, isLoading, isError } = useQuery({
    queryKey: [sport, "td-parlay", date, perGame],
    queryFn: () => run({ data: { sport, date, maxPerGame: perGame } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const parlays = data?.parlays ?? [];
  const current = parlays.find((p) => p.size === size);
  const evidence = (data?.evidence ?? {}) as Record<
    number,
    { stated: number; oneIn: number; observed: string; note?: string }
  >;
  const ev = evidence[size];
  const label = sport === "cfb" ? "College Football" : "NFL";

  return (
    <SportShell
      sport={sport}
      current="parlay"
      eyebrow={`Diamond Edge · ${label}`}
      title="Touchdown Parlays"
      blurb="Five, ten, fifteen or twenty touchdown scorers on one slip, surest first, each with the model's probability and its reasons. Stack as many legs from one game as you like — the quoted chance is corrected for it rather than assuming the legs are independent, because two opposed players in the same game score together only 0.76× as often as the plain product implies, and two on the same team 0.84×."
      date={date}
      onDateChange={setDate}
      footerNote={`Data · ESPN · ${sport === "cfb" ? "calibrated extra-trees" : "logistic model"} on season usage · Not affiliated with ${sport === "cfb" ? "college football or the NCAA" : "the NFL"}`}
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
          Failed to build the parlays. The ESPN scoreboard may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !isError && parlays.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {SIZES.map((s) => {
              const p = parlays.find((x) => x.size === s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSize(s)}
                  aria-pressed={size === s}
                  className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                    size === s
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

          {/* How much of one game a slip may take is the reader's call; the
              quoted chance is corrected for whatever they pick. */}
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Legs from one game
            </span>
            {PER_GAME.map((o) => (
              <button
                key={o.value}
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

          {/* The long slips are lottery tickets and the page says so in the
              same breath as it offers them. */}
          {current && current.legs.length > 0 && (
            <div className="mb-6 border border-border bg-card px-4 py-3">
              <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                All {current.legs.length} legs hit{" "}
                <span className="text-foreground">{oneIn(current.oneIn)}</span>
                {current.correlationFactor < 0.999 ? (
                  <>
                    {" "}
                    — the plain product says {pct(current.combinedProb, 3)}, corrected to{" "}
                    {pct(current.adjustedProb, 3)} because{" "}
                    {[
                      current.stackedPairs.opposed > 0 &&
                        `${current.stackedPairs.opposed} opposed pair${current.stackedPairs.opposed === 1 ? "" : "s"}`,
                      current.stackedPairs.sameTeam > 0 &&
                        `${current.stackedPairs.sameTeam} same-team pair${current.stackedPairs.sameTeam === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" and ")}{" "}
                    share a game (×{current.correlationFactor.toFixed(2)}).
                  </>
                ) : (
                  " — no two legs share a game, so the plain product needs no correction."
                )}
              </div>
              {current.extrapolated && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-clay">
                  {current.stackedPairs.opposed} opposed pairs is past where that correction was
                  checked — it was measured on slips carrying under one. Treat this slip's number as
                  an estimate of an estimate.
                </div>
              )}
              {ev && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Backtest at this size:{" "}
                  <span className="text-foreground">{pct(ev.stated, 2)}</span> stated ·{" "}
                  {ev.observed}
                  {ev.note ? ` · ${ev.note}` : ""}
                </div>
              )}
              {(current.doubledUp > 0 || current.belowFloor > 0 || current.short) && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-clay">
                  {current.short && `Only ${current.legs.length} legs available. `}
                  {current.doubledUp > 0 &&
                    `${current.doubledUp} game${current.doubledUp === 1 ? "" : "s"} contribute more than one leg, out of ${current.gamesAvailable} on the slate. `}
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
                A parlay needs upcoming games with picks. Pick a{" "}
                {sport === "cfb" ? "Saturday" : "Sunday"} in season.
              </p>
            </div>
          )}
        </>
      )}

      {!isLoading && !isError && parlays.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to build from</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Legs are only drawn from games that have not kicked off.
          </p>
        </div>
      )}
    </SportShell>
  );
}
